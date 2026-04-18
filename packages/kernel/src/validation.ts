import { hasInvalidEstimateMinutes } from "./helpers.js";
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
  const hardGraph = createHardGraph(nodes);

  validateNodes(nodes, edges, issues, seenNodeIds);
  validateEdges(nodes, edges, issues, seenEdgeIds, hardGraph);

  const cycleNodes = detectCycleNodes(hardGraph);
  pushCycleIssues(cycleNodes, issues);
  validateAttachments(nodes, attachments, issues);

  return issues;
}

export function deriveNodeStates(
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  validation: ValidationIssue[]
): Map<string, DerivedNodeState> {
  const result = new Map<string, DerivedNodeState>();
  const cycleNodes = collectCycleNodeIds(validation);

  for (const node of nodes.values()) {
    result.set(node.node_id, deriveSingleNodeState(node, nodes, edges, cycleNodes));
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
    initializeStrongConnectNode(nodeId, indexByNode, lowLinkByNode, stack, stackSet, index);
    index += 1;

    for (const target of graph.get(nodeId) ?? []) {
      if (!indexByNode.has(target)) {
        strongConnect(target);
        relaxLowLink(lowLinkByNode, nodeId, lowLinkByNode.get(target) ?? 0);
      } else if (stackSet.has(target)) {
        relaxLowLink(lowLinkByNode, nodeId, indexByNode.get(target) ?? 0);
      }
    }

    if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) {
      return;
    }

    const component = popStrongConnectComponent(stack, stackSet, nodeId);
    markCycleComponent(graph, component, cycleNodes);
  }

  for (const nodeId of graph.keys()) {
    if (!indexByNode.has(nodeId)) {
      strongConnect(nodeId);
    }
  }

  return cycleNodes;
}

function createHardGraph(nodes: Map<string, NodeRecord>): Map<string, Set<string>> {
  const hardGraph = new Map<string, Set<string>>();
  for (const nodeId of nodes.keys()) {
    hardGraph.set(nodeId, new Set());
  }
  return hardGraph;
}

function validateNodes(
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  issues: ValidationIssue[],
  seenNodeIds: Set<string>
): void {
  for (const node of nodes.values()) {
    pushDuplicateNodeIssue(node, issues, seenNodeIds);
    pushInvalidEstimateIssue(node, issues);
    pushMissingRequiredEvidenceIssue(node, nodes, edges, issues);
  }
}

function pushDuplicateNodeIssue(
  node: NodeRecord,
  issues: ValidationIssue[],
  seenNodeIds: Set<string>
): void {
  if (seenNodeIds.has(node.node_id)) {
    issues.push({
      severity: "error",
      code: "duplicate_node_id",
      message: `Duplicate node_id ${node.node_id}`,
      ref: node.node_id
    });
  }
  seenNodeIds.add(node.node_id);
}

function pushInvalidEstimateIssue(node: NodeRecord, issues: ValidationIssue[]): void {
  if (!hasInvalidEstimateMinutes(node)) {
    return;
  }

  issues.push({
    severity: "warning",
    code: "invalid_estimate_minutes",
    message: `Node ${node.node_id} has invalid estimate_minutes metadata`,
    ref: node.node_id
  });
}

function pushMissingRequiredEvidenceIssue(
  node: NodeRecord,
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  issues: ValidationIssue[]
): void {
  if (!(node.state === "done" && node.metadata.requires_evidence === true)) {
    return;
  }

  if (hasEvidenceForNode(node.node_id, nodes, edges)) {
    return;
  }

  issues.push({
    severity: "warning",
    code: "missing_required_evidence",
    message: `Node ${node.node_id} is done but missing required evidence`,
    ref: node.node_id
  });
}

