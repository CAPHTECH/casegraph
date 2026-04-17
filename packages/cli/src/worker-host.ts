import {
  type ApprovalDecision,
  CaseGraphError,
  type CaseStateView,
  type GraphPatch,
  generateId,
  type JsonRpcStdioClient,
  loadCaseState,
  loadConfigRecord,
  type MutationContext,
  type NodeRecord,
  resolveApprovalDecision,
  validatePatchDocument,
  type WorkerAttachmentRef,
  type WorkerCapabilities,
  type WorkerExecuteResult,
  type WorkerFinishedPayload,
  type WorkerRelatedNode,
  type WorkerTaskContext,
  type WorkerTaskSnapshot
} from "@caphtech/casegraph-core";

import {
  appendPluginAuditEvent,
  type BuiltInPluginEntry,
  closePluginClient,
  openPluginClient,
  resolvePluginHost
} from "./plugin-client.js";

const BUILT_IN_WORKERS: Record<string, BuiltInPluginEntry> = {
  shell: {
    localEntryFromImport: new URL("../../worker-shell/src/index.ts", import.meta.url),
    packageName: "@caphtech/casegraph-worker-shell",
    requiredMethod: "worker.execute"
  },
  "code-agent": {
    localEntryFromImport: new URL("../../worker-code-agent/src/index.ts", import.meta.url),
    packageName: "@caphtech/casegraph-worker-code-agent",
    requiredMethod: "worker.execute"
  },
  "local-llm": {
    localEntryFromImport: new URL("../../worker-local-llm/src/index.ts", import.meta.url),
    packageName: "@caphtech/casegraph-worker-local-llm",
    requiredMethod: "worker.execute"
  }
};

const DEFAULT_WORKER_TIMEOUT_SECONDS = 60;
const WORKER_TIMEOUT_MARKER = Symbol("worker_timeout");

export interface WorkerRunOptions {
  workspaceRoot: string;
  caseId: string;
  nodeId: string;
  workerName: string;
  env: NodeJS.ProcessEnv;
  approve: boolean;
  mutationContext: MutationContext;
  timeoutSeconds?: number;
}

export interface WorkerRunResult {
  worker_name: string;
  node_id: string;
  status: WorkerExecuteResult["status"];
  summary: string;
  artifacts: WorkerExecuteResult["artifacts"];
  observations: string[];
  warnings: string[];
  exit_code: number | null;
  patch: GraphPatch | null;
  approval: ApprovalDecision;
  revision: CaseStateView["caseRecord"]["case_revision"];
}

interface ApprovalOutcome {
  capabilities: WorkerCapabilities;
  decision: ApprovalDecision;
}

interface PatchReview {
  patch: GraphPatch | null;
  patchError: unknown;
}

