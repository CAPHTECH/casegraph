import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptyWorkspaceDir, removeTempDir, runCgJson, runCgText } from "../helpers/e2e.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempDir(createdWorkspaces.pop() as string);
  }
});

describe("black-box manual acceptance e2e", () => {
  it("runs the documented manual acceptance flow through the built CLI", async () => {
    const workspaceRoot = await createEmptyWorkspaceDir("casegraph-e2e-acceptance-");
    createdWorkspaces.push(workspaceRoot);
    const patchFile = path.join(workspaceRoot, "release-sync.patch.json");
    const projectionFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      "release-1.8.0",
      "projections",
      "markdown.md"
    );

    await expectOk(runCgJson(workspaceRoot, ["init", "--title", "Acceptance Workspace"]));
    await expectOk(
      runCgJson(workspaceRoot, [
        "case",
        "new",
        "--id",
        "release-1.8.0",
        "--title",
        "Release 1.8.0",
        "--description",
        "May release"
      ])
    );

    for (const args of releaseSetupCommands) {
      await expectOk(runCgJson(workspaceRoot, args));
    }

    const initialFrontier = await runCgJson<{
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, ["frontier", "--case", "release-1.8.0"]);
    expect(initialFrontier.code).toBe(0);
    expect(initialFrontier.json?.data.nodes.map((node) => node.node_id)).toEqual([
      "task_run_regression",
      "task_update_notes"
    ]);

    const initialBlockers = await runCgJson<{
      data: { items: Array<{ node: { node_id: string }; reasons: Array<{ message: string }> }> };
    }>(workspaceRoot, ["blockers", "--case", "release-1.8.0"]);
    expect(initialBlockers.code).toBe(0);
    expect(
      initialBlockers.json?.data.items.map((item) => ({
        node_id: item.node.node_id,
        reasons: item.reasons.map((reason) => reason.message)
      }))
    ).toEqual([
      {
        node_id: "task_monitor_post_release",
        reasons: ["waits_for:event_release_live is not done"]
      },
      {
        node_id: "task_submit_store",
        reasons: [
          "depends_on:task_run_regression is not done",
          "depends_on:task_update_notes is not done"
        ]
      }
    ]);

    const initialCaseView = await runCgText(workspaceRoot, [
      "case",
      "view",
      "--case",
      "release-1.8.0"
    ]);
    expect(initialCaseView.code).toBe(0);
    expect(initialCaseView.stdout).toContain(
      "! task_run_regression [task/todo] Run regression test"
    );
    expect(initialCaseView.stdout).toContain(
      "= task_submit_store [task/todo] Submit to App Store (shared)"
    );

    const push = await runCgJson<{ data: { applied: boolean } }>(workspaceRoot, [
      "sync",
      "push",
      "--sink",
      "markdown",
      "--case",
      "release-1.8.0",
      "--apply"
    ]);
    expect(push.code).toBe(0);
    expect(push.json?.data.applied).toBe(true);

    const originalProjection = await readFile(projectionFile, "utf8");
    const checkedProjection = originalProjection
      .replace(
        "- [ ] Run regression test <!-- node: task_run_regression -->",
        "- [x] Run regression test <!-- node: task_run_regression -->"
      )
      .replace(
        "- [ ] Update release notes <!-- node: task_update_notes -->",
        "- [x] Update release notes <!-- node: task_update_notes -->"
      );
    expect(checkedProjection).not.toEqual(originalProjection);
    await writeFile(projectionFile, checkedProjection, "utf8");

    const pull = await runCgJson<{ data: { patch: { patch_id: string } | null } }>(workspaceRoot, [
      "sync",
      "pull",
      "--sink",
      "markdown",
      "--case",
      "release-1.8.0",
      "--output",
      patchFile
    ]);
    expect(pull.code).toBe(0);
    expect(pull.json?.data.patch).not.toBeNull();

    await expectOk(runCgJson(workspaceRoot, ["patch", "review", "--file", patchFile]));
    await expectOk(runCgJson(workspaceRoot, ["patch", "apply", "--file", patchFile]));

    const submissionFrontier = await runCgJson<{
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, ["frontier", "--case", "release-1.8.0"]);
    expect(submissionFrontier.code).toBe(0);
    expect(submissionFrontier.json?.data.nodes.map((node) => node.node_id)).toEqual([
      "task_submit_store"
    ]);

    await expectOk(
      runCgJson(workspaceRoot, ["task", "done", "--case", "release-1.8.0", "task_submit_store"])
    );
    await expectOk(
      runCgJson(workspaceRoot, ["event", "record", "--case", "release-1.8.0", "event_release_live"])
    );

    const monitorFrontier = await runCgJson<{
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, ["frontier", "--case", "release-1.8.0"]);
    expect(monitorFrontier.code).toBe(0);
    expect(monitorFrontier.json?.data.nodes.map((node) => node.node_id)).toEqual([
      "task_monitor_post_release"
    ]);

    const criticalPath = await runCgJson<{
      ok: boolean;
      data: { depth_path: { node_ids: string[] } };
    }>(workspaceRoot, [
      "analyze",
      "critical-path",
      "--case",
      "release-1.8.0",
      "--goal",
      "goal_release_ready"
    ]);
    expect(criticalPath.code).toBe(0);
    expect(criticalPath.json?.ok).toBe(true);
    expect(criticalPath.json?.data.depth_path.node_ids).toEqual(["task_monitor_post_release"]);

    const slack = await runCgJson<{
      ok: boolean;
      data: { nodes: Array<{ node_id: string; is_critical: boolean }> };
    }>(workspaceRoot, [
      "analyze",
      "slack",
      "--case",
      "release-1.8.0",
      "--goal",
      "goal_release_ready"
    ]);
    expect(slack.code).toBe(0);
    expect(slack.json?.ok).toBe(true);
    expect(slack.json?.data.nodes).toMatchObject([
      { node_id: "task_monitor_post_release", is_critical: true }
    ]);

    const validate = await runCgJson<{ data: { valid: boolean } }>(workspaceRoot, [
      "validate",
      "storage"
    ]);
    expect(validate.code).toBe(0);
    expect(validate.json?.data.valid).toBe(true);

    const verify = await runCgJson<{ data: { event_count: number } }>(workspaceRoot, [
      "events",
      "verify",
      "--case",
      "release-1.8.0"
    ]);
    expect(verify.code).toBe(0);
    expect(verify.json?.data.event_count).toBeGreaterThan(0);

    await expectOk(runCgJson(workspaceRoot, ["cache", "rebuild"]));

    const migrationCheck = await runCgJson<{
      data: { supported: boolean; pending_steps: unknown[]; issues: unknown[] };
    }>(workspaceRoot, ["migrate", "check"]);
    expect(migrationCheck.code).toBe(0);
    expect(migrationCheck.json?.data).toMatchObject({
      supported: true,
      pending_steps: [],
      issues: []
    });

    const postRebuildFrontier = await runCgJson<{
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, ["frontier", "--case", "release-1.8.0"]);
    expect(postRebuildFrontier.code).toBe(0);
    expect(postRebuildFrontier.json?.data.nodes.map((node) => node.node_id)).toEqual([
      "task_monitor_post_release"
    ]);

    const finalCaseView = await runCgText(workspaceRoot, [
      "case",
      "view",
      "--case",
      "release-1.8.0"
    ]);
    expect(finalCaseView.code).toBe(0);
    expect(finalCaseView.stdout).toContain(
      "! task_monitor_post_release [task/todo] Monitor post-release"
    );
    expect(finalCaseView.stdout).toContain(
      "= task_submit_store [task/done] Submit to App Store (shared)"
    );
  }, 45_000);
});

