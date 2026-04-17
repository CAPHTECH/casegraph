import { createJsonRpcStdioClient, type JsonRpcStdioClient } from "@caphtech/casegraph-core";
import { expect } from "vitest";

export type PluginRole = "importer" | "sink" | "worker";

export interface ConformanceOptions {
  command: string[];
  cwd: string;
  role: PluginRole;
  env?: NodeJS.ProcessEnv;
}

const REQUIRED_METHODS: Record<PluginRole, string[]> = {
  importer: ["importer.ingest"],
  sink: ["sink.planProjection", "sink.applyProjection", "sink.pullChanges"],
  worker: ["worker.execute"]
};

export async function runPluginConformance(options: ConformanceOptions): Promise<void> {
  const client = await createJsonRpcStdioClient({
    command: options.command,
    cwd: options.cwd,
    env: options.env ?? process.env,
    peerName: `conformance_${options.role}`
  });

  try {
    await assertInitialize(client);
    await assertHealth(client);
    await assertCapabilities(client, options.role);
    await assertMethodNotFound(client);
    await assertShutdown(client);
  } finally {
    await client.close();
  }
}

async function assertInitialize(client: JsonRpcStdioClient): Promise<void> {
  const response = await client.request<{
    name?: unknown;
    version?: unknown;
    capabilities?: unknown;
  }>("initialize", {
    client: { name: "conformance", version: "0.0.0" }
  });
  expect(typeof response.name).toBe("string");
  expect(typeof response.version).toBe("string");
  expect(typeof response.capabilities).toBe("object");
}

async function assertHealth(client: JsonRpcStdioClient): Promise<void> {
  const response = await client.request<{ ok?: unknown }>("health");
  expect(response.ok).toBe(true);
}

async function assertCapabilities(client: JsonRpcStdioClient, role: PluginRole): Promise<void> {
  const response = await client.request<{ methods?: unknown }>("capabilities.list");
  expect(Array.isArray(response.methods)).toBe(true);
  const methods = response.methods as string[];
  for (const required of REQUIRED_METHODS[role]) {
    expect(methods).toContain(required);
  }
}

async function assertMethodNotFound(client: JsonRpcStdioClient): Promise<void> {
  let thrown: unknown;
  try {
    await client.request("conformance.not.a.method");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
}

async function assertShutdown(client: JsonRpcStdioClient): Promise<void> {
  const response = await client.request<{ ok?: unknown }>("shutdown");
  expect(response.ok).toBe(true);
}