export async function runWorkerExecute(options: WorkerRunOptions): Promise<WorkerRunResult> {
  const config = await loadConfigRecord(options.workspaceRoot);
  const resolved = resolvePluginHost({
    name: options.workerName,
    config: config.workers?.[options.workerName],
    builtIn: BUILT_IN_WORKERS[options.workerName],
    fallbackRequiredMethod: "worker.execute",
    notConfiguredCode: "worker_not_configured",
    notConfiguredMessage: `Worker ${options.workerName} is not configured`
  });

  const state = await loadCaseState(options.workspaceRoot, options.caseId);
  const targetNode = state.nodes.get(options.nodeId);
  if (!targetNode) {
    throw new CaseGraphError(
      "worker_target_not_found",
      `Node ${options.nodeId} not found in case ${options.caseId}`,
      { exitCode: 3 }
    );
  }

  const client = await openPluginClient({
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    config: resolved.config,
    defaultCommand: resolved.defaultCommand,
    peerName: "worker",
    requiredMethod: resolved.requiredMethod,
    capabilityErrorCode: "worker_capability_missing"
  });

  try {
    const { capabilities, decision } = await negotiateApprovalDecision(client, options, config);
    const commandId = options.mutationContext.commandId ?? generateId();
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS;

    const dispatchedState = await appendPluginAuditEvent({
      workspaceRoot: options.workspaceRoot,
      caseId: options.caseId,
      mutationContext: options.mutationContext,
      type: "worker.dispatched",
      source: "worker",
      payload: {
        worker_name: options.workerName,
        node_id: options.nodeId,
        command_id: commandId,
        capabilities,
        approval: decision
      } as unknown as Record<string, unknown>,
      fallbackCommandId: commandId
    });

    const executeResult = await invokeWorkerExecute({
      client,
      options,
      capabilities,
      decision,
      commandId,
      timeoutSeconds,
      dispatchedState,
      state,
      targetNode
    });

    const review = reviewReturnedPatch(executeResult);
    const observations = buildObservations(executeResult, review.patchError);
    const exitCode = typeof executeResult.exit_code === "number" ? executeResult.exit_code : null;
    const finishedStatus: WorkerExecuteResult["status"] = review.patchError
      ? "failed"
      : executeResult.status;

    const finishedState = await appendPluginAuditEvent({
      workspaceRoot: options.workspaceRoot,
      caseId: options.caseId,
      mutationContext: options.mutationContext,
      type: "worker.finished",
      source: "worker",
      payload: {
        worker_name: options.workerName,
        node_id: options.nodeId,
        command_id: commandId,
        status: finishedStatus,
        summary: executeResult.summary ?? "",
        artifacts: executeResult.artifacts ?? [],
        observations,
        patch_id: review.patch?.patch_id ?? null,
        patch_path: null,
        exit_code: exitCode
      } as unknown as Record<string, unknown>,
      fallbackCommandId: commandId
    });

    if (review.patchError) {
      throw new CaseGraphError(
        "worker_patch_invalid",
        `Worker ${options.workerName} returned an invalid patch`,
        { exitCode: 2, details: review.patchError }
      );
    }

    const patch = review.patch
      ? { ...review.patch, base_revision: finishedState.caseRecord.case_revision.current }
      : null;

    return {
      worker_name: options.workerName,
      node_id: options.nodeId,
      status: finishedStatus,
      summary: executeResult.summary ?? "",
      artifacts: executeResult.artifacts ?? [],
      observations,
      warnings: executeResult.warnings ?? [],
      exit_code: exitCode,
      patch,
      approval: decision,
      revision: finishedState.caseRecord.case_revision
    };
  } finally {
    await closePluginClient(client);
  }
}

async function negotiateApprovalDecision(
  client: JsonRpcStdioClient,
  options: WorkerRunOptions,
  config: Awaited<ReturnType<typeof loadConfigRecord>>
): Promise<ApprovalOutcome> {
  const initResponse = await client.request<{ capabilities?: WorkerCapabilities }>("initialize", {
    client: { name: "cg", version: "0.1.0" }
  });
  const capabilities: WorkerCapabilities = initResponse.capabilities ?? { effectful: true };
  const decision = resolveApprovalDecision(
    config.approval_policy,
    options.workerName,
    capabilities.effectful
  );

  if (decision === "deny") {
    throw new CaseGraphError(
      "worker_approval_denied",
      `Approval policy denies worker ${options.workerName}`,
      { exitCode: 2, details: { approval_policy: config.approval_policy } }
    );
  }

  if (decision === "require" && !options.approve) {
    throw new CaseGraphError(
      "worker_approval_required",
      `Worker ${options.workerName} is effectful; pass --approve to run it`,
      { exitCode: 2, details: { capabilities } }
    );
  }

  return { capabilities, decision };
}

interface InvokeWorkerExecuteInput {
  client: JsonRpcStdioClient;
  options: WorkerRunOptions;
  capabilities: WorkerCapabilities;
  decision: ApprovalDecision;
  commandId: string;
  timeoutSeconds: number;
  dispatchedState: CaseStateView;
  state: CaseStateView;
  targetNode: NodeRecord;
}