async function expectOk(
  commandPromise: Promise<{ code: number; stdout: string; stderr: string }>
): Promise<void> {
  const result = await commandPromise;
  expect(result.code).toBe(0);
}

const releaseSetupCommands: string[][] = [
  [
    "node",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "goal_release_ready",
    "--kind",
    "goal",
    "--title",
    "Release 1.8.0 ready"
  ],
  [
    "node",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "task_run_regression",
    "--kind",
    "task",
    "--title",
    "Run regression test",
    "--state",
    "todo",
    "--metadata",
    '{"estimate_minutes":45}'
  ],
  [
    "node",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "task_update_notes",
    "--kind",
    "task",
    "--title",
    "Update release notes",
    "--state",
    "todo",
    "--metadata",
    '{"estimate_minutes":15}'
  ],
  [
    "node",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "task_submit_store",
    "--kind",
    "task",
    "--title",
    "Submit to App Store",
    "--state",
    "todo",
    "--metadata",
    '{"estimate_minutes":20}'
  ],
  [
    "node",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "task_monitor_post_release",
    "--kind",
    "task",
    "--title",
    "Monitor post-release",
    "--state",
    "todo",
    "--metadata",
    '{"estimate_minutes":30}'
  ],
  [
    "node",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "event_release_live",
    "--kind",
    "event",
    "--title",
    "Release live",
    "--state",
    "todo"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e1",
    "--type",
    "depends_on",
    "--from",
    "task_submit_store",
    "--to",
    "task_run_regression"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e2",
    "--type",
    "depends_on",
    "--from",
    "task_submit_store",
    "--to",
    "task_update_notes"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e3",
    "--type",
    "waits_for",
    "--from",
    "task_monitor_post_release",
    "--to",
    "event_release_live"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e4",
    "--type",
    "contributes_to",
    "--from",
    "task_run_regression",
    "--to",
    "goal_release_ready"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e5",
    "--type",
    "contributes_to",
    "--from",
    "task_update_notes",
    "--to",
    "goal_release_ready"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e6",
    "--type",
    "contributes_to",
    "--from",
    "task_submit_store",
    "--to",
    "goal_release_ready"
  ],
  [
    "edge",
    "add",
    "--case",
    "release-1.8.0",
    "--id",
    "e7",
    "--type",
    "contributes_to",
    "--from",
    "task_monitor_post_release",
    "--to",
    "goal_release_ready"
  ]
];
