import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { runCli } from "@casegraph/cli/app";
import { loadCaseState, parseYaml, stringifyYaml } from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];
const createdServers: Server[] = [];

afterEach(async () => {
  while (createdServers.length > 0) {
    await closeServer(createdServers.pop() as Server);
  }
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("cg worker run --worker local-llm", () => {
  it("extracts a patch from the Ollama response and lets the patch apply", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-local-llm-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setupCase(workspaceRoot, caseId);

    const patch = {
      patch_id: "patch_mock_llm",
      spec_version: "0.1-draft",
      case_id: caseId,
      base_revision: 0,
      summary: "mock llm marks task done",
      generator: { kind: "worker", name: "local-llm-mock" },
      operations: [{ op: "change_state", node_id: "task_refactor", state: "done" }]
    };
    const ollamaResponse = `here is the patch\n\`\`\`casegraph-patch\n${JSON.stringify(patch)}\n\`\`\`\n`;
    const { server, port } = await startOllamaMock((req, res) => {
      if (req.url === "/api/generate" && req.method === "POST") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ response: ollamaResponse }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    createdServers.push(server);

    await configureLocalLlm(workspaceRoot);

    const patchPath = path.join(workspaceRoot, "out.patch.json");
    const result = await runJsonCli(workspaceRoot, port, [
      "worker",
      "run",
      "--worker",
      "local-llm",
      "--case",
      caseId,
      "--node",
      "task_refactor",
      "--output",
      patchPath
    ]);
    expect(result.code).toBe(0);
    expect(result.json.data.status).toBe("succeeded");
    expect(result.json.data.patch).not.toBeNull();

    const apply = await runJsonCli(workspaceRoot, port, ["patch", "apply", "--file", patchPath]);
    expect(apply.code).toBe(0);

    const state = await loadCaseState(workspaceRoot, caseId);
    expect(state.nodes.get("task_refactor")?.state).toBe("done");
  });

  it("returns status=failed when the Ollama host is unreachable", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-local-llm-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setupCase(workspaceRoot, caseId);
    await configureLocalLlm(workspaceRoot);

    // Point at a port we know nobody is listening on.
    const result = await runJsonCli(workspaceRoot, 1, [
      "worker",
      "run",
      "--worker",
      "local-llm",
      "--case",
      caseId,
      "--node",
      "task_refactor"
    ]);
    expect(result.code).toBe(0);
    expect(result.json.data.status).toBe("failed");
    expect(result.json.data.patch).toBeNull();
    expect(result.json.data.summary).toMatch(/unreachable/i);
  });

  it("retries once when the first response has no fenced block and succeeds on retry", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-local-llm-");
    createdWorkspaces.push(workspaceRoot);
    const caseId = "demo";

    await setupCase(workspaceRoot, caseId);

    const patch = {
      patch_id: "patch_retry_success",
      spec_version: "0.1-draft",
      case_id: caseId,
      base_revision: 0,
      summary: "retry ok",
      operations: [{ op: "change_state", node_id: "task_refactor", state: "done" }]
    };
    let requestCount = 0;
    const { server, port } = await startOllamaMock((req, res) => {
      if (req.url === "/api/generate" && req.method === "POST") {
        requestCount += 1;
        res.setHeader("content-type", "application/json");
        if (requestCount === 1) {
          res.end(JSON.stringify({ response: "I thought about it but won't emit a patch." }));
        } else {
          res.end(
            JSON.stringify({
              response: `\`\`\`casegraph-patch\n${JSON.stringify(patch)}\n\`\`\``
            })
          );
        }
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    createdServers.push(server);

    await configureLocalLlm(workspaceRoot);

    const patchPath = path.join(workspaceRoot, "out.patch.json");
    const result = await runJsonCli(workspaceRoot, port, [
      "worker",
      "run",
      "--worker",
      "local-llm",
      "--case",
      caseId,
      "--node",
      "task_refactor",
      "--output",
      patchPath
    ]);

    expect(result.code).toBe(0);
    expect(result.json.data.status).toBe("succeeded");
    expect(result.json.data.patch).not.toBeNull();
    expect(result.json.data.observations.join(" ")).toMatch(/Retry 1 after \(no_fence_found\)/);
    expect(requestCount).toBe(2);
  });
});

async function setupCase(workspaceRoot: string, caseId: string): Promise<void> {
  await runJsonCli(workspaceRoot, 0, [
    "case",
    "new",
    "--id",
    caseId,
    "--title",
    "Demo",
    "--description",
    ""
  ]);
  await runJsonCli(workspaceRoot, 0, [
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

async function configureLocalLlm(workspaceRoot: string): Promise<void> {
  const configPath = path.join(workspaceRoot, ".casegraph", "config.yaml");
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(configPath, "utf8");
  const parsed = parseYaml<Record<string, unknown>>(raw);
  parsed.workers = {
    ...((parsed.workers as Record<string, unknown> | undefined) ?? {}),
    "local-llm": {
      env_allowlist: ["OLLAMA_HOST", "CASEGRAPH_LOCAL_LLM_MODEL"]
    }
  };
  await writeFile(configPath, stringifyYaml(parsed), "utf8");
}

async function startOllamaMock(
  handler: Parameters<typeof createServer>[0]
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function runJsonCli(workspaceRoot: string, ollamaPort: number, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["--format", "json", ...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      OLLAMA_HOST: `http://127.0.0.1:${ollamaPort}`
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
