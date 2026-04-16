import { spawn } from "node:child_process";
import readline from "node:readline";

import { CaseGraphError } from "./errors.js";
import type { JsonRpcErrorResponse, JsonRpcResponse, JsonRpcSuccess } from "./types.js";

export interface JsonRpcStdioClient {
  close: () => Promise<void>;
  request: <TResult>(method: string, params?: unknown) => Promise<TResult>;
}

export async function createJsonRpcStdioClient(options: {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  peerName: string;
}): Promise<JsonRpcStdioClient> {
  if (options.command.length === 0) {
    throw new CaseGraphError(
      `${options.peerName}_command_missing`,
      `${formatPeerName(options.peerName)} command is empty`,
      { exitCode: 2 }
    );
  }

  const child = spawn(options.command[0] as string, options.command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map<
    number,
    {
      reject: (error: unknown) => void;
      resolve: (value: unknown) => void;
    }
  >();
  const stderr: string[] = [];
  const stdout = readline.createInterface({ input: child.stdout });
  let nextId = 1;

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr.push(chunk.toString());
  });

  child.on("error", (error) => {
    rejectPending(
      pending,
      new CaseGraphError(
        `${options.peerName}_spawn_failed`,
        `Could not start ${options.peerName}`,
        { details: error, exitCode: 2 }
      )
    );
  });

  child.on("exit", (code) => {
    if (pending.size === 0) {
      return;
    }

    rejectPending(
      pending,
      new CaseGraphError(
        `${options.peerName}_exited`,
        `${formatPeerName(options.peerName)} exited before completing requests (code ${code ?? "unknown"})`,
        {
          details: stderr.join(""),
          exitCode: 2
        }
      )
    );
  });

  stdout.on("line", (line) => {
    if (line.trim().length === 0) {
      return;
    }

    let response: JsonRpcResponse<unknown>;
    try {
      response = JSON.parse(line) as JsonRpcResponse<unknown>;
    } catch (error) {
      rejectPending(
        pending,
        new CaseGraphError(
          `${options.peerName}_response_invalid`,
          `${formatPeerName(options.peerName)} returned invalid JSON`,
          {
            details: { error, line },
            exitCode: 2
          }
        )
      );
      return;
    }

    const id =
      typeof response.id === "number"
        ? response.id
        : typeof response.id === "string"
          ? Number(response.id)
          : null;

    if (id === null || !pending.has(id)) {
      return;
    }

    const deferred = pending.get(id) as {
      reject: (error: unknown) => void;
      resolve: (value: unknown) => void;
    };
    pending.delete(id);

    if ("error" in response) {
      deferred.reject(toRpcError(options.peerName, response.error));
      return;
    }

    deferred.resolve((response as JsonRpcSuccess<unknown>).result);
  });

  return {
    close: async () => {
      stdout.close();
      child.stdin.end();
      if (!child.killed) {
        child.kill();
      }
    },
    request: async <TResult>(method: string, params?: unknown) => {
      const id = nextId;
      nextId += 1;

      const request = {
        jsonrpc: "2.0" as const,
        id,
        method,
        params
      };

      const responsePromise = new Promise<TResult>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as TResult),
          reject
        });
      });

      const ok = child.stdin.write(`${JSON.stringify(request)}\n`);
      if (!ok) {
        await onceDrain(child.stdin);
      }

      return responsePromise;
    }
  };
}

function formatPeerName(peerName: string): string {
  return peerName.length > 0 ? `${peerName[0]?.toUpperCase()}${peerName.slice(1)}` : "Peer";
}

function rejectPending(
  pending: Map<number, { reject: (error: unknown) => void; resolve: (value: unknown) => void }>,
  error: unknown
): void {
  for (const deferred of pending.values()) {
    deferred.reject(error);
  }
  pending.clear();
}

function toRpcError(peerName: string, error: JsonRpcErrorResponse["error"]): CaseGraphError {
  return new CaseGraphError(`${peerName}_rpc_error`, error.message, {
    details: error.data,
    exitCode: 2
  });
}

async function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}
