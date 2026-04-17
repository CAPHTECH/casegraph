import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJsonRpcStdioClient } from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    await rm(createdDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("shell worker protocol", () => {
  it("runs a successful command and writes a log artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-worker-"));
    createdDirs.push(workspaceRoot);

    const client = await createWorkerClient(workspaceRoot);
    try {
      const initialize = await client.request<{
        name: string;
        capabilities: { effectful: boolean; shell_access: boolean };
      }>("initialize", { client: { name: "test", version: "0.1.0" } });
      expect(initialize.name).toBe("casegraph-worker-shell");
      expect(initialize.capabilities.effectful).toBe(true);
      expect(initialize.capabilities.shell_access).toBe(true);

      const capabilities = await client.request<{ methods: string[] }>("capabilities.list");
      expect(capabilities.methods).toEqual(["worker.execute"]);

      const caseId = "release-1.8.0";
      const commandId = "cmd_test_ok";
      const result = await client.request<{
        status: string;
        artifacts: Array<{ kind: string; path?: string }>;
        exit_code: number | null;
      }>("worker.execute", {
        case: { case_id: caseId, title: "Release", base_revision: 1 },
        task: {
          node_id: "task_build",
          kind: "task",
          title: "Build",
          description: "",
          state: "todo",
          acceptance: [],
          labels: [],
          metadata: { shell: { command: ["node", "-e", "process.stdout.write('hi')"] } }
        },
        context: { related_nodes: [], attachments: [], metadata: {} },
        execution_policy: {
          effectful: true,
          approval: "required",
          timeout_seconds: 30,
          command_id: commandId
        }
      });

      expect(result.status).toBe("succeeded");
      expect(result.exit_code).toBe(0);
      expect(result.artifacts).toHaveLength(1);
      const logArtifact = result.artifacts[0] ?? { kind: "", path: "" };
      expect(logArtifact.kind).toBe("log");
      const logFile = path.join(workspaceRoot, logArtifact.path as string);
      const contents = await readFile(logFile, "utf8");
      expect(contents).toContain("exit_code: 0");
      expect(contents).toContain("hi");
    } finally {
      await client.close();
    }
  });

  it("returns status=failed when task metadata lacks a shell command", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-worker-"));
    createdDirs.push(workspaceRoot);

    const client = await createWorkerClient(workspaceRoot);
    try {
      await client.request("initialize", { client: { name: "test", version: "0.1.0" } });
      const result = await client.request<{
        status: string;
        observations: string[];
        artifacts: unknown[];
      }>("worker.execute", {
        case: { case_id: "c", title: "c", base_revision: 1 },
        task: {
          node_id: "task_no_cmd",
          kind: "task",
          title: "No command",
          description: "",
          state: "todo",
          acceptance: [],
          labels: [],
          metadata: {}
        },
        context: { related_nodes: [], attachments: [], metadata: {} },
        execution_policy: {
          effectful: true,
          approval: "required",
          timeout_seconds: 30,
          command_id: "cmd_no_cmd"
        }
      });
      expect(result.status).toBe("failed");
      expect(result.artifacts).toHaveLength(0);
      expect(result.observations.join(" ")).toContain("No shell command");
    } finally {
      await client.close();
    }
  });

  it("times out a runaway command", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "casegraph-worker-"));
    createdDirs.push(workspaceRoot);

    const client = await createWorkerClient(workspaceRoot);
    try {
      await client.request("initialize", { client: { name: "test", version: "0.1.0" } });
      const result = await client.request<{
        status: string;
        observations: string[];
        exit_code: number | null;
      }>("worker.execute", {
        case: { case_id: "c", title: "c", base_revision: 1 },
        task: {
          node_id: "task_runaway",
          kind: "task",
          title: "Runaway",
          description: "",
          state: "todo",
          acceptance: [],
          labels: [],
          metadata: {
            shell: { command: ["node", "-e", "setInterval(() => {}, 1000)"] }
          }
        },
        context: { related_nodes: [], attachments: [], metadata: {} },
        execution_policy: {
          effectful: true,
          approval: "required",
          timeout_seconds: 1,
          command_id: "cmd_timeout"
        }
      });
      expect(result.status).toBe("failed");
      expect(result.observations.join(" ")).toContain("timeout");
    } finally {
      await client.close();
    }
  }, 10_000);
});

async function createWorkerClient(workspaceRoot: string) {
  return createJsonRpcStdioClient({
    command: [
      process.execPath,
      "--experimental-strip-types",
      path.resolve("packages/worker-shell/src/index.ts")
    ],
    cwd: workspaceRoot,
    env: process.env,
    peerName: "worker"
  });
}
