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

describe("black-box quickstart e2e", () => {
  it("runs the documented quickstart flow through the built CLI", async () => {
    const workspaceRoot = await createEmptyWorkspaceDir("casegraph-e2e-quickstart-");
    createdWorkspaces.push(workspaceRoot);
    const patchFile = path.join(workspaceRoot, "release-demo-sync.patch.json");
    const projectionFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      "release-demo",
      "projections",
      "markdown.md"
    );

    const init = await runCgJson(workspaceRoot, ["init", "--title", "CaseGraph Demo"]);
    expect(init.code).toBe(0);
    expect(init.json).toMatchObject({
      ok: true,
      command: "init",
      data: { workspace: { title: "CaseGraph Demo" } }
    });

    await expectOk(
      runCgJson(workspaceRoot, [
        "case",
        "new",
        "--id",
        "release-demo",
        "--title",
        "Release demo",
        "--description",
        "Quickstart case"
      ])
    );
    await expectOk(
      runCgJson(workspaceRoot, [
        "node",
        "add",
        "--case",
        "release-demo",
        "--id",
        "goal_release_demo",
        "--kind",
        "goal",
        "--title",
        "Release demo ready"
      ])
    );
    await expectOk(
      runCgJson(workspaceRoot, [
        "node",
        "add",
        "--case",
        "release-demo",
        "--id",
        "task_write_notes",
        "--kind",
        "task",
        "--title",
        "Write release notes",
        "--state",
        "todo"
      ])
    );
    await expectOk(
      runCgJson(workspaceRoot, [
        "node",
        "add",
        "--case",
        "release-demo",
        "--id",
        "task_publish",
        "--kind",
        "task",
        "--title",
        "Publish build",
        "--state",
        "todo"
      ])
    );

    await expectOk(
      runCgJson(workspaceRoot, [
        "edge",
        "add",
        "--case",
        "release-demo",
        "--id",
        "edge_publish_depends_notes",
        "--type",
        "depends_on",
        "--from",
        "task_publish",
        "--to",
        "task_write_notes"
      ])
    );
    await expectOk(
      runCgJson(workspaceRoot, [
        "edge",
        "add",
        "--case",
        "release-demo",
        "--id",
        "edge_notes_goal",
        "--type",
        "contributes_to",
        "--from",
        "task_write_notes",
        "--to",
        "goal_release_demo"
      ])
    );
    await expectOk(
      runCgJson(workspaceRoot, [
        "edge",
        "add",
        "--case",
        "release-demo",
        "--id",
        "edge_publish_goal",
        "--type",
        "contributes_to",
        "--from",
        "task_publish",
        "--to",
        "goal_release_demo"
      ])
    );

    const initialFrontier = await runCgJson<{
      ok: boolean;
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, ["frontier", "--case", "release-demo"]);
    expect(initialFrontier.code).toBe(0);
    expect(initialFrontier.json?.ok).toBe(true);
    expect(initialFrontier.json?.data.nodes.map((node) => node.node_id)).toEqual([
      "task_write_notes"
    ]);

    const initialBlockers = await runCgJson<{
      data: { items: Array<{ node: { node_id: string }; reasons: Array<{ message: string }> }> };
    }>(workspaceRoot, ["blockers", "--case", "release-demo"]);
    expect(initialBlockers.code).toBe(0);
    expect(initialBlockers.json?.data.items).toMatchObject([
      {
        node: { node_id: "task_publish" },
        reasons: [{ message: "depends_on:task_write_notes is not done" }]
      }
    ]);

    const push = await runCgJson<{ data: { applied: boolean } }>(workspaceRoot, [
      "sync",
      "push",
      "--sink",
      "markdown",
      "--case",
      "release-demo",
      "--apply"
    ]);
    expect(push.code).toBe(0);
    expect(push.json?.data.applied).toBe(true);

    const originalProjection = await readFile(projectionFile, "utf8");
    const checkedProjection = originalProjection.replace(
      "- [ ] Write release notes <!-- node: task_write_notes -->",
      "- [x] Write release notes <!-- node: task_write_notes -->"
    );
    expect(checkedProjection).not.toEqual(originalProjection);
    await writeFile(projectionFile, checkedProjection, "utf8");

    const pull = await runCgJson<{ data: { patch: { patch_id: string } | null } }>(workspaceRoot, [
      "sync",
      "pull",
      "--sink",
      "markdown",
      "--case",
      "release-demo",
      "--output",
      patchFile
    ]);
    expect(pull.code).toBe(0);
    expect(pull.json?.data.patch).not.toBeNull();

    await expectOk(runCgJson(workspaceRoot, ["patch", "review", "--file", patchFile]));
    await expectOk(runCgJson(workspaceRoot, ["patch", "apply", "--file", patchFile]));

    const nextFrontier = await runCgJson<{
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, ["frontier", "--case", "release-demo"]);
    expect(nextFrontier.code).toBe(0);
    expect(nextFrontier.json?.data.nodes.map((node) => node.node_id)).toEqual(["task_publish"]);

    const caseView = await runCgText(workspaceRoot, ["case", "view", "--case", "release-demo"]);
    expect(caseView.code).toBe(0);
    expect(caseView.stdout).toContain("✓ task_write_notes [task/done] Write release notes");
    expect(caseView.stdout).toContain("! task_publish [task/todo] Publish build");

    const criticalPath = await runCgJson<{
      ok: boolean;
      data: { goal_node_id: string; depth_path: { node_ids: string[] } };
    }>(workspaceRoot, [
      "analyze",
      "critical-path",
      "--case",
      "release-demo",
      "--goal",
      "goal_release_demo"
    ]);
    expect(criticalPath.code).toBe(0);
    expect(criticalPath.json?.ok).toBe(true);
    expect(criticalPath.json?.data.goal_node_id).toBe("goal_release_demo");
    expect(criticalPath.json?.data.depth_path.node_ids).toEqual(["task_publish"]);

    const slack = await runCgJson<{ ok: boolean }>(workspaceRoot, [
      "analyze",
      "slack",
      "--case",
      "release-demo",
      "--goal",
      "goal_release_demo"
    ]);
    expect(slack.code).toBe(0);
    expect(slack.json?.ok).toBe(true);

    const bottlenecks = await runCgJson<{
      ok: boolean;
      data: { nodes: Array<{ node_id: string }> };
    }>(workspaceRoot, [
      "analyze",
      "bottlenecks",
      "--case",
      "release-demo",
      "--goal",
      "goal_release_demo"
    ]);
    expect(bottlenecks.code).toBe(0);
    expect(bottlenecks.json?.ok).toBe(true);
    expect(bottlenecks.json?.data.nodes.map((node) => node.node_id)).toEqual(["task_publish"]);
  }, 30_000);
});

async function expectOk(
  commandPromise: Promise<{ code: number; stdout: string; stderr: string }>
): Promise<void> {
  const result = await commandPromise;
  expect(result.code).toBe(0);
}