function validateEdges(
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  issues: ValidationIssue[],
  seenEdgeIds: Set<string>,
  hardGraph: Map<string, Set<string>>
): void {
  for (const edge of edges.values()) {
    pushDuplicateEdgeIssue(edge, issues, seenEdgeIds);
    if (!validateEdgeEndpoints(nodes, edge, issues)) {
      continue;
    }

    pushEdgeSemanticIssues(nodes, edge, issues);
    if (HARD_DEPENDENCY_TYPES.has(edge.type)) {
      hardGraph.get(edge.source_id)?.add(edge.target_id);
    }
  }
}

function pushDuplicateEdgeIssue(
  edge: EdgeRecord,
  issues: ValidationIssue[],
  seenEdgeIds: Set<string>
): void {
  if (seenEdgeIds.has(edge.edge_id)) {
    issues.push({
      severity: "error",
      code: "duplicate_edge_id",
      message: `Duplicate edge_id ${edge.edge_id}`,
      ref: edge.edge_id
    });
  }

  seenEdgeIds.add(edge.edge_id);
}

function validateEdgeEndpoints(
  nodes: Map<string, NodeRecord>,
  edge: EdgeRecord,
  issues: ValidationIssue[]
): boolean {
  if (nodes.has(edge.source_id) && nodes.has(edge.target_id)) {
    return true;
  }

  issues.push({
    severity: "error",
    code: "dangling_edge",
    message: `Edge ${edge.edge_id} references missing node`,
    ref: edge.edge_id
  });
  return false;
}

function pushEdgeSemanticIssues(
  nodes: Map<string, NodeRecord>,
  edge: EdgeRecord,
  issues: ValidationIssue[]
): void {
  pushSelfLoopIssue(edge, issues);
  pushWaitsForIssue(nodes, edge, issues);
  pushVerifiesIssue(nodes, edge, issues);
}

function pushSelfLoopIssue(edge: EdgeRecord, issues: ValidationIssue[]): void {
  if (!(edge.type === "depends_on" && edge.source_id === edge.target_id)) {
    return;
  }

  issues.push({
    severity: "error",
    code: "depends_on_self_loop",
    message: `Edge ${edge.edge_id} creates a self-loop`,
    ref: edge.edge_id
  });
}

function pushWaitsForIssue(
  nodes: Map<string, NodeRecord>,
  edge: EdgeRecord,
  issues: ValidationIssue[]
): void {
  if (edge.type !== "waits_for") {
    return;
  }

  const targetNode = nodes.get(edge.target_id);
  if (targetNode?.kind === "event") {
    return;
  }

  issues.push({
    severity: "warning",
    code: "waits_for_non_event",
    message: `Edge ${edge.edge_id} waits for non-event node ${edge.target_id}`,
    ref: edge.edge_id
  });
}

function pushVerifiesIssue(
  nodes: Map<string, NodeRecord>,
  edge: EdgeRecord,
  issues: ValidationIssue[]
): void {
  if (edge.type !== "verifies") {
    return;
  }

  const sourceNode = nodes.get(edge.source_id);
  if (sourceNode?.kind === "evidence") {
    return;
  }

  issues.push({
    severity: "warning",
    code: "verifies_non_evidence",
    message: `Edge ${edge.edge_id} verifies from non-evidence node ${edge.source_id}`,
    ref: edge.edge_id
  });
}

function pushCycleIssues(cycleNodes: Set<string>, issues: ValidationIssue[]): void {
  for (const nodeId of cycleNodes) {
    issues.push({
      severity: "error",
      code: "hard_dependency_cycle",
      message: `Hard dependency cycle includes ${nodeId}`,
      ref: nodeId
    });
  }
}

function validateAttachments(
  nodes: Map<string, NodeRecord>,
  attachments: Map<string, AttachmentRecord>,
  issues: ValidationIssue[]
): void {
  for (const attachment of attachments.values()) {
    if (nodes.has(attachment.evidence_node_id)) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: "attachment_orphaned",
      message: `Attachment ${attachment.attachment_id} references missing evidence node`,
      ref: attachment.attachment_id
    });
  }
}

function collectCycleNodeIds(validation: ValidationIssue[]): Set<string> {
  return new Set(
    validation
      .filter((issue) => issue.code === "hard_dependency_cycle" && issue.ref)
      .map((issue) => issue.ref as string)
  );
}

