import type {
  AttachmentRecord,
  BlockerReason,
  DerivedNodeState,
  EdgeRecord,
  NodeRecord,
  ValidationIssue
} from "./types.js";

const ACTIONABLE_KINDS = new Set(["task", "decision"]);
const FRONTIER_STATES = new Set(["todo", "doing"]);
const HARD_DEPENDENCY_TYPES = new Set(["depends_on", "waits_for"]);

function hasEvidenceForNode(
  nodeId: string,
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>
): boolean {
  for (const edge of edges.values()) {
    if (edge.type !== "verifies" || edge.target_id !== nodeId) {
      continue;
    }

    const sourceNode = nodes.get(edge.source_id);
    if (sourceNode?.kind === "evidence" && sourceNode.state === "done") {
      return true;
    }
  }

  return false;
}

export function validateGraph(
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  attachments: Map<string, AttachmentRecord>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();

  for (const node of nodes.values()) {
    if (seenNodeIds.has(node.node_id)) {
      issues.push({
        severity: "error",
        code: "duplicate_node_id",
        message: `Duplicate node_id ${node.node_id}`,
        ref: node.node_id
      });
    }
    seenNodeIds.add(node.node_id);

    if (
      node.state === "done" &&
      node.metadata.requires_evidence === true &&
      !hasEvidenceForNode(node.node_id, nodes, edges)
    ) {
      issues.push({
        severity: "warning",
        code: "missing_required_evidence",
        message: `Node ${node.node_id} is done but missing required evidence`,
        ref: node.node_id
      });
    }
  }

  const hardGraph = new Map<string, Set<string>>();
  for (const nodeId of nodes.keys()) {
    hardGraph.set(nodeId, new Set());
  }

  for (const edge of edges.values()) {
    if (seenEdgeIds.has(edge.edge_id)) {
      issues.push({
        severity: "error",
        code: "duplicate_edge_id",
        message: `Duplicate edge_id ${edge.edge_id}`,
        ref: edge.edge_id
      });
    }
    seenEdgeIds.add(edge.edge_id);

    if (!(nodes.has(edge.source_id) && nodes.has(edge.target_id))) {
      issues.push({
        severity: "error",
        code: "dangling_edge",
        message: `Edge ${edge.edge_id} references missing node`,
        ref: edge.edge_id
      });
      continue;
    }

    if (edge.type === "depends_on" && edge.source_id === edge.target_id) {
      issues.push({
        severity: "error",
        code: "depends_on_self_loop",
        message: `Edge ${edge.edge_id} creates a self-loop`,
        ref: edge.edge_id
      });
    }

    if (edge.type === "waits_for") {
      const targetNode = nodes.get(edge.target_id);
      if (targetNode?.kind !== "event") {
        issues.push({
          severity: "warning",
          code: "waits_for_non_event",
          message: `Edge ${edge.edge_id} waits for non-event node ${edge.target_id}`,
          ref: edge.edge_id
        });
      }
    }

    if (edge.type === "verifies") {
      const sourceNode = nodes.get(edge.source_id);
      if (sourceNode?.kind !== "evidence") {
        issues.push({
          severity: "warning",
          code: "verifies_non_evidence",
          message: `Edge ${edge.edge_id} verifies from non-evidence node ${edge.source_id}`,
          ref: edge.edge_id
        });
      }
    }

    if (HARD_DEPENDENCY_TYPES.has(edge.type)) {
      hardGraph.get(edge.source_id)?.add(edge.target_id);
    }
  }

  const cycleNodes = detectCycleNodes(hardGraph);
  if (cycleNodes.size > 0) {
    for (const nodeId of cycleNodes) {
      issues.push({
        severity: "error",
        code: "hard_dependency_cycle",
        message: `Hard dependency cycle includes ${nodeId}`,
        ref: nodeId
      });
    }
  }

  for (const attachment of attachments.values()) {
    if (!nodes.has(attachment.evidence_node_id)) {
      issues.push({
        severity: "warning",
        code: "attachment_orphaned",
        message: `Attachment ${attachment.attachment_id} references missing evidence node`,
        ref: attachment.attachment_id
      });
    }
  }

  return issues;
}

