import {
  CaseGraphError,
  type CaseStateView,
  deriveProjectionMappings,
  type GraphPatch,
  type JsonRpcStdioClient,
  loadCaseState,
  loadConfigRecord,
  type MutationContext,
  type ProjectionMapping,
  type ProjectionPulledPayload,
  type ProjectionPushedPayload,
  type SinkApplyProjectionResult,
  type SinkCapabilities,
  type SinkOperation,
  type SinkOperationKind,
  type SinkPlanProjectionResult,
  type SinkPullChangesResult,
  selectProjectionTargets,
  validatePatchDocument
} from "@casegraph/core";

import {
  appendPluginAuditEvent,
  type BuiltInPluginEntry,
  closePluginClient,
  openPluginClient,
  resolvePluginHost
} from "./plugin-client.js";

const BUILT_IN_SINKS: Record<string, BuiltInPluginEntry> = {
  markdown: {
    entryFromImport: new URL("../../sink-markdown/src/index.ts", import.meta.url),
    requiredMethod: "sink.planProjection"
  }
};

export interface SinkPushOptions {
  workspaceRoot: string;
  caseId: string;
  sinkName: string;
  env: NodeJS.ProcessEnv;
  apply: boolean;
  mutationContext: MutationContext;
}

export interface SinkPushResult {
  sink_name: string;
  plan: SinkOperation[];
  plan_warnings: string[];
  applied: boolean;
  apply_warnings: string[];
  revision: CaseStateView["caseRecord"]["case_revision"] | null;
  plan_summary: Record<SinkOperationKind, number>;
}

export interface SinkPullOptions {
  workspaceRoot: string;
  caseId: string;
  sinkName: string;
  env: NodeJS.ProcessEnv;
  mutationContext: MutationContext;
}

export interface SinkPullResult {
  sink_name: string;
  patch: GraphPatch | null;
  item_count: number;
  warnings: string[];
  revision: CaseStateView["caseRecord"]["case_revision"];
}

export async function runSinkPush(options: SinkPushOptions): Promise<SinkPushResult> {
  return withSinkClient(options, async (client) => {
    const state = await loadCaseState(options.workspaceRoot, options.caseId);
    const targets = selectProjectionTargets(state);
    const mapping = filterMappingsForSink(deriveProjectionMappings(state.events), options.sinkName);
    const capabilities = await client.request<{ capabilities?: SinkCapabilities }>("initialize", {
      client: { name: "cg", version: "0.1.0" }
    });

    const planResult = await client.request<SinkPlanProjectionResult>("sink.planProjection", {
      case_id: options.caseId,
      base_revision: state.caseRecord.case_revision.current,
      actionable: targets.actionable,
      waiting: targets.waiting,
      mapping
    });

    const planSummary = summarizePlan(planResult.plan);

    if (!options.apply) {
      return {
        sink_name: options.sinkName,
        plan: planResult.plan,
        plan_warnings: planResult.warnings ?? [],
        applied: false,
        apply_warnings: [],
        revision: state.caseRecord.case_revision,
        plan_summary: planSummary
      };
    }

    const applyResult = await client.request<SinkApplyProjectionResult>("sink.applyProjection", {
      case_id: options.caseId,
      plan: planResult.plan
    });

    const pushedPayload: ProjectionPushedPayload = {
      sink_name: options.sinkName,
      plan_summary: { op_counts: planSummary },
      mapping_deltas: applyResult.mapping_deltas,
      capabilities: capabilities.capabilities ?? { push: true, pull: false, dry_run: false }
    };
    const nextState = await appendPluginAuditEvent({
      workspaceRoot: options.workspaceRoot,
      caseId: options.caseId,
      mutationContext: options.mutationContext,
      type: "projection.pushed",
      source: "sync",
      payload: pushedPayload as unknown as Record<string, unknown>
    });

    return {
      sink_name: options.sinkName,
      plan: applyResult.applied,
      plan_warnings: planResult.warnings ?? [],
      applied: true,
      apply_warnings: applyResult.warnings ?? [],
      revision: nextState.caseRecord.case_revision,
      plan_summary: planSummary
    };
  });
}

export async function runSinkPull(options: SinkPullOptions): Promise<SinkPullResult> {
  return withSinkClient(options, async (client) => {
    const state = await loadCaseState(options.workspaceRoot, options.caseId);
    const mapping = filterMappingsForSink(deriveProjectionMappings(state.events), options.sinkName);

    const pullResult = await client.request<SinkPullChangesResult & { patch: unknown }>(
      "sink.pullChanges",
      {
        case_id: options.caseId,
        base_revision: state.caseRecord.case_revision.current,
        mapping
      }
    );

    let patch: GraphPatch | null = null;
    if (pullResult.patch) {
      const validation = validatePatchDocument(pullResult.patch);
      if (!(validation.valid && validation.patch)) {
        throw new CaseGraphError("sink_patch_invalid", "Sink returned invalid patch", {
          exitCode: 2,
          details: validation
        });
      }
      patch = validation.patch;
    }

    const pulledPayload: ProjectionPulledPayload = {
      sink_name: options.sinkName,
      item_count: pullResult.item_count,
      patch_id: patch?.patch_id ?? "",
      mapping_deltas: pullResult.mapping_deltas
    };
    const nextState = await appendPluginAuditEvent({
      workspaceRoot: options.workspaceRoot,
      caseId: options.caseId,
      mutationContext: options.mutationContext,
      type: "projection.pulled",
      source: "sync",
      payload: pulledPayload as unknown as Record<string, unknown>
    });

    if (patch) {
      patch = { ...patch, base_revision: nextState.caseRecord.case_revision.current };
    }

    return {
      sink_name: options.sinkName,
      patch,
      item_count: pullResult.item_count,
      warnings: pullResult.warnings ?? [],
      revision: nextState.caseRecord.case_revision
    };
  });
}

interface SinkClientOptions {
  workspaceRoot: string;
  sinkName: string;
  env: NodeJS.ProcessEnv;
}

async function withSinkClient<T>(
  options: SinkClientOptions,
  run: (client: JsonRpcStdioClient) => Promise<T>
): Promise<T> {
  const config = await loadConfigRecord(options.workspaceRoot);
  const resolved = resolvePluginHost({
    name: options.sinkName,
    config: config.sinks?.[options.sinkName],
    builtIn: BUILT_IN_SINKS[options.sinkName],
    fallbackRequiredMethod: "sink.planProjection",
    notConfiguredCode: "sink_not_configured",
    notConfiguredMessage: `Sink ${options.sinkName} is not configured`
  });

  const client = await openPluginClient({
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    config: resolved.config,
    defaultCommand: resolved.defaultCommand,
    peerName: "sink",
    requiredMethod: resolved.requiredMethod,
    capabilityErrorCode: "sink_capability_missing"
  });

  try {
    return await run(client);
  } finally {
    await closePluginClient(client);
  }
}

function filterMappingsForSink(
  mappings: ProjectionMapping[],
  sinkName: string
): ProjectionMapping[] {
  return mappings.filter((mapping) => mapping.sink_name === sinkName);
}

function summarizePlan(plan: SinkOperation[]): Record<SinkOperationKind, number> {
  const counts: Record<SinkOperationKind, number> = {
    upsert_item: 0,
    complete_item: 0,
    archive_item: 0,
    set_label: 0,
    set_due: 0
  };
  for (const op of plan) {
    counts[op.op] += 1;
  }
  return counts;
}
