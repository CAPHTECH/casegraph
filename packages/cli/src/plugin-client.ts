import { fileURLToPath } from "node:url";
import {
  appendCaseEvents,
  CaseGraphError,
  type CaseStateView,
  type CommandPluginConfig,
  createEvent,
  createJsonRpcStdioClient,
  defaultActor,
  type EventEnvelope,
  type EventType,
  generateId,
  type JsonRpcStdioClient,
  type MutationContext,
  nowUtc
} from "@casegraph/core";

const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP"];

export function builtInPluginCommand(entryFromImport: URL): string[] {
  return [process.execPath, "--experimental-strip-types", fileURLToPath(entryFromImport)];
}

export interface BuiltInPluginEntry {
  entryFromImport: URL;
  requiredMethod: string;
}

export interface ResolvedPluginHost {
  config?: CommandPluginConfig;
  defaultCommand: string[];
  requiredMethod: string;
}

export interface ResolvePluginHostOptions {
  name: string;
  config?: CommandPluginConfig;
  builtIn?: BuiltInPluginEntry;
  fallbackRequiredMethod: string;
  notConfiguredCode: string;
  notConfiguredMessage: string;
}

export function resolvePluginHost(options: ResolvePluginHostOptions): ResolvedPluginHost {
  if (!(options.config || options.builtIn)) {
    throw new CaseGraphError(options.notConfiguredCode, options.notConfiguredMessage, {
      exitCode: 3
    });
  }
  return {
    config: options.config,
    defaultCommand: options.builtIn ? builtInPluginCommand(options.builtIn.entryFromImport) : [],
    requiredMethod: options.builtIn?.requiredMethod ?? options.fallbackRequiredMethod
  };
}

export interface PluginClientOptions {
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  config?: CommandPluginConfig;
  defaultCommand: string[];
  peerName: string;
  requiredMethod: string;
  capabilityErrorCode: string;
}

export async function openPluginClient(options: PluginClientOptions): Promise<JsonRpcStdioClient> {
  const command =
    options.config?.command && options.config.command.length > 0
      ? options.config.command
      : options.defaultCommand;

  const env = buildPluginEnv(options.env, options.config?.env_allowlist ?? []);
  const client = await createJsonRpcStdioClient({
    command,
    cwd: options.workspaceRoot,
    env,
    peerName: options.peerName
  });

  try {
    await client.request("initialize", {
      client: { name: "cg", version: "0.1.0" }
    });
    const capabilities = await client.request<{ methods?: string[] }>("capabilities.list");
    if (
      !(
        Array.isArray(capabilities.methods) && capabilities.methods.includes(options.requiredMethod)
      )
    ) {
      throw new CaseGraphError(
        options.capabilityErrorCode,
        `${options.peerName} does not advertise ${options.requiredMethod}`,
        { exitCode: 2, details: capabilities }
      );
    }
  } catch (error) {
    await client.request("shutdown").catch(() => undefined);
    await client.close();
    throw error;
  }

  return client;
}

export async function closePluginClient(client: JsonRpcStdioClient): Promise<void> {
  await client.request("shutdown").catch(() => undefined);
  await client.close();
}

export interface PluginAuditEventInput {
  workspaceRoot: string;
  caseId: string;
  mutationContext: MutationContext;
  type: EventType;
  source: NonNullable<EventEnvelope["source"]>;
  payload: Record<string, unknown>;
  fallbackCommandId?: string;
}

export async function appendPluginAuditEvent(input: PluginAuditEventInput): Promise<CaseStateView> {
  const event: EventEnvelope = createEvent({
    case_id: input.caseId,
    timestamp: input.mutationContext.now ?? nowUtc(),
    type: input.type,
    source: input.source,
    command_id: input.mutationContext.commandId ?? input.fallbackCommandId ?? generateId(),
    actor: input.mutationContext.actor ?? defaultActor(),
    payload: input.payload
  });
  return appendCaseEvents(input.workspaceRoot, input.caseId, [event]);
}

export function buildPluginEnv(
  sourceEnv: NodeJS.ProcessEnv,
  allowlist: string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of BASE_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  for (const key of allowlist) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  return env;
}
