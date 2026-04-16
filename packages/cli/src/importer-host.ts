import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  CaseGraphError,
  loadCaseState,
  loadConfigRecord,
  validatePatchDocument
} from "@casegraph/core";
import type {
  ImporterIngestResult,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcSuccess
} from "@casegraph/core";

interface RpcClient {
  close: () => Promise<void>;
  request: <TResult>(method: string, params?: unknown) => Promise<TResult>;
}

export async function ingestMarkdownPatch(options: {
  workspaceRoot: string;
  caseId: string;
  inputFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<ImporterIngestResult> {
  const config = await loadConfigRecord(options.workspaceRoot);
  const importerConfig = config.importers?.markdown;
  const command =
    importerConfig?.command && importerConfig.command.length > 0
      ? importerConfig.command
      : [
          process.execPath,
          "--experimental-strip-types",
          fileURLToPath(new URL("../../importer-markdown/src/index.ts", import.meta.url))
        ];

  const env = buildPluginEnv(options.env, importerConfig?.env_allowlist ?? []);
  const client = await createRpcClient({
    command,
    cwd: options.workspaceRoot,
    env
  });
  const state = await loadCaseState(options.workspaceRoot, options.caseId);

  try {
    await client.request("initialize", {
      client: { name: "cg", version: "0.1.0" }
    });
    const capabilities = await client.request<{ methods?: string[] }>("capabilities.list");
    if (!Array.isArray(capabilities.methods) || !capabilities.methods.includes("importer.ingest")) {
      throw new CaseGraphError(
        "importer_capability_missing",
        "Importer does not advertise importer.ingest",
        { exitCode: 2, details: capabilities }
      );
    }

    const result = await client.request<ImporterIngestResult>("importer.ingest", {
      case_id: options.caseId,
      base_revision: state.caseRecord.case_revision.current,
      input: {
        kind: "file",
        path: options.inputFile
      },
      options: {
        mode: "append"
      }
    });

    const validation = validatePatchDocument(result.patch);
    if (!validation.valid || !validation.patch) {
      throw new CaseGraphError("importer_patch_invalid", "Importer returned invalid patch", {
        exitCode: 2,
        details: validation
      });
    }

    return {
      patch: validation.patch,
      warnings: Array.isArray(result.warnings) ? [...result.warnings] : []
    };
  } finally {
    await client.request("shutdown").catch(() => undefined);
    await client.close();
  }
}

async function createRpcClient(options: {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<RpcClient> {
  if (options.command.length === 0) {
    throw new CaseGraphError("importer_command_missing", "Importer command is empty", {
      exitCode: 2
    });
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
      new CaseGraphError("importer_spawn_failed", "Could not start importer", {
        details: error
      })
    );
  });

  child.on("exit", (code) => {
    if (pending.size === 0) {
      return;
    }

    rejectPending(
      pending,
      new CaseGraphError(
        "importer_exited",
        `Importer exited before completing requests (code ${code ?? "unknown"})`,
        {
          details: stderr.join("")
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
        new CaseGraphError("importer_response_invalid", "Importer returned invalid JSON", {
          details: { error, line }
        })
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
      deferred.reject(toRpcError(response.error));
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

function buildPluginEnv(
  sourceEnv: NodeJS.ProcessEnv,
  allowlist: string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP"]) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  for (const key of allowlist) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  return env;
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

function toRpcError(error: JsonRpcErrorResponse["error"]) {
  return new CaseGraphError("importer_rpc_error", error.message, {
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
