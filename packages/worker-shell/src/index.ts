#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertWorkerExecuteParams,
  isRecord,
  runPluginStdioServer,
  runWorkerChild,
  type WorkerChildRunResult,
  workerLogPath
} from "@caphtech/casegraph-core/plugin-server";
import type {
  WorkerArtifact,
  WorkerExecuteParams,
  WorkerExecuteResult
} from "@caphtech/casegraph-kernel";

const WORKER_NAME = "shell";
const WORKER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_SECONDS = 60;

const WORKER_CAPABILITIES = {
  effectful: true,
  needs_approval: true,
  shell_access: true,
  network_access: false,
  read_files: true,
  write_files: true
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
      "worker.execute": (params) => executeShell(assertWorkerExecuteParams(params))
    }
  });
}

export async function executeShell(params: WorkerExecuteParams): Promise<WorkerExecuteResult> {
  const command = extractCommand(params.task.metadata);
  if (!command) {
    return {
      status: "failed",
      summary: "Shell worker requires task.metadata.shell.command (string[])",
      artifacts: [],
      observations: [
        "No shell command was provided on the task metadata; the shell worker has nothing to execute."
      ],
      exit_code: undefined,
      warnings: []
    };
  }

  const timeoutSeconds =
    params.execution_policy.timeout_seconds > 0
      ? params.execution_policy.timeout_seconds
      : DEFAULT_TIMEOUT_SECONDS;
  const logPath = workerLogPath(params.case.case_id, params.execution_policy.command_id);

  const runResult = await runWorkerChild({ command, timeoutSeconds });
  await writeLog(logPath, command, runResult);

  const relativeLogPath = path.relative(process.cwd(), logPath);
  const observations: string[] = [];
  if (runResult.timedOut) {
    observations.push(`Command exceeded ${timeoutSeconds}s timeout and was terminated.`);
  }
  if (runResult.signal) {
    observations.push(`Command received signal ${runResult.signal}.`);
  }

  const status: WorkerExecuteResult["status"] = runResult.exitCode === 0 ? "succeeded" : "failed";
  const summary =
    status === "succeeded"
      ? `Command exited 0: ${command.join(" ")}`
      : `Command failed with exit ${runResult.exitCode ?? "null"}: ${command.join(" ")}`;

  const artifact: WorkerArtifact = {
    kind: "log",
    path: relativeLogPath,
    description: "Combined stdout/stderr log",
    metadata: {
      exit_code: runResult.exitCode,
      timed_out: runResult.timedOut,
      signal: runResult.signal
    }
  };

  return {
    status,
    summary,
    artifacts: [artifact],
    observations,
    exit_code: runResult.exitCode ?? undefined,
    warnings: []
  };
}

function extractCommand(metadata: Record<string, unknown>): string[] | null {
  const shell = metadata.shell;
  if (!isRecord(shell)) {
    return null;
  }
  const command = shell.command;
  if (!Array.isArray(command) || command.length === 0) {
    return null;
  }
  for (const entry of command) {
    if (typeof entry !== "string") {
      return null;
    }
  }
  return command as string[];
}

async function writeLog(
  logPath: string,
  command: string[],
  result: WorkerChildRunResult
): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const header = [
    `# casegraph-worker-shell log`,
    `command: ${JSON.stringify(command)}`,
    `exit_code: ${result.exitCode}`,
    `signal: ${result.signal ?? ""}`,
    `timed_out: ${result.timedOut}`,
    ""
  ].join("\n");
  const body = ["### stdout", result.stdout, "### stderr", result.stderr, ""].join("\n");
  await writeFile(logPath, `${header}\n${body}`, "utf8");
}
