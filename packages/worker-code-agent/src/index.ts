#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertWorkerExecuteParams,
  runPluginStdioServer,
  runWorkerChild,
  type WorkerChildRunResult,
  workerLogPath
} from "@caphtech/casegraph-core/plugin-server";
import {
  buildAgentPrompt,
  buildRetryPrompt,
  extractPatchFromText,
  type PatchExtractionResult,
  type WorkerArtifact,
  type WorkerExecuteParams,
  type WorkerExecuteResult
} from "@caphtech/casegraph-kernel";

const WORKER_NAME = "code-agent";
const WORKER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_COMMAND = ["claude", "--print"];
const MAX_RETRIES = 1;

const WORKER_CAPABILITIES = {
  effectful: true,
  needs_approval: true,
  shell_access: true,
  network_access: true,
  read_files: true,
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
      "worker.execute": (params) => execute(assertWorkerExecuteParams(params))
    }
  });
}

export async function execute(params: WorkerExecuteParams): Promise<WorkerExecuteResult> {
  const command = resolveCommand();
  const originalPrompt = buildAgentPrompt(params);
  const timeoutSeconds =
    params.execution_policy.timeout_seconds > 0
      ? params.execution_policy.timeout_seconds
      : DEFAULT_TIMEOUT_SECONDS;

  const observations: string[] = [];
  const attempts: AttemptRecord[] = [];
  let extraction: PatchExtractionResult;
  let runResult: WorkerChildRunResult;
  let currentPrompt = originalPrompt;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    runResult = await runWorkerChild({
      command,
      timeoutSeconds,
      stdin: currentPrompt
    });
    extraction = extractPatchFromText(runResult.stdout, params.case.case_id);
    attempts.push({ prompt: currentPrompt, run: runResult, extraction });
    if (runResult.timedOut) {
      observations.push(`Command exceeded ${timeoutSeconds}s timeout and was terminated.`);
      break;
    }
    if (extraction.ok) {
      break;
    }
    if (attempt < MAX_RETRIES) {
      observations.push(
        `Retry ${attempt + 1} after (${extraction.reason.code}): ${extraction.reason.message}`
      );
      currentPrompt = buildRetryPrompt({
        originalPrompt,
        previousResponse: runResult.stdout,
        reason: extraction.reason
      });
    } else {
      observations.push(`Patch rejected (${extraction.reason.code}): ${extraction.reason.message}`);
    }
  }

  const logPath = workerLogPath(params.case.case_id, params.execution_policy.command_id);
  await writeLog(logPath, command, attempts);

  const relativeLogPath = path.relative(process.cwd(), logPath);
  // biome-ignore lint/style/noNonNullAssertion: the for-loop runs at least once
  const finalRun = runResult!;
  // biome-ignore lint/style/noNonNullAssertion: the for-loop runs at least once
  const finalExtraction = extraction!;
  const artifact: WorkerArtifact = {
    kind: "log",
    path: relativeLogPath,
    description: "Code agent stdout/stderr",
    metadata: {
      command: command.join(" "),
      attempts: attempts.length,
      exit_code: finalRun.exitCode,
      timed_out: finalRun.timedOut,
      signal: finalRun.signal
    }
  };

  return {
    status: finalExtraction.ok ? "succeeded" : "failed",
    summary: finalExtraction.ok
      ? `Code agent produced a GraphPatch for ${params.task.node_id}`
      : `Code agent did not produce a GraphPatch for ${params.task.node_id}`,
    artifacts: [artifact],
    observations,
    ...(finalExtraction.ok ? { patch: finalExtraction.patch } : {}),
    ...(typeof finalRun.exitCode === "number" ? { exit_code: finalRun.exitCode } : {}),
    warnings: []
  };
}

function resolveCommand(): string[] {
  const override = process.env.CASEGRAPH_CODE_AGENT_CMD;
  if (!override) {
    return [...DEFAULT_COMMAND];
  }
  try {
    const parsed = JSON.parse(override) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through to whitespace split
  }
  return override.split(/\s+/).filter((part) => part.length > 0);
}

interface AttemptRecord {
  prompt: string;
  run: WorkerChildRunResult;
  extraction: PatchExtractionResult;
}

async function writeLog(
  logPath: string,
  command: string[],
  attempts: AttemptRecord[]
): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const sections: string[] = [
    "# casegraph-worker-code-agent log",
    `command: ${JSON.stringify(command)}`,
    `attempts: ${attempts.length}`,
    ""
  ];
  attempts.forEach((attempt, index) => {
    sections.push(
      `## attempt ${index + 1}`,
      `exit_code: ${attempt.run.exitCode}`,
      `signal: ${attempt.run.signal ?? ""}`,
      `timed_out: ${attempt.run.timedOut}`,
      `extraction_ok: ${attempt.extraction.ok}`,
      ...(attempt.extraction.ok
        ? []
        : [`rejection: ${attempt.extraction.reason.code}: ${attempt.extraction.reason.message}`]),
      "",
      "### stdout",
      attempt.run.stdout,
      "### stderr",
      attempt.run.stderr,
      ""
    );
  });
  await writeFile(logPath, sections.join("\n"), "utf8");
}
