import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "@casegraph/cli/app";
import {
  addNode,
  createCase,
  createDefaultMutationContext,
  deriveProjectionMappings,
  type EventEnvelope,
  exportEvents,
  loadCaseState,
  selectProjectionTargets
} from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("selectProjectionTargets", () => {
  it("returns only ready actionable nodes sorted deterministically", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-projection-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await createCase(
      workspaceRoot,
      { case_id: caseId, title: "Demo", description: "" },
      createDefaultMutationContext()
    );
    const ctx = createDefaultMutationContext();
    for (const node of [
      { node_id: "task_b", title: "Task B", state: "todo", kind: "task" as const },
      { node_id: "task_a", title: "Task A", state: "todo", kind: "task" as const },
      { node_id: "goal_x", title: "Goal", state: "todo", kind: "goal" as const },
      { node_id: "decision_c", title: "Decide", state: "todo", kind: "decision" as const },
      { node_id: "task_done", title: "Done task", state: "done", kind: "task" as const }
    ]) {
      await addNode(
        workspaceRoot,
        {
          caseId,
          node: {
            node_id: node.node_id,
            kind: node.kind,
            title: node.title,
            description: "",
            state: node.state,
            labels: [],
            acceptance: [],
            metadata: {},
            extensions: {}
          }
        },
        ctx
      );
    }

    const state = await loadCaseState(workspaceRoot, caseId);
    const targets = selectProjectionTargets(state);

    expect(targets.actionable.map((node) => node.node_id)).toEqual([
      "decision_c",
      "task_a",
      "task_b"
    ]);
    expect(targets.waiting).toEqual([]);
  });
});

describe("deriveProjectionMappings", () => {
  it("replays projection events into mapping rows idempotently", () => {
    const baseEvent: Omit<EventEnvelope, "type" | "payload"> = {
      event_id: "",
      spec_version: "0.1-draft",
      case_id: "demo",
      timestamp: "2026-04-17T00:00:00.000Z",
      actor: { kind: "user", id: "test", display_name: "Test" },
      source: "sync"
    };

    const events: EventEnvelope[] = [
      {
        ...baseEvent,
        event_id: "evt_push",
        type: "projection.pushed",
        payload: {
          sink_name: "markdown",
          plan_summary: { op_counts: { upsert_item: 1 } },
          mapping_deltas: [
            {
              internal_node_id: "task_a",
              external_item_id: "task_a",
              last_pushed_at: "2026-04-17T00:00:00.000Z",
              last_known_external_hash: "unchecked"
            }
          ],
          capabilities: { push: true, pull: true, dry_run: true }
        }
      },
      {
        ...baseEvent,
        event_id: "evt_pull",
        type: "projection.pulled",
        payload: {
          sink_name: "markdown",
          item_count: 1,
          patch_id: "patch_demo",
          mapping_deltas: [
            {
              internal_node_id: "task_a",
              external_item_id: "task_a",
              last_pulled_at: "2026-04-17T00:05:00.000Z",
              last_known_external_hash: "checked"
            }
          ]
        }
      }
    ];

    const mappings = deriveProjectionMappings(events);
    expect(mappings).toEqual([
      {
        sink_name: "markdown",
        internal_node_id: "task_a",
        external_item_id: "task_a",
        last_pushed_at: "2026-04-17T00:00:00.000Z",
        last_pulled_at: "2026-04-17T00:05:00.000Z",
        last_known_external_hash: "checked",
        sync_policy_json: null
      }
    ]);
  });
});

describe("cg sync round-trip", () => {
  it("pushes a checklist, pulls state changes, and applies them as a patch", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-sync-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";
    const patchFile = path.join(workspaceRoot, "pulled.patch.json");

    await runJsonCli(workspaceRoot, [
      "case",
      "new",
      "--id",
      caseId,
      "--title",
      "Demo",
      "--description",
      ""
    ]);
    await runJsonCli(workspaceRoot, [
      "node",
      "add",
      "--case",
      caseId,
      "--id",
      "task_a",
      "--kind",
      "task",
      "--title",
      "Task A"
    ]);

    const dry = await runJsonCli(workspaceRoot, [
      "sync",
      "push",
      "--sink",
      "markdown",
      "--case",
      caseId
    ]);
    expect(dry.code).toBe(0);
    expect(dry.json.data.applied).toBe(false);
    expect(dry.json.data.plan_summary.upsert_item).toBe(1);

    const applied = await runJsonCli(workspaceRoot, [
      "sync",
      "push",
      "--sink",
      "markdown",
      "--case",
      caseId,
      "--apply"
    ]);
    expect(applied.code).toBe(0);
    expect(applied.json.data.applied).toBe(true);

    const projectionFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      caseId,
      "projections",
      "markdown.md"
    );
    const contents = await readFile(projectionFile, "utf8");
    const checked = contents.replace(
      "- [ ] Task A <!-- node: task_a -->",
      "- [x] Task A <!-- node: task_a -->"
    );
    expect(checked).not.toEqual(contents);
    await writeFile(projectionFile, checked, "utf8");

    const pulled = await runJsonCli(workspaceRoot, [
      "sync",
      "pull",
      "--sink",
      "markdown",
      "--case",
      caseId,
      "--output",
      patchFile
    ]);
    expect(pulled.code).toBe(0);
    expect(pulled.json.data.patch).not.toBeNull();

    const patchApply = await runJsonCli(workspaceRoot, ["patch", "apply", "--file", patchFile]);
    expect(patchApply.code).toBe(0);

    const show = await runJsonCli(workspaceRoot, ["case", "show", "--case", caseId]);
    expect(show.code).toBe(0);

    const events = await exportEvents(workspaceRoot, caseId);
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain("projection.pushed");
    expect(eventTypes).toContain("projection.pulled");
    expect(eventTypes).toContain("patch.applied");

    const state = await loadCaseState(workspaceRoot, caseId);
    expect(state.nodes.get("task_a")?.state).toBe("done");

    const mappingsAfterRebuild = await runJsonCli(workspaceRoot, ["cache", "rebuild"]);
    expect(mappingsAfterRebuild.code).toBe(0);

    const validate = await runJsonCli(workspaceRoot, ["validate", "storage"]);
    expect(validate.json.data.valid).toBe(true);
  });
});

async function runJsonCli(workspaceRoot: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["--format", "json", ...args], {
    cwd: workspaceRoot,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    }
  });
  const output = stdout.join("").trim();
  const errorOutput = stderr.join("").trim();
  const payload = output.length > 0 ? output : errorOutput;
  return {
    code,
    stdout: output,
    stderr: errorOutput,
    json: payload.length > 0 ? JSON.parse(payload) : null
  };
}
