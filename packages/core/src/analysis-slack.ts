import { CaseGraphError } from "./errors.js";
import { estimateMinutesValue } from "./helpers.js";
import type {
  CaseStateView,
  EdgeRecord,
  NodeKind,
  NodeRecord,
  NodeState,
  RevisionSnapshot
} from "./types.js";

const HARD_DEPENDENCY_TYPES = new Set(["depends_on", "waits_for"]);
const UNRESOLVED_STATES = new Set(["todo", "doing", "waiting", "failed"]);

interface TraversalEdge {
  edge_id: string;
  node_id: string;
}

interface ScopedHardGraph {
  nodes: Map<string, NodeRecord>;
  adjacency: Map<string, TraversalEdge[]>;
  predecessors: Map<string, TraversalEdge[]>;
}

interface ScheduleBounds {
  start: number;
  finish: number;
}

export interface SlackAnalysisNode {
  node_id: string;
  kind: NodeKind;
  state: NodeState;
  title: string;
  estimate_minutes: number;
  earliest_start_minutes: number;
  earliest_finish_minutes: number;
  latest_start_minutes: number;
  latest_finish_minutes: number;
  slack_minutes: number;
  is_critical: boolean;
}

export interface SlackAnalysisResult {
  case_id: string;
  revision: RevisionSnapshot;
  goal_node_id: string | null;
  projected_duration_minutes: number | null;
  nodes: SlackAnalysisNode[];
  missing_estimate_node_ids: string[];
  warnings: string[];
}

export function analyzeSlack(state: CaseStateView, goalNodeId?: string): SlackAnalysisResult {
  const scopedGraph = buildScopedHardGraph(state, goalNodeId);
  const scopedCycleNodeIds = collectScopedCycleNodeIds(state, scopedGraph.nodes);
  if (scopedCycleNodeIds.length > 0) {
    throw new CaseGraphError(
      "analysis_cycle_present",
      "Slack analysis scope contains a hard cycle",
      {
        exitCode: 2,
        details: { node_ids: scopedCycleNodeIds }
      }
    );
  }

  const warnings: string[] = [];
  if (scopedGraph.nodes.size === 0) {
    warnings.push("scope_has_no_unresolved_nodes");
  }

  const missingEstimateNodeIds = [...scopedGraph.nodes.values()]
    .filter((node) => node.kind !== "event" && estimateMinutesValue(node) === null)
    .map((node) => node.node_id)
    .sort((left, right) => left.localeCompare(right));

  if (missingEstimateNodeIds.length > 0) {
    warnings.push("missing_estimates_present", "slack_unavailable_due_to_missing_estimates");
    return {
      case_id: state.caseRecord.case_id,
      revision: state.caseRecord.case_revision,
      goal_node_id: goalNodeId ?? null,
      projected_duration_minutes: null,
      nodes: [],
      missing_estimate_node_ids: missingEstimateNodeIds,
      warnings
    };
  }

  const topologicalOrder = stableTopologicalOrder(scopedGraph);
  const earliestSchedule = computeEarliestSchedule(scopedGraph, topologicalOrder);
  const projectedDurationMinutes = topologicalOrder.reduce((best, nodeId) => {
    const bounds = earliestSchedule.get(nodeId);
    return bounds ? Math.max(best, bounds.finish) : best;
  }, 0);
  const latestSchedule = computeLatestSchedule(
    scopedGraph,
    topologicalOrder,
    projectedDurationMinutes
  );

  const nodes = topologicalOrder
    .map((nodeId) =>
      summarizeSlackNode(
        scopedGraph.nodes.get(nodeId) as NodeRecord,
        earliestSchedule.get(nodeId) as ScheduleBounds,
        latestSchedule.get(nodeId) as ScheduleBounds
      )
    )
    .sort(compareSlackNodes);

  return {
    case_id: state.caseRecord.case_id,
    revision: state.caseRecord.case_revision,
    goal_node_id: goalNodeId ?? null,
    projected_duration_minutes: projectedDurationMinutes,
    nodes,
    missing_estimate_node_ids: [],
    warnings
  };
}

