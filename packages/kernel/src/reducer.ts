import { CaseGraphError } from "./errors.js";
import { cloneRecord, dueDateValue, metadataPriorityValue, sanitizeNodeChanges } from "./helpers.js";
import { applyPatchOperationsToDraft } from "./patch.js";
import type {
  AttachmentRecord,
  BlockedItem,
  CaseCounts,
  CaseRecord,
  CaseStateView,
  EdgeRecord,
  EventEnvelope,
  FrontierItem,
  GraphPatch,
  NodeRecord
} from "./types.js";
import { deriveNodeStates, validateGraph } from "./validation.js";

export function replayCaseEvents(events: EventEnvelope[]): CaseStateView {
  const nodes = new Map<string, NodeRecord>();
  const edges = new Map<string, EdgeRecord>();
  const attachments = new Map<string, AttachmentRecord>();
  let caseRecord: CaseRecord | null = null;

  for (const event of events) {
    switch (event.type) {
      case "case.created": {
        caseRecord = replayCaseCreatedEvent(event);
        break;
      }

      case "case.updated": {
        caseRecord = replayCaseUpdatedEvent(caseRecord, event);
        break;
      }

      case "node.added": {
        replayNodeAddedEvent(nodes, event);
        break;
      }

      case "node.updated": {
        replayNodeUpdatedEvent(nodes, event);
        break;
      }

      case "node.state_changed": {
        replayNodeStateChangedEvent(nodes, event);
        break;
      }

      case "edge.added": {
        replayEdgeAddedEvent(edges, event);
        break;
      }

      case "edge.removed": {
        replayEdgeRemovedEvent(edges, event);
        break;
      }

      case "event.recorded": {
        replayEventRecordedEvent(nodes, event);
        break;
      }

      case "evidence.attached": {
        replayEvidenceAttachedEvent(nodes, edges, attachments, event);
        break;
      }

      case "projection.pushed":
      case "projection.pulled":
      case "worker.dispatched":
      case "worker.finished": {
        ensureCaseLoaded(caseRecord, event.type);
        break;
      }

      case "patch.applied": {
        ensureCaseLoaded(caseRecord, event.type);
        caseRecord = replayPatchAppliedEvent(caseRecord, nodes, edges, attachments, event);
        break;
      }

      default:
        throw new CaseGraphError(
          "unsupported_event_type",
          `Unsupported event type ${(event as EventEnvelope).type}`,
          { exitCode: 2 }
        );
    }
  }

  if (!caseRecord) {
    throw new CaseGraphError("case_not_initialized", "Case replay missing case.created", {
      exitCode: 2
    });
  }

  const lastEvent = events.at(-1);
  caseRecord.case_revision = {
    current: events.length,
    last_event_id: lastEvent?.event_id ?? null
  };
  if (lastEvent) {
    caseRecord.updated_at = lastEvent.timestamp;
  }

  const validation = validateGraph(nodes, edges, attachments);
  const derived = deriveNodeStates(nodes, edges, validation);

  return {
    caseRecord,
    nodes,
    edges,
    attachments,
    events,
    derived,
    validation
  };
}

function replayCaseCreatedEvent(event: EventEnvelope): CaseRecord {
  const nextCase = cloneRecord(event.payload.case as Omit<CaseRecord, "case_revision">);
  return {
    ...nextCase,
    case_revision: { current: 0, last_event_id: null }
  };
}

function replayCaseUpdatedEvent(caseRecord: CaseRecord | null, event: EventEnvelope): CaseRecord {
  ensureCaseLoaded(caseRecord, event.type);
  const rawChanges = event.payload.changes;
  const changes =
    typeof rawChanges === "object" && rawChanges !== null
      ? (rawChanges as Partial<CaseRecord>)
      : {};
  return Object.assign({}, caseRecord, changes, {
    case_revision: caseRecord.case_revision
  });
}

function replayNodeAddedEvent(nodes: Map<string, NodeRecord>, event: EventEnvelope): void {
  const nextNode = cloneRecord(event.payload.node as NodeRecord);
  nodes.set(nextNode.node_id, nextNode);
}

function replayNodeUpdatedEvent(nodes: Map<string, NodeRecord>, event: EventEnvelope): void {
  const nodeId = event.payload.node_id as string;
  const existingNode = requireNodeForReplay(nodes, nodeId, "Node");
  const changes = sanitizeNodeChanges(
    (event.payload.changes as Partial<
      Pick<NodeRecord, "title" | "description" | "labels" | "acceptance" | "metadata" | "extensions">
    >) ?? {}
  );
  nodes.set(nodeId, {
    ...existingNode,
    ...changes,
    updated_at: event.timestamp
  });
}

function replayNodeStateChangedEvent(nodes: Map<string, NodeRecord>, event: EventEnvelope): void {
  const nodeId = event.payload.node_id as string;
  const existingNode = requireNodeForReplay(nodes, nodeId, "Node");
  nodes.set(nodeId, {
    ...existingNode,
    state: event.payload.state as NodeRecord["state"],
    metadata: {
      ...existingNode.metadata,
      ...((event.payload.metadata as Record<string, unknown> | undefined) ?? {})
    },
    updated_at: event.timestamp
  });
}

