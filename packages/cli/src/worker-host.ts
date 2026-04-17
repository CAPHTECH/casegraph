import {
  type ApprovalDecision,
  appendCaseEvents,
  CaseGraphError,
  type CaseStateView,
  createEvent,
  defaultActor,
  type EventEnvelope,
  type GraphPatch,
  generateId,
  loadCaseState,
  loadConfigRecord,
  type MutationContext,
  type NodeRecord,
  nowUtc,
  resolveApprovalDecision,
  validatePatchDocument,
  type WorkerAttachmentRef,
  type WorkerCapabilities,
  type WorkerDispatchedPayload,
  type WorkerExecuteResult,
  type WorkerFinishedPayload,
  type WorkerRelatedNode,
  type WorkerTaskContext,
  type WorkerTaskSnapshot
} from "@casegraph/core";

import { builtInPluginCommand, closePluginClient, openPluginClient } from "./plugin-client.js";

const BUILT_IN_WORKERS: Record<string, { entryFromImport: URL; requiredMethod: string }> = {
  shell: {
    entryFromImport: new URL("../../worker-shell/src/index.ts", import.meta.url),
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

export async function runWorkerExecute(options: WorkerRunOptions): Promise<WorkerRunResult> {
  const config = await loadConfigRecord(options.workspaceRoot);
  const builtIn = BUILT_IN_WORKERS[options.workerName];
  const workerConfig = config.workers?.[options.workerName];
  if (!(workerConfig || builtIn)) {
    throw new CaseGraphError(
      "worker_not_configured",
      `Worker ${options.workerName} is not configured`,
      { exitCode: 3 }
    );
  }

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
    config: workerConfig,
    defaultCommand: builtIn ? builtInPluginCommand(builtIn.entryFromImport) : [],
    peerName: "worker",
    requiredMethod: builtIn?.requiredMethod ?? "worker.execute",
    capabilityErrorCode: "worker_capability_missing"
  });

  try {
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

    const commandId = options.mutationContext.commandId ?? generateId();
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS;

    const dispatchedState = await appendWorkerEvent(options, "worker.dispatched", {
      worker_name: options.workerName,
      node_id: options.nodeId,
      command_id: commandId,
      capabilities,
      approval: decision
    } satisfies WorkerDispatchedPayload);

    const taskSnapshot = buildTaskSnapshot(targetNode);
    const taskContext = buildWorkerTaskContext(state, options.nodeId);

    let executeResult: WorkerExecuteResult;
    try {
      executeResult = await requestWithTimeout(
        client.request<WorkerExecuteResult>("worker.execute", {
          case: {
            case_id: state.caseRecord.case_id,
            title: state.caseRecord.title,
            base_revision: dispatchedState.caseRecord.case_revision.current
          },
          task: taskSnapshot,
          context: taskContext,
          execution_policy: {
            effectful: capabilities.effectful,
            approval:
              decision === "auto" ? "not_required" : decision === "require" ? "required" : "auto",
            timeout_seconds: timeoutSeconds,
            command_id: commandId
          }
        }),
        timeoutSeconds
      );
    } catch (error) {
      if (isWorkerTimeoutError(error)) {
        await appendWorkerEvent(options, "worker.finished", {
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
        } satisfies WorkerFinishedPayload);
        throw new CaseGraphError(
          "worker_timeout",
          `Worker ${options.workerName} did not respond within ${timeoutSeconds}s`,
          { exitCode: 2, details: { timeout_seconds: timeoutSeconds } }
        );
      }
      throw error;
    }

    let patch: GraphPatch | null = null;
    let patchError: unknown = null;
    if (executeResult.patch) {
      const validation = validatePatchDocument(executeResult.patch);
      if (validation.valid && validation.patch) {
        patch = validation.patch;
      } else {
        patchError = validation;
      }
    }

    const finishedStatus: WorkerExecuteResult["status"] = patchError
      ? "failed"
      : executeResult.status;
    const finishedObservations = [...(executeResult.observations ?? [])];
    if (patchError) {
      finishedObservations.push(
        `Worker returned an invalid GraphPatch; rejected: ${JSON.stringify(patchError)}`
      );
    }

    const exitCode = typeof executeResult.exit_code === "number" ? executeResult.exit_code : null;

    const finishedState = await appendWorkerEvent(options, "worker.finished", {
      worker_name: options.workerName,
      node_id: options.nodeId,
      command_id: commandId,
      status: finishedStatus,
      summary: executeResult.summary ?? "",
      artifacts: executeResult.artifacts ?? [],
      observations: finishedObservations,
      patch_id: patch?.patch_id ?? null,
      patch_path: null,
      exit_code: exitCode
    } satisfies WorkerFinishedPayload);

    if (patch) {
      patch = { ...patch, base_revision: finishedState.caseRecord.case_revision.current };
    }

    if (patchError) {
      throw new CaseGraphError(
        "worker_patch_invalid",
        `Worker ${options.workerName} returned an invalid patch`,
        { exitCode: 2, details: patchError }
      );
    }

    return {
      worker_name: options.workerName,
      node_id: options.nodeId,
      status: finishedStatus,
      summary: executeResult.summary ?? "",
      artifacts: executeResult.artifacts ?? [],
      observations: finishedObservations,
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

interface WorkerEventContext {
  workspaceRoot: string;
  caseId: string;
  mutationContext: MutationContext;
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

async function appendWorkerEvent(
  context: WorkerEventContext,
  type: "worker.dispatched" | "worker.finished",
  payload: WorkerDispatchedPayload | WorkerFinishedPayload
): Promise<CaseStateView> {
  const event: EventEnvelope = createEvent({
    case_id: context.caseId,
    timestamp: context.mutationContext.now ?? nowUtc(),
    type,
    source: "worker",
    command_id: context.mutationContext.commandId ?? payload.command_id,
    actor: context.mutationContext.actor ?? defaultActor(),
    payload: payload as unknown as Record<string, unknown>
  });
  return appendCaseEvents(context.workspaceRoot, context.caseId, [event]);
}