function buildScopedHardGraph(state: CaseStateView, goalNodeId?: string): ScopedHardGraph {
  const goalNode = goalNodeId ? state.nodes.get(goalNodeId) : null;
  if (goalNodeId && !goalNode) {
    throw new CaseGraphError("node_not_found", `Node ${goalNodeId} not found`, {
      exitCode: 3
    });
  }
  if (goalNode && goalNode.kind !== "goal") {
    throw new CaseGraphError("node_not_goal", `Node ${goalNodeId} is not a goal`, {
      exitCode: 2
    });
  }

  const allUnresolvedNodes = [...state.nodes.values()].filter(isUnresolvedNode);
  const unresolvedById = new Map(allUnresolvedNodes.map((node) => [node.node_id, node]));
  const scopedNodeIds = goalNode
    ? collectGoalScopedNodeIds(state, goalNode.node_id, unresolvedById)
    : [...unresolvedById.keys()].sort((left, right) => left.localeCompare(right));
  const nodes = new Map(
    scopedNodeIds
      .map((nodeId) => unresolvedById.get(nodeId))
      .filter((node): node is NodeRecord => Boolean(node))
      .map((node) => [node.node_id, node])
  );

  const adjacency = new Map<string, TraversalEdge[]>();
  const predecessors = new Map<string, TraversalEdge[]>();
  for (const nodeId of nodes.keys()) {
    adjacency.set(nodeId, []);
    predecessors.set(nodeId, []);
  }

  for (const edge of state.edges.values()) {
    if (!HARD_DEPENDENCY_TYPES.has(edge.type)) {
      continue;
    }
    if (!(nodes.has(edge.source_id) && nodes.has(edge.target_id))) {
      continue;
    }
    adjacency.get(edge.target_id)?.push({
      edge_id: edge.edge_id,
      node_id: edge.source_id
    });
    predecessors.get(edge.source_id)?.push({
      edge_id: edge.edge_id,
      node_id: edge.target_id
    });
  }

  return {
    nodes,
    adjacency: sortAdjacency(adjacency),
    predecessors: sortAdjacency(predecessors)
  };
}

function collectGoalScopedNodeIds(
  state: CaseStateView,
  goalNodeId: string,
  unresolvedById: Map<string, NodeRecord>
): string[] {
  const contributingAdjacency = buildContributingAdjacency(state.edges);
  const scoped = expandContributorsFromGoal(goalNodeId, contributingAdjacency);
  expandHardPrerequisites(state.edges, unresolvedById, scoped);
  return [...scoped].sort((left, right) => left.localeCompare(right));
}

function buildContributingAdjacency(edges: Map<string, EdgeRecord>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();

  for (const edge of edges.values()) {
    if (edge.type !== "contributes_to") {
      continue;
    }
    if (!adjacency.has(edge.target_id)) {
      adjacency.set(edge.target_id, []);
    }
    adjacency.get(edge.target_id)?.push(edge.source_id);
  }

  for (const [targetId, sourceIds] of adjacency.entries()) {
    sourceIds.sort((left, right) => left.localeCompare(right));
    adjacency.set(targetId, sourceIds);
  }

  return adjacency;
}

function expandContributorsFromGoal(
  goalNodeId: string,
  contributingAdjacency: Map<string, string[]>
): Set<string> {
  const scoped = new Set<string>();
  const queue = [goalNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    for (const sourceNodeId of contributingAdjacency.get(currentNodeId) ?? []) {
      if (scoped.has(sourceNodeId)) {
        continue;
      }
      scoped.add(sourceNodeId);
      queue.push(sourceNodeId);
    }
  }

  return scoped;
}

function expandHardPrerequisites(
  edges: Map<string, EdgeRecord>,
  unresolvedById: Map<string, NodeRecord>,
  scoped: Set<string>
): void {
  const prerequisiteStack = [...scoped].sort((left, right) => left.localeCompare(right));

  while (prerequisiteStack.length > 0) {
    const currentNodeId = prerequisiteStack.pop() as string;
    for (const edge of edges.values()) {
      if (!HARD_DEPENDENCY_TYPES.has(edge.type) || edge.source_id !== currentNodeId) {
        continue;
      }
      if (!unresolvedById.has(edge.target_id) || scoped.has(edge.target_id)) {
        continue;
      }
      scoped.add(edge.target_id);
      prerequisiteStack.push(edge.target_id);
    }
  }
}

function isUnresolvedNode(node: NodeRecord): boolean {
  return UNRESOLVED_STATES.has(node.state);
}

function collectScopedCycleNodeIds(state: CaseStateView, nodes: Map<string, NodeRecord>): string[] {
  const cycleNodes = new Set(
    state.validation
      .filter((issue) => issue.code === "hard_dependency_cycle" && issue.ref)
      .map((issue) => issue.ref as string)
  );

  return [...nodes.keys()]
    .filter((nodeId) => cycleNodes.has(nodeId))
    .sort((left, right) => left.localeCompare(right));
}

function sortAdjacency(adjacency: Map<string, TraversalEdge[]>): Map<string, TraversalEdge[]> {
  for (const [nodeId, neighbors] of adjacency.entries()) {
    neighbors.sort((left, right) => {
      const nodeDelta = left.node_id.localeCompare(right.node_id);
      if (nodeDelta !== 0) {
        return nodeDelta;
      }
      return left.edge_id.localeCompare(right.edge_id);
    });
    adjacency.set(nodeId, neighbors);
  }

  return adjacency;
}