function replayEdgeAddedEvent(edges: Map<string, EdgeRecord>, event: EventEnvelope): void {
  const nextEdge = cloneRecord(event.payload.edge as EdgeRecord);
  edges.set(nextEdge.edge_id, nextEdge);
}

function replayEdgeRemovedEvent(edges: Map<string, EdgeRecord>, event: EventEnvelope): void {
  const edgeId = event.payload.edge_id as string;
  edges.delete(edgeId);
}

function replayEventRecordedEvent(nodes: Map<string, NodeRecord>, event: EventEnvelope): void {
  const nodeId = event.payload.node_id as string;
  const existingNode = requireNodeForReplay(nodes, nodeId, "Event node");
  nodes.set(nodeId, {
    ...existingNode,
    state: "done",
    updated_at: event.timestamp
  });
}

function replayEvidenceAttachedEvent(
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  attachments: Map<string, AttachmentRecord>,
  event: EventEnvelope
): void {
  const evidenceNode = cloneRecord(event.payload.node as NodeRecord);
  nodes.set(evidenceNode.node_id, evidenceNode);

  const verifiesEdge = event.payload.verifies_edge as EdgeRecord | undefined;
  if (verifiesEdge) {
    edges.set(verifiesEdge.edge_id, cloneRecord(verifiesEdge));
  }

  const attachment = event.payload.attachment as AttachmentRecord | undefined;
  if (attachment) {
    attachments.set(attachment.attachment_id, cloneRecord(attachment));
  }
}

function replayPatchAppliedEvent(
  caseRecord: CaseRecord,
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  attachments: Map<string, AttachmentRecord>,
  event: EventEnvelope
): CaseRecord {
  const patch = cloneRecord(event.payload.patch as GraphPatch);
  const draft = {
    caseRecord,
    nodes,
    edges,
    attachments
  };
  const draftErrors = applyPatchOperationsToDraft(draft, patch, event.timestamp);

  if (draftErrors.length > 0) {
    throw new CaseGraphError(
      "patch_replay_failed",
      `Patch ${patch.patch_id} failed during replay`,
      {
        exitCode: 2,
        details: draftErrors
      }
    );
  }

  return draft.caseRecord;
}

function requireNodeForReplay(
  nodes: Map<string, NodeRecord>,
  nodeId: string,
  label: string
): NodeRecord {
  const existingNode = nodes.get(nodeId);
  if (existingNode) {
    return existingNode;
  }

  throw new CaseGraphError("node_not_found", `${label} ${nodeId} not found during replay`, {
    exitCode: 3
  });
}

export function computeCaseCounts(state: CaseStateView): CaseCounts {
  const nodesByKind: CaseCounts["nodes_by_kind"] = {
    goal: 0,
    task: 0,
    decision: 0,
    event: 0,
    evidence: 0
  };
  const nodesByState: CaseCounts["nodes_by_state"] = {
    proposed: 0,
    todo: 0,
    doing: 0,
    waiting: 0,
    done: 0,
    cancelled: 0,
    failed: 0
  };

  for (const node of state.nodes.values()) {
    nodesByKind[node.kind] += 1;
    nodesByState[node.state] += 1;
  }

  return {
    nodes_by_kind: nodesByKind,
    nodes_by_state: nodesByState,
    edge_count: state.edges.size
  };
}

export function getFrontier(state: CaseStateView): FrontierItem[] {
  const frontier: FrontierItem[] = [];
  for (const node of state.nodes.values()) {
    const derived = state.derived.get(node.node_id);
    if (!derived?.is_ready) {
      continue;
    }

    frontier.push({
      ...node,
      derived
    });
  }

  frontier.sort((left, right) => {
    const priorityDelta =
      metadataPriorityValue(left.metadata) - metadataPriorityValue(right.metadata);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const dueDateDelta = dueDateValue(left.metadata) - dueDateValue(right.metadata);
    if (dueDateDelta !== 0) {
      return dueDateDelta;
    }

    const createdDelta = Date.parse(left.created_at) - Date.parse(right.created_at);
    if (createdDelta !== 0) {
      return createdDelta;
    }

    return left.node_id.localeCompare(right.node_id);
  });

  return frontier;
}

export function getBlockedItems(state: CaseStateView): BlockedItem[] {
  const items: BlockedItem[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "task" && node.kind !== "decision") {
      continue;
    }

    const derived = state.derived.get(node.node_id);
    if (!derived || derived.blockers.length === 0) {
      continue;
    }

    items.push({
      node,
      reasons: derived.blockers
    });
  }

  items.sort((left, right) => left.node.node_id.localeCompare(right.node.node_id));
  return items;
}

function ensureCaseLoaded(
  caseRecord: CaseRecord | null,
  eventType: EventEnvelope["type"]
): asserts caseRecord is CaseRecord {
  if (!caseRecord) {
    throw new CaseGraphError(
      "case_not_initialized",
      `Cannot replay ${eventType} before case.created`,
      { exitCode: 2 }
    );
  }
}
