import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createJsonRpcStdioClient,
  type ImporterIngestResult
} from "@casegraph/core";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    await rm(createdDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("markdown importer protocol", () => {
  it("supports initialize, capabilities, ingest, and shutdown", async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "casegraph-importer-"));
    createdDirs.push(fixtureDir);
    const markdownFile = path.join(fixtureDir, "notes.md");
    await writeFile(
      markdownFile,
      [
        "- [ ] Prepare release #release [priority:high]",
        "  - [x] Run regression #qa",
        "  - [ ] Update release notes [due_date:2026-05-01]"
      ].join("\n"),
      "utf8"
    );

    const client = await createImporterClient();
    try {
      const initialize = await client.request<{ name: string }>("initialize", {
        client: { name: "test", version: "0.1.0" }
      });
      expect(initialize.name).toBe("casegraph-importer-markdown");

      const capabilities = await client.request<{ methods: string[] }>("capabilities.list");
      expect(capabilities.methods).toContain("importer.ingest");

      const result = await client.request<ImporterIngestResult>("importer.ingest", {
        case_id: "release-1.8.0",
        base_revision: 42,
        input: {
          kind: "file",
          path: markdownFile
        },
        options: {
          mode: "append"
        }
      });

      expect(result.patch.base_revision).toBe(42);
      expect(result.patch.operations.map((operation) => operation.op)).toEqual([
        "add_node",
        "add_node",
        "add_edge",
        "add_node",
        "add_edge"
      ]);

      await client.request("shutdown");
    } finally {
      await client.close();
    }
  });
});

async function createImporterClient() {
  return createJsonRpcStdioClient({
    command: [
      process.execPath,
      "--experimental-strip-types",
      path.resolve("packages/importer-markdown/src/index.ts")
    ],
    cwd: process.cwd(),
    env: process.env,
    peerName: "importer"
  });
}
