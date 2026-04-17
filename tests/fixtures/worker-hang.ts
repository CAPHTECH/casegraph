#!/usr/bin/env -S node --experimental-strip-types

import readline from "node:readline";

const CAPABILITIES = {
  effectful: false,
  needs_approval: false,
  shell_access: false,
  network_access: false,
  read_files: false,
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
  switch (request.method) {
    case "initialize":
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            name: "casegraph-worker-hang-fixture",
            version: "0.0.1",
            capabilities: CAPABILITIES
          }
        })}\n`
      );
      break;
    case "health":
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n`);
      break;
    case "capabilities.list":
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { methods: METHODS, worker: CAPABILITIES }
        })}\n`
      );
      break;
    case "shutdown":
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n`);
      rl.close();
      process.exit(0);
      break;
    case "worker.execute":
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method ${request.method} not found` }
        })}\n`
      );
      break;
  }
}