function stableTopologicalOrder(graph: ScopedHardGraph): string[] {
  const indegree = new Map<string, number>([...graph.nodes.keys()].map((nodeId) => [nodeId, 0]));
  for (const edges of graph.adjacency.values()) {
    for (const edge of edges) {
      indegree.set(edge.node_id, (indegree.get(edge.node_id) ?? 0) + 1);
    }
  }

  const available = [...graph.nodes.keys()]
    .filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0)
    .sort((left, right) => left.localeCompare(right));
  const order: string[] = [];

  while (available.length > 0) {
    const nodeId = available.shift() as string;
    order.push(nodeId);
    for (const edge of graph.adjacency.get(nodeId) ?? []) {
      const nextIndegree = (indegree.get(edge.node_id) ?? 0) - 1;
      indegree.set(edge.node_id, nextIndegree);
      if (nextIndegree === 0) {
        available.push(edge.node_id);
        available.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (order.length !== graph.nodes.size) {
    throw new CaseGraphError(
      "analysis_cycle_present",
      "Slack analysis scope contains a hard cycle",
      {
        exitCode: 2
      }
    );
  }

  return order;
}

function computeEarliestSchedule(
  graph: ScopedHardGraph,
  topologicalOrder: string[]
): Map<string, ScheduleBounds> {
  const schedule = new Map<string, ScheduleBounds>();

  for (const nodeId of topologicalOrder) {
    const earliestStartMinutes = (graph.predecessors.get(nodeId) ?? []).reduce((best, edge) => {
      const predecessorBounds = schedule.get(edge.node_id);
      return predecessorBounds ? Math.max(best, predecessorBounds.finish) : best;
    }, 0);
    const estimateMinutes = estimateForNode(graph.nodes.get(nodeId) as NodeRecord);
    schedule.set(nodeId, {
      start: earliestStartMinutes,
      finish: earliestStartMinutes + estimateMinutes
    });
  }

  return schedule;
}

function computeLatestSchedule(
  graph: ScopedHardGraph,
  topologicalOrder: string[],
  projectedDurationMinutes: number
): Map<string, ScheduleBounds> {
  const schedule = new Map<string, ScheduleBounds>();

  for (const nodeId of [...topologicalOrder].reverse()) {
    const estimateMinutes = estimateForNode(graph.nodes.get(nodeId) as NodeRecord);
    const outgoingEdges = graph.adjacency.get(nodeId) ?? [];
    const latestFinishMinutes =
      outgoingEdges.length === 0
        ? projectedDurationMinutes
        : outgoingEdges.reduce((best, edge) => {
            const dependentBounds = schedule.get(edge.node_id);
            if (!dependentBounds) {
              throw new CaseGraphError(
                "analysis_schedule_missing",
                `Missing latest schedule bounds for ${edge.node_id}`,
                {
                  exitCode: 2
                }
              );
            }
            return Math.min(best, dependentBounds.start);
          }, Number.POSITIVE_INFINITY);

    schedule.set(nodeId, {
      start: latestFinishMinutes - estimateMinutes,
      finish: latestFinishMinutes
    });
  }

  return schedule;
}

function summarizeSlackNode(
  node: NodeRecord,
  earliestBounds: ScheduleBounds,
  latestBounds: ScheduleBounds
): SlackAnalysisNode {
  const estimateMinutes = estimateForNode(node);
  const slackMinutes = latestBounds.start - earliestBounds.start;

  return {
    node_id: node.node_id,
    kind: node.kind,
    state: node.state,
    title: node.title,
    estimate_minutes: estimateMinutes,
    earliest_start_minutes: earliestBounds.start,
    earliest_finish_minutes: earliestBounds.finish,
    latest_start_minutes: latestBounds.start,
    latest_finish_minutes: latestBounds.finish,
    slack_minutes: slackMinutes,
    is_critical: slackMinutes === 0
  };
}

function estimateForNode(node: NodeRecord): number {
  const estimateMinutes = estimateMinutesValue(node);
  if (estimateMinutes === null) {
    throw new CaseGraphError("analysis_estimate_missing", `Missing estimate for ${node.node_id}`, {
      exitCode: 2
    });
  }
  return estimateMinutes;
}

function compareSlackNodes(left: SlackAnalysisNode, right: SlackAnalysisNode): number {
  if (left.slack_minutes !== right.slack_minutes) {
    return left.slack_minutes - right.slack_minutes;
  }
  if (left.latest_start_minutes !== right.latest_start_minutes) {
    return left.latest_start_minutes - right.latest_start_minutes;
  }
  return left.node_id.localeCompare(right.node_id);
}
