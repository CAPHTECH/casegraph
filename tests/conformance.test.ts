import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { runPluginConformance } from "./helpers/conformance.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    await rm(createdDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("plugin protocol conformance", () => {
  it("importer-markdown passes the conformance suite", async () => {
    const cwd = await freshDir("casegraph-conformance-importer-");
    await runPluginConformance({
      role: "importer",
      cwd,
      command: [
        process.execPath,
        "--experimental-strip-types",
        path.resolve("packages/importer-markdown/src/index.ts")
      ]
    });
  });

  it("sink-markdown passes the conformance suite", async () => {
    const cwd = await freshDir("casegraph-conformance-sink-");
    await runPluginConformance({
      role: "sink",
      cwd,
      command: [
        process.execPath,
        "--experimental-strip-types",
        path.resolve("packages/sink-markdown/src/index.ts")
      ]
    });
  });

  it("worker-shell passes the conformance suite", async () => {
    const cwd = await freshDir("casegraph-conformance-worker-");
    await runPluginConformance({
      role: "worker",
      cwd,
      command: [
        process.execPath,
        "--experimental-strip-types",
        path.resolve("packages/worker-shell/src/index.ts")
      ]
    });
  });
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}