function deriveSingleNodeState(
  node: NodeRecord,
  nodes: Map<string, NodeRecord>,
  edges: Map<string, EdgeRecord>,
  cycleNodes: Set<string>
): DerivedNodeState {
  const blockers: BlockerReason[] = [];
  const waitingFor: string[] = [];
  let hardDependencyTotal = 0;
  let satisfiedDependencyCount = 0;

  pushStateBlocker(node, blockers);
  pushCycleBlocker(node, cycleNodes, blockers);

  for (const edge of edges.values()) {
    if (!(edge.source_id === node.node_id && HARD_DEPENDENCY_TYPES.has(edge.type))) {
      continue;
    }

    hardDependencyTotal += 1;
    if (isSatisfiedHardDependency(nodes, edge)) {
      satisfiedDependencyCount += 1;
      continue;
    }

    pushDependencyBlocker(edge, blockers, waitingFor);
  }

  const dependencySatisfiedRatio =
    hardDependencyTotal === 0 ? 1 : satisfiedDependencyCount / hardDependencyTotal;
  const actionable = ACTIONABLE_KINDS.has(node.kind) && FRONTIER_STATES.has(node.state);

  return {
    node_id: node.node_id,
    is_ready: actionable && blockers.length === 0,
    is_blocked: blockers.length > 0,
    blockers,
    waiting_for: waitingFor,
    dependency_satisfied_ratio: dependencySatisfiedRatio,
    has_unverified_completion:
      node.state === "done" &&
      node.metadata.requires_evidence === true &&
      !hasEvidenceForNode(node.node_id, nodes, edges)
  };
}

function pushStateBlocker(node: NodeRecord, blockers: BlockerReason[]): void {
  if (node.state !== "waiting") {
    return;
  }

  blockers.push({
    kind: "state",
    message: "node state is waiting"
  });
}

function pushCycleBlocker(
  node: NodeRecord,
  cycleNodes: Set<string>,
  blockers: BlockerReason[]
): void {
  if (!cycleNodes.has(node.node_id)) {
    return;
  }

  blockers.push({
    kind: "cycle",
    ref: node.node_id,
    message: "dependency cycle detected"
  });
}

function isSatisfiedHardDependency(nodes: Map<string, NodeRecord>, edge: EdgeRecord): boolean {
  const targetNode = nodes.get(edge.target_id);
  return Boolean(targetNode && targetNode.state === "done");
}

function pushDependencyBlocker(
  edge: EdgeRecord,
  blockers: BlockerReason[],
  waitingFor: string[]
): void {
  if (edge.type === "depends_on") {
    blockers.push({
      kind: "depends_on",
      ref: edge.target_id,
      message: `depends_on:${edge.target_id} is not done`
    });
    return;
  }

  waitingFor.push(edge.target_id);
  blockers.push({
    kind: "waits_for",
    ref: edge.target_id,
    message: `waits_for:${edge.target_id} is not done`
  });
}

function initializeStrongConnectNode(
  nodeId: string,
  indexByNode: Map<string, number>,
  lowLinkByNode: Map<string, number>,
  stack: string[],
  stackSet: Set<string>,
  index: number
): void {
  indexByNode.set(nodeId, index);
  lowLinkByNode.set(nodeId, index);
  stack.push(nodeId);
  stackSet.add(nodeId);
}

function relaxLowLink(
  lowLinkByNode: Map<string, number>,
  nodeId: string,
  candidateIndex: number
): void {
  lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId) ?? 0, candidateIndex));
}

function popStrongConnectComponent(
  stack: string[],
  stackSet: Set<string>,
  nodeId: string
): string[] {
  const component: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    stackSet.delete(current);
    component.push(current);
    if (current === nodeId) {
      break;
    }
  }

  return component;
}

function markCycleComponent(
  graph: Map<string, Set<string>>,
  component: string[],
  cycleNodes: Set<string>
): void {
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