async function invokeWorkerExecute(input: InvokeWorkerExecuteInput): Promise<WorkerExecuteResult> {
  const executionApproval =
    input.decision === "auto" ? "not_required" : input.decision === "require" ? "required" : "auto";
  try {
    return await requestWithTimeout(
      input.client.request<WorkerExecuteResult>("worker.execute", {
        case: {
          case_id: input.state.caseRecord.case_id,
          title: input.state.caseRecord.title,
          base_revision: input.dispatchedState.caseRecord.case_revision.current
        },
        task: buildTaskSnapshot(input.targetNode),
        context: buildWorkerTaskContext(input.state, input.options.nodeId),
        execution_policy: {
          effectful: input.capabilities.effectful,
          approval: executionApproval,
          timeout_seconds: input.timeoutSeconds,
          command_id: input.commandId
        }
      }),
      input.timeoutSeconds
    );
  } catch (error) {
    if (!isWorkerTimeoutError(error)) {
      throw error;
    }
    await recordWorkerTimeoutFinished(input.options, input.commandId, input.timeoutSeconds);
    throw new CaseGraphError(
      "worker_timeout",
      `Worker ${input.options.workerName} did not respond within ${input.timeoutSeconds}s`,
      { exitCode: 2, details: { timeout_seconds: input.timeoutSeconds } }
    );
  }
}

async function recordWorkerTimeoutFinished(
  options: WorkerRunOptions,
  commandId: string,
  timeoutSeconds: number
): Promise<void> {
  const payload: WorkerFinishedPayload = {
    worker_name: options.workerName,
    node_id: options.nodeId,
    command_id: commandId,
    status: "failed",
    summary: `Worker timed out after ${timeoutSeconds}s`,
    artifacts: [],
    observations: [`Worker did not respond within ${timeoutSeconds}s; client aborted.`],
    patch_id: null,
    patch_path: null,
    exit_code: null
  };
  await appendPluginAuditEvent({
    workspaceRoot: options.workspaceRoot,
    caseId: options.caseId,
    mutationContext: options.mutationContext,
    type: "worker.finished",
    source: "worker",
    payload: payload as unknown as Record<string, unknown>,
    fallbackCommandId: commandId
  });
}

function reviewReturnedPatch(executeResult: WorkerExecuteResult): PatchReview {
  if (!executeResult.patch) {
    return { patch: null, patchError: null };
  }
  const validation = validatePatchDocument(executeResult.patch);
  if (validation.valid && validation.patch) {
    return { patch: validation.patch, patchError: null };
  }
  return { patch: null, patchError: validation };
}

function buildObservations(executeResult: WorkerExecuteResult, patchError: unknown): string[] {
  const observations = [...(executeResult.observations ?? [])];
  if (patchError) {
    observations.push(
      `Worker returned an invalid GraphPatch; rejected: ${JSON.stringify(patchError)}`
    );
  }
  return observations;
}

function buildTaskSnapshot(node: NodeRecord): WorkerTaskSnapshot {
  return {
    node_id: node.node_id,
    kind: node.kind,
    title: node.title,
    description: node.description,
    state: node.state,
    acceptance: [...node.acceptance],
    labels: [...node.labels],
    metadata: { ...node.metadata }
  };
}

export function buildWorkerTaskContext(state: CaseStateView, nodeId: string): WorkerTaskContext {
  const related: WorkerRelatedNode[] = [];
  const attachmentRefs: WorkerAttachmentRef[] = [];
  const seenNodes = new Set<string>();

  for (const edge of state.edges.values()) {
    if (edge.source_id !== nodeId) {
      continue;
    }
    if (edge.type !== "depends_on" && edge.type !== "waits_for" && edge.type !== "verifies") {
      continue;
    }
    const target = state.nodes.get(edge.target_id);
    if (!target || seenNodes.has(target.node_id)) {
      continue;
    }
    seenNodes.add(target.node_id);
    related.push({
      node_id: target.node_id,
      kind: target.kind,
      state: target.state,
      title: target.title,
      relation: edge.type
    });

    for (const attachment of state.attachments.values()) {
      if (attachment.evidence_node_id === target.node_id) {
        attachmentRefs.push({
          attachment_id: attachment.attachment_id,
          evidence_node_id: attachment.evidence_node_id,
          path_or_url: attachment.path_or_url,
          mime_type: attachment.mime_type
        });
      }
    }
  }

  return {
    related_nodes: related,
    attachments: attachmentRefs,
    metadata: {}
  };
}

async function requestWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject({ [WORKER_TIMEOUT_MARKER]: true }), timeoutSeconds * 1000);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isWorkerTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && WORKER_TIMEOUT_MARKER in error;
}
