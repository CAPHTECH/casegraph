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

describe("cg worker run", () => {
  it("requires --approve for an effectful worker and records worker events on success", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-worker-cli-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

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
      "task_echo",
      "--kind",
      "task",
      "--title",
      "Echo",
      "--metadata",
      JSON.stringify({ shell: { command: ["node", "-e", "process.stdout.write('ok')"] } })
    ]);

    const rejected = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "shell",
      "--case",
      caseId,
      "--node",
      "task_echo"
    ]);
    expect(rejected.code).toBe(2);
    expect(rejected.json.ok).toBe(false);
    expect(rejected.json.error.code).toBe("worker_approval_required");

    const ok = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "shell",
      "--case",
      caseId,
      "--node",
      "task_echo",
      "--approve"
    ]);
    expect(ok.code).toBe(0);
    expect(ok.json.data.status).toBe("succeeded");
    expect(ok.json.data.exit_code).toBe(0);
    expect(ok.json.data.artifacts[0].kind).toBe("log");

    const events = await exportEvents(workspaceRoot, caseId);
    const workerEvents = events.filter((event) => event.type.startsWith("worker."));
    expect(workerEvents.map((event) => event.type)).toEqual([
      "worker.dispatched",
      "worker.finished"
    ]);
    expect((workerEvents[1]?.payload as { status: string }).status).toBe("succeeded");

    const state = await loadCaseState(workspaceRoot, caseId);
    expect(state.nodes.get("task_echo")?.state).toBe("todo");
  });

  it("blocks execution when approval_policy sets the worker to deny", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-worker-cli-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setApprovalPolicy(workspaceRoot, { shell: "deny" });

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
      "task_echo",
      "--kind",
      "task",
      "--title",
      "Echo",
      "--metadata",
      JSON.stringify({ shell: { command: ["node", "-e", "process.stdout.write('ok')"] } })
    ]);

    const denied = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "shell",
      "--case",
      caseId,
      "--node",
      "task_echo",
      "--approve"
    ]);
    expect(denied.code).toBe(2);
    expect(denied.json.error.code).toBe("worker_approval_denied");

    const events = await exportEvents(workspaceRoot, caseId);
    expect(events.some((event) => event.type.startsWith("worker."))).toBe(false);
  });

  it("runs without --approve when approval_policy marks the worker as auto", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-worker-cli-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setApprovalPolicy(workspaceRoot, { shell: "auto" });

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
      "task_echo",
      "--kind",
      "task",
      "--title",
      "Echo",
      "--metadata",
      JSON.stringify({ shell: { command: ["node", "-e", "process.stdout.write('ok')"] } })
    ]);

    const ok = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "shell",
      "--case",
      caseId,
      "--node",
      "task_echo"
    ]);
    expect(ok.code).toBe(0);
    expect(ok.json.data.approval).toBe("auto");
  });

  it("writes a worker-returned GraphPatch to --output and feeds it back through cg patch apply", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-worker-cli-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";
    const patchFile = path.join(workspaceRoot, "worker.patch.json");

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
      "task_echo",
      "--kind",
      "task",
      "--title",
      "Echo"
    ]);

    const state0 = await loadCaseState(workspaceRoot, caseId);
    const baseRevision = state0.caseRecord.case_revision.current;

    await setWorkerCommand(workspaceRoot, "patcher", [
      process.execPath,
      "--experimental-strip-types",
      path.resolve("tests/fixtures/worker-patcher.ts")
    ]);
    await setApprovalPolicy(workspaceRoot, { patcher: "auto" });
    await writeFile(
      path.join(workspaceRoot, "patch.env"),
      JSON.stringify({ base_revision: baseRevision, case_id: caseId, node_id: "task_echo" }),
      "utf8"
    );

    const result = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "patcher",
      "--case",
      caseId,
      "--node",
      "task_echo",
      "--output",
      patchFile
    ]);
    expect(result.code).toBe(0);
    expect(result.json.data.patch).not.toBeNull();
    expect(result.json.data.output_file).toBe(patchFile);

    const apply = await runJsonCli(workspaceRoot, ["patch", "apply", "--file", patchFile]);
    expect(apply.code).toBe(0);

    const state1 = await loadCaseState(workspaceRoot, caseId);
    expect(state1.nodes.get("task_echo")?.state).toBe("done");

    const events = await exportEvents(workspaceRoot, caseId);
    const types = events.map((event) => event.type);
    expect(types).toContain("worker.dispatched");
    expect(types).toContain("worker.finished");
    expect(types).toContain("patch.applied");
  });

  it("aborts with worker_timeout and still records worker.finished when the worker hangs", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-worker-cli-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

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
      "task_hang",
      "--kind",
      "task",
      "--title",
      "Hang"
    ]);

    await setWorkerCommand(workspaceRoot, "hang", [
      process.execPath,
      "--experimental-strip-types",
      path.resolve("tests/fixtures/worker-hang.ts")
    ]);
    await setApprovalPolicy(workspaceRoot, { hang: "auto" });

    const result = await runJsonCli(workspaceRoot, [
      "worker",
      "run",
      "--worker",
      "hang",
      "--case",
      caseId,
      "--node",
      "task_hang",
      "--timeout",
      "1"
    ]);

    expect(result.code).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.error.code).toBe("worker_timeout");
    expect(result.json.error.details.timeout_seconds).toBe(1);

    const events = await exportEvents(workspaceRoot, caseId);
    const workerEvents = events.filter((event) => event.type.startsWith("worker."));
    expect(workerEvents.map((event) => event.type)).toEqual([
      "worker.dispatched",
      "worker.finished"
    ]);
    expect((workerEvents[1]?.payload as { status: string }).status).toBe("failed");
  });
});

async function setApprovalPolicy(
  workspaceRoot: string,
  policy: Record<string, string>
): Promise<void> {
  await writeWorkspaceConfig(workspaceRoot, (current) => {
    current.approval_policy = { ...(current.approval_policy ?? {}), ...policy };
  });
}

async function setWorkerCommand(
  workspaceRoot: string,
  workerName: string,
  command: string[]
): Promise<void> {
  await writeWorkspaceConfig(workspaceRoot, (current) => {
    current.workers = {
      ...(current.workers ?? {}),
      [workerName]: { command }
    };
  });
}

async function writeWorkspaceConfig(
  workspaceRoot: string,
  mutate: (current: Record<string, unknown>) => void
): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const configPath = path.join(workspaceRoot, ".casegraph", "config.yaml");
  const raw = await readFile(configPath, "utf8");
  const { parseYaml } = await import("@casegraph/core");
  const parsed = parseYaml<Record<string, unknown>>(raw);
  mutate(parsed);
  await writeFile(configPath, stringifyYaml(parsed), "utf8");
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
