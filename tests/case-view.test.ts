import { runCli } from "@caphtech/casegraph-cli/app";
import { afterEach, describe, expect, it } from "vitest";

import releaseFixture from "./fixtures/release-case.fixture.json";
import { createTempWorkspace, removeTempWorkspace, seedFixture } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("cg case view", () => {
  it("renders an ASCII dependency tree in text mode", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-case-view-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const text = await runTextCli(workspaceRoot, [
      "case",
      "view",
      "--case",
      releaseFixture.case.case_id
    ]);

    expect(text).toContain("goal_release_ready");
    expect(text).toContain("task_run_regression");
    expect(text).toContain("task_submit_store");
    expect(text).toContain("[task/todo]");
    expect(text).toContain("! task_run_regression [task/todo] Run regression test");
    expect(text).toContain("└─ ✗ task_submit_store [task/todo] Submit to App Store");
    expect(text).toContain("= task_submit_store [task/todo] Submit to App Store (shared)");
  });

  it("returns tree_lines plus serialised state in JSON mode", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-case-view-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const json = await runJsonCli(workspaceRoot, [
      "case",
      "view",
      "--case",
      releaseFixture.case.case_id
    ]);

    expect(json.code).toBe(0);
    expect(json.json.ok).toBe(true);
    const data = json.json.data as {
      case_id: string;
      tree_lines: string[];
      nodes: Array<{ node_id: string }>;
      edges: Array<{ edge_id: string }>;
      revision: { current: number };
    };
    expect(data.case_id).toBe(releaseFixture.case.case_id);
    expect(data.tree_lines.length).toBeGreaterThan(0);
    expect(
      data.tree_lines.some((line) =>
        line.includes("! task_run_regression [task/todo] Run regression test")
      )
    ).toBe(true);
    expect(
      data.tree_lines.some((line) =>
        line.includes("= task_submit_store [task/todo] Submit to App Store (shared)")
      )
    ).toBe(true);
    expect(new Set(data.nodes.map((node) => node.node_id))).toEqual(
      new Set(releaseFixture.nodes.map((node) => node.node_id))
    );
    expect(data.edges.map((edge) => edge.edge_id).sort()).toEqual(
      releaseFixture.edges.map((edge) => edge.edge_id).sort()
    );
    expect(data.revision.current).toBeGreaterThan(0);
  });
});

async function runTextCli(workspaceRoot: string, args: string[]): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    cwd: workspaceRoot,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    }
  });
  if (code !== 0) {
    throw new Error(`cli exited ${code}: ${stderr.join("")}`);
  }
  return stdout.join("");
}

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
