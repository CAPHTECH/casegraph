import { cloneRecord, dueDateValue, metadataPriorityValue } from "./helpers.js";
import { CaseGraphError } from "./errors.js";
import { applyPatchOperationsToDraft } from "./patch.js";
import { deriveNodeStates, validateGraph } from "./validation.js";
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

export function replayCaseEvents(events: EventEnvelope[]): CaseStateView {
  const nodes = new Map<string, NodeRecord>();
  const edges = new Map<string, EdgeRecord>();
  const attachments = new Map<string, AttachmentRecord>();
  let caseRecord: CaseRecord | null = null;

  for (const event of events) {
    switch (event.type) {
      case "case.created": {
        const nextCase = cloneRecord(
          event.payload.case as Omit<CaseRecord, "case_revision">
        );
        caseRecord = {
          ...nextCase,
          case_revision: { current: 0, last_event_id: null }
        };
        break;
      }

      case "case.updated": {
        ensureCaseLoaded(caseRecord, event.type);
        const rawChanges = event.payload.changes;
        const changes =
          typeof rawChanges === "object" && rawChanges !== null
            ? (rawChanges as Partial<CaseRecord>)
            : {};
        caseRecord = Object.assign({}, caseRecord, changes, {
          case_revision: caseRecord.case_revision
        });
        break;
      }

      case "node.added": {
        const nextNode = cloneRecord(event.payload.node as NodeRecord);
        nodes.set(nextNode.node_id, nextNode);
        break;
      }

      case "node.updated": {
        const nodeId = event.payload.node_id as string;
        const existingNode = nodes.get(nodeId);
        if (!existingNode) {
          throw new CaseGraphError(
            "node_not_found",
            `Node ${nodeId} not found during replay`,
            { exitCode: 3 }
          );
        }

        nodes.set(nodeId, {
          ...existingNode,
          ...(event.payload.changes as Partial<NodeRecord>),
          updated_at: event.timestamp
        });
        break;
      }

      case "node.state_changed": {
        const nodeId = event.payload.node_id as string;
        const existingNode = nodes.get(nodeId);
        if (!existingNode) {
          throw new CaseGraphError(
            "node_not_found",
            `Node ${nodeId} not found during replay`,
            { exitCode: 3 }
          );
        }

        nodes.set(nodeId, {
          ...existingNode,
          state: event.payload.state as NodeRecord["state"],
          metadata: {
            ...existingNode.metadata,
            ...((event.payload.metadata as Record<string, unknown> | undefined) ?? {})
          },
          updated_at: event.timestamp
        });
        break;
      }

      case "edge.added": {
        const nextEdge = cloneRecord(event.payload.edge as EdgeRecord);
        edges.set(nextEdge.edge_id, nextEdge);
        break;
      }

      case "edge.removed": {
        const edgeId = event.payload.edge_id as string;
        edges.delete(edgeId);
        break;
      }

      case "event.recorded": {
        const nodeId = event.payload.node_id as string;
        const existingNode = nodes.get(nodeId);
        if (!existingNode) {
          throw new CaseGraphError(
            "node_not_found",
            `Event node ${nodeId} not found during replay`,
            { exitCode: 3 }
          );
        }

        nodes.set(nodeId, {
          ...existingNode,
          state: "done",
          updated_at: event.timestamp
        });
        break;
      }

      case "evidence.attached": {
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
        break;
      }

      case "patch.applied": {
        ensureCaseLoaded(caseRecord, event.type);
        const patch = cloneRecord(event.payload.patch as GraphPatch);
        const draft: {
          caseRecord: CaseRecord;
          nodes: Map<string, NodeRecord>;
          edges: Map<string, EdgeRecord>;
          attachments: Map<string, AttachmentRecord>;
        } = {
          caseRecord,
          nodes,
          edges,
          attachments
        };
        const draftErrors = applyPatchOperationsToDraft(
          draft,
          patch,
          event.timestamp
        );

        if (draftErrors.length > 0) {
          throw new CaseGraphError(
            "patch_replay_failed",
            `Patch ${patch.patch_id} failed during replay`,
            { exitCode: 2, details: draftErrors }
          );
        }

        caseRecord = draft.caseRecord;

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
