import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "@casegraph/cli/app";
import { exportEvents, loadCaseState, stringifyYaml } from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("cg worker run --worker code-agent", () => {
  it("emits a patch and marks the task done when the agent returns a casegraph-patch fence", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-code-agent-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setupCase(workspaceRoot, caseId);
    await configureFakeAgent(workspaceRoot, {
      mode: "patch",
      case_id: caseId,
      node_id: "task_refactor"
    });

    const patchPath = path.join(workspaceRoot, "out.patch.json");
    const result = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "code-agent",
      "--case",
      caseId,
      "--node",
      "task_refactor",
      "--approve",
      "--output",
      patchPath
    ]);

    expect(result.code).toBe(0);
    expect(result.json.data.status).toBe("succeeded");
    expect(result.json.data.patch).not.toBeNull();
    expect(result.json.data.output_file).toBe(patchPath);

    const apply = await runJsonCli(workspaceRoot, ["patch", "apply", "--file", patchPath]);
    expect(apply.code).toBe(0);

    const state = await loadCaseState(workspaceRoot, caseId);
    expect(state.nodes.get("task_refactor")?.state).toBe("done");

    const events = await exportEvents(workspaceRoot, caseId);
    const types = events.map((event) => event.type);
    expect(types).toContain("worker.dispatched");
    expect(types).toContain("worker.finished");
    expect(types).toContain("patch.applied");
  });

  it("returns failed without a patch when the agent replies with prose only", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-code-agent-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setupCase(workspaceRoot, caseId);
    await configureFakeAgent(workspaceRoot, {
      mode: "prose",
      case_id: caseId,
      node_id: "task_refactor"
    });

    const result = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "code-agent",
      "--case",
      caseId,
      "--node",
      "task_refactor",
      "--approve"
    ]);

    expect(result.code).toBe(0);
    expect(result.json.data.status).toBe("failed");
    expect(result.json.data.patch).toBeNull();
    expect(result.json.data.observations.join(" ")).toMatch(/no_fence_found/);

    const events = await exportEvents(workspaceRoot, caseId);
    const finished = events.find((event) => event.type === "worker.finished");
    expect((finished?.payload as { status: string }).status).toBe("failed");
  });

  it("rejects a patch whose case_id disagrees with the dispatched case", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-code-agent-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setupCase(workspaceRoot, caseId);
    await configureFakeAgent(workspaceRoot, {
      mode: "wrong_case",
      case_id: caseId,
      node_id: "task_refactor"
    });

    const result = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "code-agent",
      "--case",
      caseId,
      "--node",
      "task_refactor",
      "--approve"
    ]);

    expect(result.code).toBe(0);
    expect(result.json.data.status).toBe("succeeded");
    expect(result.json.data.patch).not.toBeNull();
    expect(result.json.data.patch.case_id).toBe(`${caseId}-wrong`);

    const state = await loadCaseState(workspaceRoot, caseId);
    expect(state.nodes.get("task_refactor")?.state).toBe("todo");
  });
});

async function setupCase(workspaceRoot: string, caseId: string): Promise<void> {
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
    "task_refactor",
    "--kind",
    "task",
    "--title",
    "Refactor helper"
  ]);
}

async function configureFakeAgent(
  workspaceRoot: string,
  config: { mode: "patch" | "prose" | "wrong_case"; case_id: string; node_id: string }
): Promise<void> {
  const configPath = path.join(workspaceRoot, ".casegraph", "config.yaml");
  const { readFile } = await import("node:fs/promises");
  const { parseYaml } = await import("@casegraph/core");
  const raw = await readFile(configPath, "utf8");
  const parsed = parseYaml<Record<string, unknown>>(raw);
  parsed.workers = {
    ...((parsed.workers as Record<string, unknown> | undefined) ?? {}),
    "code-agent": {
      env_allowlist: ["CASEGRAPH_CODE_AGENT_CMD"]
    }
  };
  await writeFile(configPath, stringifyYaml(parsed), "utf8");
  await writeFile(path.join(workspaceRoot, "agent.env"), JSON.stringify(config), "utf8");
}

async function runJsonCli(workspaceRoot: string, args: string[]) {
  const agentFixture = path.resolve("tests/fixtures/code-agent-fake.ts");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["--format", "json", ...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CASEGRAPH_CODE_AGENT_CMD: JSON.stringify([
        process.execPath,
        "--experimental-strip-types",
        agentFixture
      ])
    },
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
