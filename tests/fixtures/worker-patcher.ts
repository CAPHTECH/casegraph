#!/usr/bin/env -S node --experimental-strip-types

import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const CAPABILITIES = {
  effectful: false,
  needs_approval: false,
  shell_access: false,
  network_access: false,
  read_files: true,
  write_files: false
};

const METHODS = ["worker.execute"];

const rl = readline.createInterface({ input: process.stdin });

for await (const line of rl) {
  if (line.trim().length === 0) {
    continue;
  }
  const request = JSON.parse(line) as {
    id: number | string | null;
    method: string;
    params?: unknown;
  };
  const id = request.id ?? null;
  try {
    const result = await dispatch(request.method, request.params);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    if (request.method === "shutdown") {
      rl.close();
      process.exit(0);
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Unknown error"
        }
      })}\n`
    );
  }
}

async function dispatch(method: string, _params: unknown): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        name: "casegraph-worker-patcher-fixture",
        version: "0.0.1",
        capabilities: CAPABILITIES
      };
    case "health":
      return { ok: true };
    case "capabilities.list":
      return { methods: METHODS, worker: CAPABILITIES };
    case "shutdown":
      return { ok: true };
    case "worker.execute": {
      const envPath = path.join(process.cwd(), "patch.env");
      const raw = await readFile(envPath, "utf8");
      const parsed = JSON.parse(raw) as {
        base_revision: number;
        case_id: string;
        node_id: string;
      };
      return {
        status: "succeeded",
        summary: "Fixture worker emitted a change_state patch",
        artifacts: [],
        observations: [],
        warnings: [],
        patch: {
          patch_id: "patch_worker_fixture",
          spec_version: "0.1-draft",
          case_id: parsed.case_id,
          base_revision: parsed.base_revision,
          summary: "fixture mark done",
          generator: {
            kind: "worker",
            name: "casegraph-worker-patcher-fixture",
            version: "0.0.1"
          },
          operations: [
            {
              op: "change_state",
              node_id: parsed.node_id,
              state: "done"
            }
          ],
          notes: [],
          risks: []
        }
      };
    }
    default:
      throw new Error(`Method ${method} not supported`);
  }
}
