import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJsonRpcStdioClient } from "@caphtech/casegraph-core";
import { afterEach, describe, expect, it } from "vitest";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    await rm(createdDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("markdown sink protocol", () => {
  it("plans and applies a projection and round-trips checkbox changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-sink-"));
    createdDirs.push(workspaceRoot);

    const client = await createSinkClient(workspaceRoot);
    try {
      const initialize = await client.request<{ name: string }>("initialize", {
        client: { name: "test", version: "0.1.0" }
      });
      expect(initialize.name).toBe("casegraph-sink-markdown");

      const capabilities = await client.request<{ methods: string[] }>("capabilities.list");
      expect(capabilities.methods).toEqual([
        "sink.planProjection",
        "sink.applyProjection",
        "sink.pullChanges"
      ]);

      const caseId = "release-1.8.0";
      const plan = await client.request<{
        plan: Array<{
          op: string;
          internal_node_id: string;
          external_item_id?: string;
          bucket?: string;
        }>;
      }>("sink.planProjection", {
        case_id: caseId,
        base_revision: 1,
        actionable: [
          {
            node_id: "task_a",
            kind: "task",
            state: "todo",
            title: "Task A",
            labels: ["ready"],
            metadata: {},
            created_at: "2026-04-16T00:00:00.000Z",
            updated_at: "2026-04-16T00:00:00.000Z"
          }
        ],
        waiting: [
          {
            node_id: "task_b",
            kind: "task",
            state: "waiting",
            title: "Task B",
            labels: [],
            metadata: {},
            created_at: "2026-04-16T00:00:00.000Z",
            updated_at: "2026-04-16T00:00:00.000Z"
          }
        ],
        mapping: []
      });
      expect(plan.plan).toHaveLength(2);
      expect(plan.plan.map((op) => op.internal_node_id)).toEqual(["task_a", "task_b"]);

      const applied = await client.request<{
        applied: Array<{ op: string }>;
        mapping_deltas: Array<{
          internal_node_id: string;
          external_item_id: string;
          last_known_external_hash: string;
        }>;
      }>("sink.applyProjection", {
        case_id: caseId,
        plan: plan.plan
      });
      expect(applied.mapping_deltas).toHaveLength(2);

      const projectionFile = path.join(
        workspaceRoot,
        ".casegraph",
        "cases",
        caseId,
        "projections",
        "markdown.md"
      );
      const contents = await readFile(projectionFile, "utf8");
      expect(contents).toContain("## Actionable");
      expect(contents).toContain("## Waiting");
      expect(contents).toContain("- [ ] Task A #ready <!-- node: task_a -->");

      const checkedContents = contents.replace(
        "- [ ] Task A #ready <!-- node: task_a -->",
        "- [x] Task A #ready <!-- node: task_a -->"
      );
      await writeToFile(projectionFile, checkedContents);

      const pulled = await client.request<{
        patch: { operations: Array<{ op: string; node_id: string; state: string }> } | null;
        item_count: number;
        warnings: string[];
      }>("sink.pullChanges", {
        case_id: caseId,
        base_revision: 1,
        mapping: applied.mapping_deltas.map((delta) => ({
          sink_name: "markdown",
          internal_node_id: delta.internal_node_id,
          external_item_id: delta.external_item_id,
          last_pushed_at: null,
          last_pulled_at: null,
          last_known_external_hash: delta.last_known_external_hash
        }))
      });
      expect(pulled.item_count).toBe(2);
      expect(pulled.patch).not.toBeNull();
      expect(pulled.patch?.operations).toEqual([
        { op: "change_state", node_id: "task_a", state: "done" }
      ]);

      const repeatPull = await client.request<{ patch: unknown; warnings: string[] }>(
        "sink.pullChanges",
        {
          case_id: caseId,
          base_revision: 1,
          mapping: [
            {
              sink_name: "markdown",
              internal_node_id: "task_a",
              external_item_id: "task_a",
              last_pushed_at: null,
              last_pulled_at: null,
              last_known_external_hash: "checked"
            },
            {
              sink_name: "markdown",
              internal_node_id: "task_b",
              external_item_id: "task_b",
              last_pushed_at: null,
              last_pulled_at: null,
              last_known_external_hash: "unchecked"
            }
          ]
        }
      );
      expect(repeatPull.patch).toBeNull();
      expect(repeatPull.warnings).toContain("No checkbox state changes detected");

      await client.request("shutdown");
    } finally {
      await client.close();
    }
  });

  it("archives stale mappings and renders empty sections deterministically", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-sink-"));
    createdDirs.push(workspaceRoot);

    const client = await createSinkClient(workspaceRoot);
    try {
      const caseId = "release-1.8.0";
      const plan = await client.request<{
        plan: Array<{
          op: string;
          internal_node_id: string;
          external_item_id?: string;
        }>;
      }>("sink.planProjection", {
        case_id: caseId,
        base_revision: 2,
        actionable: [],
        waiting: [],
        mapping: [
          {
            sink_name: "markdown",
            internal_node_id: "task_old",
            external_item_id: "task_old",
            last_pushed_at: "2026-04-16T00:00:00.000Z",
            last_pulled_at: null,
            last_known_external_hash: "unchecked"
          }
        ]
      });

      expect(plan.plan).toEqual([
        {
          op: "archive_item",
          internal_node_id: "task_old",
          external_item_id: "task_old"
        }
      ]);

      const applied = await client.request<{
        applied: Array<{ op: string; internal_node_id: string }>;
        mapping_deltas: Array<unknown>;
      }>("sink.applyProjection", {
        case_id: caseId,
        plan: plan.plan
      });
      expect(applied.applied).toEqual([
        {
          op: "archive_item",
          internal_node_id: "task_old",
          external_item_id: "task_old"
        }
      ]);
      expect(applied.mapping_deltas).toEqual([]);

      const projectionFile = path.join(
        workspaceRoot,
        ".casegraph",
        "cases",
        caseId,
        "projections",
        "markdown.md"
      );
      const contents = await readFile(projectionFile, "utf8");
      expect(contents).toContain("## Actionable");
      expect(contents).toContain("_(no actionable items)_");
      expect(contents).toContain("## Waiting");
      expect(contents).toContain("_(no waiting items)_");

      await client.request("shutdown");
    } finally {
      await client.close();
    }
  });

  it("rejects pull before push with a clear error", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-sink-"));
    createdDirs.push(workspaceRoot);

    const client = await createSinkClient(workspaceRoot);
    try {
      await expect(
        client.request("sink.pullChanges", {
          case_id: "release-1.8.0",
          base_revision: 1,
          mapping: []
        })
      ).rejects.toThrow(/push before pull/);

      await client.request("shutdown");
    } finally {
      await client.close();
    }
  });

  it("warns on unmapped checklist lines without mutating mapped items", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-sink-"));
    createdDirs.push(workspaceRoot);

    const client = await createSinkClient(workspaceRoot);
    try {
      const caseId = "release-1.8.0";
      const plan = await client.request<{
        plan: Array<{
          op: string;
          internal_node_id: string;
          external_item_id?: string;
          bucket?: string;
        }>;
      }>("sink.planProjection", {
        case_id: caseId,
        base_revision: 1,
        actionable: [
          {
            node_id: "task_a",
            kind: "task",
            state: "todo",
            title: "Task A",
            labels: [],
            metadata: {},
            created_at: "2026-04-16T00:00:00.000Z",
            updated_at: "2026-04-16T00:00:00.000Z"
          }
        ],
        waiting: [],
        mapping: []
      });

      const applied = await client.request<{
        mapping_deltas: Array<{
          internal_node_id: string;
          external_item_id: string;
          last_known_external_hash: string;
        }>;
      }>("sink.applyProjection", {
        case_id: caseId,
        plan: plan.plan
      });

      const projectionFile = path.join(
        workspaceRoot,
        ".casegraph",
        "cases",
        caseId,
        "projections",
        "markdown.md"
      );
      const contents = await readFile(projectionFile, "utf8");
      await writeToFile(
        projectionFile,
        `${contents.trimEnd()}\n- [x] Ghost task <!-- node: task_ghost -->\n`
      );

      const pulled = await client.request<{
        patch: unknown;
        item_count: number;
        warnings: string[];
      }>("sink.pullChanges", {
        case_id: caseId,
        base_revision: 1,
        mapping: applied.mapping_deltas.map((delta) => ({
          sink_name: "markdown",
          internal_node_id: delta.internal_node_id,
          external_item_id: delta.external_item_id,
          last_pushed_at: null,
          last_pulled_at: null,
          last_known_external_hash: delta.last_known_external_hash
        }))
      });

      expect(pulled.patch).toBeNull();
      expect(pulled.item_count).toBe(2);
      expect(pulled.warnings).toContain("Line refers to unmapped node task_ghost; skipping");
      expect(pulled.warnings).toContain("No checkbox state changes detected");

      await client.request("shutdown");
    } finally {
      await client.close();
    }
  });
});

async function writeToFile(filePath: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, contents, "utf8");
}

async function createSinkClient(workspaceRoot: string) {
  return createJsonRpcStdioClient({
    command: [
      process.execPath,
      "--experimental-strip-types",
      path.resolve("packages/sink-markdown/src/index.ts")
    ],
    cwd: workspaceRoot,
    env: process.env,
    peerName: "sink"
  });
}
