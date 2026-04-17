#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAgentPrompt,
  extractPatchFromText,
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

export async function execute(params: WorkerExecuteParams): Promise<WorkerExecuteResult> {
  const host = process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const model = process.env.CASEGRAPH_LOCAL_LLM_MODEL ?? DEFAULT_MODEL;
  const prompt = buildAgentPrompt(params);
  const timeoutSeconds =
    params.execution_policy.timeout_seconds > 0
      ? params.execution_policy.timeout_seconds
      : DEFAULT_TIMEOUT_SECONDS;

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

  const logPath = path.join(
    process.cwd(),
    ".casegraph",
    "cases",
    params.case.case_id,
    "worker-logs",
    `${params.execution_policy.command_id}.log`
  );
  await writeLog(logPath, host, model, httpStatus, unreachableError, responseText);

  const relativeLogPath = path.relative(process.cwd(), logPath);
  const artifact: WorkerArtifact = {
    kind: "log",
    path: relativeLogPath,
    description: "Local LLM response",
    metadata: {
      host,
      model,
      http_status: httpStatus,
      unreachable: unreachableError !== null
    }
  };

  if (unreachableError) {
    return {
      status: "failed",
      summary: `Local LLM unreachable at ${host}`,
      artifacts: [artifact],
      observations: [unreachableError],
      warnings: []
    };
  }
  if (httpStatus !== null && httpStatus >= 400) {
    return {
      status: "failed",
      summary: `Local LLM returned HTTP ${httpStatus}`,
      artifacts: [artifact],
      observations: [responseText],
      warnings: []
    };
  }

  const extraction = extractPatchFromText(responseText, params.case.case_id);
  const observations: string[] = [];
  if (!extraction.ok) {
    observations.push(`Patch rejected (${extraction.reason.code}): ${extraction.reason.message}`);
  }

  return {
    status: extraction.ok ? "succeeded" : "failed",
    summary: extraction.ok
      ? `Local LLM produced a GraphPatch for ${params.task.node_id}`
      : `Local LLM did not produce a GraphPatch for ${params.task.node_id}`,
    artifacts: [artifact],
    observations,
    ...(extraction.ok ? { patch: extraction.patch } : {}),
    warnings: []
  };
}

async function writeLog(
  logPath: string,
  host: string,
  model: string,
  httpStatus: number | null,
  unreachableError: string | null,
  responseText: string
): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const header = [
    "# casegraph-worker-local-llm log",
    `host: ${host}`,
    `model: ${model}`,
    `http_status: ${httpStatus ?? ""}`,
    `unreachable: ${unreachableError ?? ""}`,
    ""
  ].join("\n");
  const body = ["### response", responseText, ""].join("\n");
  await writeFile(logPath, `${header}\n${body}`, "utf8");
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
