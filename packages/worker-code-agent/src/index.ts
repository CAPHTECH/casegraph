#!/usr/bin/env -S node --experimental-strip-types

import { spawn } from "node:child_process";
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

const WORKER_NAME = "code-agent";
const WORKER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_COMMAND = ["claude", "--print"];

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
      "worker.execute": (params) => execute(assertExecuteParams(params))
    }
  });
}

export async function execute(params: WorkerExecuteParams): Promise<WorkerExecuteResult> {
  const command = resolveCommand();
  const prompt = buildAgentPrompt(params);
  const timeoutSeconds =
    params.execution_policy.timeout_seconds > 0
      ? params.execution_policy.timeout_seconds
      : DEFAULT_TIMEOUT_SECONDS;

  const runResult = await runChild(command, prompt, timeoutSeconds);

  const logPath = path.join(
    process.cwd(),
    ".casegraph",
    "cases",
    params.case.case_id,
    "worker-logs",
    `${params.execution_policy.command_id}.log`
  );
  await writeLog(logPath, command, runResult);

  const patch = extractPatchFromText(runResult.stdout, params.case.case_id);
  const relativeLogPath = path.relative(process.cwd(), logPath);
  const artifact: WorkerArtifact = {
    kind: "log",
    path: relativeLogPath,
    description: "Code agent stdout/stderr",
    metadata: {
      command: command.join(" "),
      exit_code: runResult.exitCode,
      timed_out: runResult.timedOut,
      signal: runResult.signal
    }
  };

  const observations: string[] = [];
  if (runResult.timedOut) {
    observations.push(`Command exceeded ${timeoutSeconds}s timeout and was terminated.`);
  }
  if (!patch) {
    observations.push("No fenced casegraph-patch or json block was parseable in agent stdout.");
  }

  return {
    status: patch ? "succeeded" : "failed",
    summary: patch
      ? `Code agent produced a GraphPatch for ${params.task.node_id}`
      : `Code agent did not produce a GraphPatch for ${params.task.node_id}`,
    artifacts: [artifact],
    observations,
    ...(patch ? { patch } : {}),
    ...(typeof runResult.exitCode === "number" ? { exit_code: runResult.exitCode } : {}),
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

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runChild(
  command: string[],
  prompt: string,
  timeoutSeconds: number
): Promise<RunResult> {
  const [cmd, ...args] = command;
  if (!cmd) {
    return { exitCode: null, signal: null, stdout: "", stderr: "empty command", timedOut: false };
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}\nspawn error: ${error.message}`,
        timedOut
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function writeLog(logPath: string, command: string[], result: RunResult): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const header = [
    "# casegraph-worker-code-agent log",
    `command: ${JSON.stringify(command)}`,
    `exit_code: ${result.exitCode}`,
    `signal: ${result.signal ?? ""}`,
    `timed_out: ${result.timedOut}`,
    ""
  ].join("\n");
  const body = ["### stdout", result.stdout, "### stderr", result.stderr, ""].join("\n");
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
