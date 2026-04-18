import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { WorkerExecuteParams } from "@caphtech/casegraph-kernel";

export interface PluginServerInfo {
  name: string;
  version: string;
  capabilities: Record<string, unknown>;
  methods: string[];
  extra?: Record<string, unknown>;
}

export type PluginMethodHandler = (params: unknown) => unknown | Promise<unknown>;

export interface PluginServerOptions {
  info: PluginServerInfo;
  handlers: Record<string, PluginMethodHandler>;
}

type JsonRpcRequest = {
  id?: number | string | null;
  method?: string;
  params?: unknown;
};

export async function runPluginStdioServer(options: PluginServerOptions): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });
  const { info, handlers } = options;

  for await (const line of input) {
    await handleLine(line, info, handlers, input);
  }
}

async function handleLine(
  line: string,
  info: PluginServerInfo,
  handlers: Record<string, PluginMethodHandler>,
  input: readline.Interface
): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    writeError(null, -32700, "Parse error", error);
    return;
  }

  const id = request.id ?? null;
  if (typeof request.method !== "string") {
    writeError(id, -32600, "Invalid Request");
    return;
  }

  if (request.method === "shutdown") {
    writeResult(id, { ok: true });
    input.close();
    process.exit(0);
  }

  try {
    await dispatchMethod(request.method, request.params, id, info, handlers);
  } catch (error) {
    writeError(id, -32000, toErrorMessage(error), error);
  }
}

async function dispatchMethod(
  method: string,
  params: unknown,
  id: number | string | null,
  info: PluginServerInfo,
  handlers: Record<string, PluginMethodHandler>
): Promise<void> {
  switch (method) {
    case "initialize":
      writeResult(id, {
        name: info.name,
        version: info.version,
        capabilities: info.capabilities
      });
      return;
    case "health":
      writeResult(id, { ok: true });
      return;
    case "capabilities.list":
      writeResult(id, { methods: info.methods, ...info.extra });
      return;
  }
  const handler = handlers[method];
  if (!handler) {
    writeError(id, -32601, `Method ${method} not found`);
    return;
  }
  writeResult(id, await handler(params));
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function writeResult(id: number | string | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function assertWorkerExecuteParams(input: unknown): WorkerExecuteParams {
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

export function workerLogPath(
  caseId: string,
  commandId: string,
  cwd: string = process.cwd()
): string {
  return path.join(cwd, ".casegraph", "cases", caseId, "worker-logs", `${commandId}.log`);
}

export interface WorkerChildRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunWorkerChildOptions {
  command: string[];
  timeoutSeconds: number;
  stdin?: string;
  cwd?: string;
}

export async function runWorkerChild(
  options: RunWorkerChildOptions
): Promise<WorkerChildRunResult> {
  const [cmd, ...args] = options.command;
  if (!cmd) {
    return { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false };
  }
  const stdin = options.stdin;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: stdin === undefined ? "pipe" : ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
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

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
