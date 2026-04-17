#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAgentPrompt,
  buildRetryPrompt,
  extractPatchFromText,
  type PatchExtractionResult,
  type WorkerArtifact,
  type WorkerExecuteParams,
  type WorkerExecuteResult
} from "@casegraph/core";
import { isRecord, runPluginStdioServer } from "@casegraph/core/plugin-server";

const WORKER_NAME = "local-llm";
const WORKER_VERSION = "0.1.0";
const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.1:8b";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_RETRIES = 1;

const WORKER_CAPABILITIES = {
  effectful: false,
  needs_approval: false,
  shell_access: false,
  network_access: true,
  read_files: false,
  write_files: false
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPluginStdioServer({
    info: {
      name: `casegraph-worker-${WORKER_NAME}`,
      version: WORKER_VERSION,
      capabilities: WORKER_CAPABILITIES,
      methods: ["worker.execute"],
      extra: { worker: WORKER_CAPABILITIES }
    },
    handlers: {
      "worker.execute": (params) => execute(assertExecuteParams(params))
    }
  });
}

interface LlmAttempt {
  prompt: string;
  responseText: string;
  httpStatus: number | null;
  unreachableError: string | null;
  extraction: PatchExtractionResult;
}

async function callOllama(
  host: string,
  model: string,
  prompt: string,
  timeoutSeconds: number,
  caseId: string
): Promise<LlmAttempt> {
  let responseText = "";
  let unreachableError: string | null = null;
  let httpStatus: number | null = null;
  try {
    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000)
    });
    httpStatus = response.status;
    if (!response.ok) {
      responseText = await response.text();
    } else {
      const body = (await response.json()) as { response?: unknown };
      responseText = typeof body.response === "string" ? body.response : "";
    }
  } catch (error) {
    unreachableError = error instanceof Error ? error.message : String(error);
  }
  return {
    prompt,
    responseText,
    httpStatus,
    unreachableError,
    extraction: extractPatchFromText(responseText, caseId)
  };
}

export async function execute(params: WorkerExecuteParams): Promise<WorkerExecuteResult> {
  const host = process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const model = process.env.CASEGRAPH_LOCAL_LLM_MODEL ?? DEFAULT_MODEL;
  const originalPrompt = buildAgentPrompt(params);
  const timeoutSeconds =
    params.execution_policy.timeout_seconds > 0
      ? params.execution_policy.timeout_seconds
      : DEFAULT_TIMEOUT_SECONDS;

  const observations: string[] = [];
  const attempts: LlmAttempt[] = [];
  let currentPrompt = originalPrompt;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const run = await callOllama(host, model, currentPrompt, timeoutSeconds, params.case.case_id);
    attempts.push(run);
    if (run.unreachableError || (run.httpStatus !== null && run.httpStatus >= 400)) {
      break;
    }
    if (run.extraction.ok) {
      break;
    }
    if (attempt < MAX_RETRIES) {
      observations.push(
        `Retry ${attempt + 1} after (${run.extraction.reason.code}): ${run.extraction.reason.message}`
      );
      currentPrompt = buildRetryPrompt({
        originalPrompt,
        previousResponse: run.responseText,
        reason: run.extraction.reason
      });
    } else {
      observations.push(
        `Patch rejected (${run.extraction.reason.code}): ${run.extraction.reason.message}`
      );
    }
  }

  const logPath = path.join(
    process.cwd(),
    ".casegraph",
    "cases",
    params.case.case_id,
    "worker-logs",
    `${params.execution_policy.command_id}.log`
  );
  await writeLog(logPath, host, model, attempts);

  const relativeLogPath = path.relative(process.cwd(), logPath);
  // biome-ignore lint/style/noNonNullAssertion: loop always runs at least once
  const final = attempts.at(-1)!;
  const artifact: WorkerArtifact = {
    kind: "log",
    path: relativeLogPath,
    description: "Local LLM response",
    metadata: {
      host,
      model,
      attempts: attempts.length,
      http_status: final.httpStatus,
      unreachable: final.unreachableError !== null
    }
  };

  if (final.unreachableError) {
    return {
      status: "failed",
      summary: `Local LLM unreachable at ${host}`,
      artifacts: [artifact],
      observations: [final.unreachableError],
      warnings: []
    };
  }
  if (final.httpStatus !== null && final.httpStatus >= 400) {
    return {
      status: "failed",
      summary: `Local LLM returned HTTP ${final.httpStatus}`,
      artifacts: [artifact],
      observations: [final.responseText],
      warnings: []
    };
  }

  return {
    status: final.extraction.ok ? "succeeded" : "failed",
    summary: final.extraction.ok
      ? `Local LLM produced a GraphPatch for ${params.task.node_id}`
      : `Local LLM did not produce a GraphPatch for ${params.task.node_id}`,
    artifacts: [artifact],
    observations,
    ...(final.extraction.ok ? { patch: final.extraction.patch } : {}),
    warnings: []
  };
}

async function writeLog(
  logPath: string,
  host: string,
  model: string,
  attempts: LlmAttempt[]
): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const sections: string[] = [
    "# casegraph-worker-local-llm log",
    `host: ${host}`,
    `model: ${model}`,
    `attempts: ${attempts.length}`,
    ""
  ];
  attempts.forEach((attempt, index) => {
    sections.push(
      `## attempt ${index + 1}`,
      `http_status: ${attempt.httpStatus ?? ""}`,
      `unreachable: ${attempt.unreachableError ?? ""}`,
      `extraction_ok: ${attempt.extraction.ok}`,
      ...(attempt.extraction.ok
        ? []
        : [`rejection: ${attempt.extraction.reason.code}: ${attempt.extraction.reason.message}`]),
      "",
      "### response",
      attempt.responseText,
      ""
    );
  });
  await writeFile(logPath, sections.join("\n"), "utf8");
}

function assertExecuteParams(input: unknown): WorkerExecuteParams {
  if (
    !(
      isRecord(input) &&
      isRecord(input.case) &&
      isRecord(input.task) &&
      isRecord(input.context) &&
      isRecord(input.execution_policy) &&
      typeof input.case.case_id === "string" &&
      typeof input.task.node_id === "string" &&
      typeof input.execution_policy.command_id === "string"
    )
  ) {
    throw new Error("Invalid worker.execute params");
  }
  return input as unknown as WorkerExecuteParams;
}