export function deriveNodeStates(
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  validation: ValidationIssue[]
): Map<string, DerivedNodeState> {
  const result = new Map<string, DerivedNodeState>();
  const cycleNodes = new Set(
    validation
      .filter((issue) => issue.code === "hard_dependency_cycle" && issue.ref)
      .map((issue) => issue.ref as string)
  );

  for (const node of nodes.values()) {
    const blockers: BlockerReason[] = [];
    const waitingFor: string[] = [];
    let hardDependencyTotal = 0;
    let satisfiedDependencyCount = 0;

    if (node.state === "waiting") {
      blockers.push({
        kind: "state",
        message: "node state is waiting"
      });
    }

    if (cycleNodes.has(node.node_id)) {
      blockers.push({
        kind: "cycle",
        ref: node.node_id,
        message: "dependency cycle detected"
      });
    }

    for (const edge of edges.values()) {
      if (edge.source_id !== node.node_id) {
        continue;
      }

      if (!HARD_DEPENDENCY_TYPES.has(edge.type)) {
        continue;
      }

      hardDependencyTotal += 1;
      const targetNode = nodes.get(edge.target_id);

      if (targetNode && targetNode.state === "done") {
        satisfiedDependencyCount += 1;
        continue;
      }

      if (edge.type === "depends_on") {
        blockers.push({
          kind: "depends_on",
          ref: edge.target_id,
          message: `depends_on:${edge.target_id} is not done`
        });
      } else {
        waitingFor.push(edge.target_id);
        blockers.push({
          kind: "waits_for",
          ref: edge.target_id,
          message: `waits_for:${edge.target_id} is not done`
        });
      }
    }

    const dependencySatisfiedRatio =
      hardDependencyTotal === 0 ? 1 : satisfiedDependencyCount / hardDependencyTotal;
    const actionable = ACTIONABLE_KINDS.has(node.kind) && FRONTIER_STATES.has(node.state);
    const isReady = actionable && blockers.length === 0;

    result.set(node.node_id, {
      node_id: node.node_id,
      is_ready: isReady,
      is_blocked: blockers.length > 0,
      blockers,
      waiting_for: waitingFor,
      dependency_satisfied_ratio: dependencySatisfiedRatio,
      has_unverified_completion:
        node.state === "done" &&
        node.metadata.requires_evidence === true &&
        !hasEvidenceForNode(node.node_id, nodes, edges)
    });
  }

  return result;
}

function detectCycleNodes(graph: Map<string, Set<string>>): Set<string> {
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const stackSet = new Set<string>();
  const cycleNodes = new Set<string>();
  let index = 0;

  function strongConnect(nodeId: string): void {
    indexByNode.set(nodeId, index);
    lowLinkByNode.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    stackSet.add(nodeId);

    for (const target of graph.get(nodeId) ?? []) {
      if (!indexByNode.has(target)) {
        strongConnect(target);
        lowLinkByNode.set(
          nodeId,
          Math.min(lowLinkByNode.get(nodeId) ?? 0, lowLinkByNode.get(target) ?? 0)
        );
      } else if (stackSet.has(target)) {
        lowLinkByNode.set(
          nodeId,
          Math.min(lowLinkByNode.get(nodeId) ?? 0, indexByNode.get(target) ?? 0)
        );
      }
    }

    if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) {
      return;
    }

    const component: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      stackSet.delete(current);
      component.push(current);
      if (current === nodeId) {
        break;
      }
    }

    if (component.length > 1) {
      for (const member of component) {
        cycleNodes.add(member);
      }
      return;
    }

    const onlyNode = component[0];
    if (onlyNode && graph.get(onlyNode)?.has(onlyNode)) {
      cycleNodes.add(onlyNode);
    }
  }

  for (const nodeId of graph.keys()) {
    if (!indexByNode.has(nodeId)) {
      strongConnect(nodeId);
    }
  }

  return cycleNodes;
}
