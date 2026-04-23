import {
  createEvent,
  defaultActor,
  type EdgeType,
  type NodeState,
  replayCaseEvents
} from "@caphtech/casegraph-core";
import fc from "fast-check";

type TopologyTaskState = Extract<NodeState, "todo" | "doing" | "waiting" | "failed" | "done">;

export interface TopologyTaskBlueprint {
  node_id: string;
  state: TopologyTaskState;
}

export interface TopologyHardEdgeBlueprint {
  edge_id: string;
  type: Extract<EdgeType, "depends_on" | "waits_for">;
  source_id: string;
  target_id: string;
}

export interface TopologyBlueprint {
  caseId: string;
  tasks: TopologyTaskBlueprint[];
  hardEdges: TopologyHardEdgeBlueprint[];
  goalNodeId?: string;
  goalState?: TopologyTaskState;
  contributorTaskIds?: string[];
}

export interface TopologyReferenceSummary {
  node_count: number;
  edge_count: number;
  beta_0: number;
  beta_1: number;
  components: Array<{ node_ids: string[]; edge_count: number }>;
  edge_keys: string[];
  node_ids: string[];
  warnings: string[];
}

const topologyTaskStateArb = fc.constantFrom<TopologyTaskState>(
  "todo",
  "doing",
  "waiting",
  "failed",
  "done"
);
const topologyHardEdgeTypeArb = fc.constantFrom<Extract<EdgeType, "depends_on" | "waits_for">>(
  "depends_on",
  "waits_for"
);

export const topologyBlueprintArb: fc.Arbitrary<TopologyBlueprint> = fc
  .integer({ min: 2, max: 6 })
  .chain((count) =>
    fc
      .uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: count, maxLength: count })
      .chain((values) => {
        const taskIds = values.sort((left, right) => left - right).map((value) => `task_${value}`);

        return fc
          .tuple(
            fc.array(topologyTaskStateArb, { minLength: count, maxLength: count }),
            arbitraryHardEdges(taskIds, { allowDuplicates: true, allowSelfLoops: true })
          )
          .map(([states, hardEdges]) => ({
            caseId: `topology-prop-${taskIds.join("-")}`,
            tasks: taskIds.map((taskId, index) => ({
              node_id: taskId,
              state: states[index] as TopologyTaskState
            })),
            hardEdges
          }));
      })
  );

export const simpleTopologyBlueprintArb: fc.Arbitrary<TopologyBlueprint> = fc
  .integer({ min: 2, max: 6 })
  .chain((count) =>
    fc
      .uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: count, maxLength: count })
      .chain((values) => {
        const taskIds = values.sort((left, right) => left - right).map((value) => `task_${value}`);

        return fc
          .tuple(
            fc.array(topologyTaskStateArb, { minLength: count, maxLength: count }),
            arbitraryHardEdges(taskIds, { allowDuplicates: false, allowSelfLoops: false })
          )
          .map(([states, hardEdges]) => ({
            caseId: `topology-simple-prop-${taskIds.join("-")}`,
            tasks: taskIds.map((taskId, index) => ({
              node_id: taskId,
              state: states[index] as TopologyTaskState
            })),
            hardEdges
          }));
      })
  );

export const goalScopedTopologyBlueprintArb: fc.Arbitrary<TopologyBlueprint> =
  topologyBlueprintArb.chain((blueprint) =>
    fc
      .tuple(
        fc.subarray(
          blueprint.tasks.map((task) => task.node_id),
          { minLength: 1 }
        ),
        topologyTaskStateArb
      )
      .map(([contributorTaskIds, goalState]) => ({
        ...blueprint,
        goalNodeId: "goal_release_ready",
        goalState,
        contributorTaskIds: [...contributorTaskIds].sort((left, right) => left.localeCompare(right))
      }))
  );

export const resolvedContributorScopeBlueprintArb: fc.Arbitrary<TopologyBlueprint> =
  topologyBlueprintArb
    .filter((blueprint) => blueprint.tasks.some((task) => task.state !== "done"))
    .map((blueprint) => {
      const prerequisiteTaskId =
        blueprint.tasks.find((task) => task.state !== "done")?.node_id ?? "task_fallback";

      return {
        ...blueprint,
        caseId: `${blueprint.caseId}-resolved-contributor`,
        tasks: [
          ...blueprint.tasks,
          {
            node_id: "task_resolved_bridge",
            state: "done"
          }
        ],
        goalNodeId: "goal_release_ready",
        goalState: "done",
        contributorTaskIds: ["task_resolved_bridge"],
        hardEdges: [
          ...blueprint.hardEdges,
          {
            edge_id: "resolved_bridge_wait",
            type: "waits_for",
            source_id: "task_resolved_bridge",
            target_id: prerequisiteTaskId
          }
        ]
      };
    });

export function buildTopologyState(blueprint: TopologyBlueprint) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const actor = defaultActor();

  return replayCaseEvents([
    createEvent({
      case_id: blueprint.caseId,
      timestamp,
      actor,
      type: "case.created",
      payload: {
        case: {
          case_id: blueprint.caseId,
          title: blueprint.caseId,
          description: "",
          state: "open",
          labels: [],
          metadata: {},
          extensions: {},
          created_at: timestamp,
          updated_at: timestamp
        }
      }
    }),
    ...blueprint.tasks.map((task) =>
      createEvent({
        case_id: blueprint.caseId,
        timestamp,
        actor,
        type: "node.added",
        payload: {
          node: {
            node_id: task.node_id,
            kind: "task",
            title: task.node_id,
            description: "",
            state: task.state,
            labels: [],
            acceptance: [],
            metadata: {},
            extensions: {},
            created_at: timestamp,
            updated_at: timestamp
          }
        }
      })
    ),
    ...(blueprint.goalNodeId
      ? [
          createEvent({
            case_id: blueprint.caseId,
            timestamp,
            actor,
            type: "node.added" as const,
            payload: {
              node: {
                node_id: blueprint.goalNodeId,
                kind: "goal" as const,
                title: blueprint.goalNodeId,
                description: "",
                state: blueprint.goalState ?? "done",
                labels: [],
                acceptance: [],
                metadata: {},
                extensions: {},
                created_at: timestamp,
                updated_at: timestamp
              }
            }
          })
        ]
      : []),
    ...blueprint.hardEdges.map((edge) =>
      createEvent({
        case_id: blueprint.caseId,
        timestamp,
        actor,
        type: "edge.added",
        payload: {
          edge: {
            edge_id: edge.edge_id,
            type: edge.type,
            source_id: edge.source_id,
            target_id: edge.target_id,
            metadata: {},
            extensions: {},
            created_at: timestamp
          }
        }
      })
    ),
    ...contributionEventsFromBlueprint(blueprint, timestamp, actor)
  ]);
}

export function buildReferenceTopology(
  blueprint: TopologyBlueprint,
  options: { projection?: "hard_unresolved" | "hard_goal_scope"; goalNodeId?: string } = {}
): TopologyReferenceSummary {
  const projection = resolveProjection(blueprint, options);
  const unresolvedNodeIds = collectUnresolvedNodeIds(blueprint.tasks);
  const scopedNodeIds = collectScopedNodeIds(blueprint, projection, unresolvedNodeIds);
  const { edgeKeys, warnings } = collectReferenceEdges(blueprint.hardEdges, scopedNodeIds);
  const components = collectReferenceComponents(scopedNodeIds, edgeKeys);

  if (scopedNodeIds.length === 0) {
    warnings.add("scope_has_no_unresolved_nodes");
  }

  return {
    node_count: scopedNodeIds.length,
    edge_count: edgeKeys.length,
    beta_0: components.length,
    beta_1: edgeKeys.length - scopedNodeIds.length + components.length,
    components,
    edge_keys: edgeKeys,
    node_ids: scopedNodeIds,
    warnings: [...warnings].sort(sortStrings)
  };
}

export function addNormalizationNoise(blueprint: TopologyBlueprint): TopologyBlueprint {
  const duplicateEdges = blueprint.hardEdges.slice(0, 3).map((edge, index) => ({
    edge_id: `dup_${index}_${edge.edge_id}`,
    type: edge.type,
    source_id: index % 2 === 0 ? edge.source_id : edge.target_id,
    target_id: index % 2 === 0 ? edge.target_id : edge.source_id
  }));
  const selfLoops = blueprint.tasks.slice(0, 2).map((task, index) => ({
    edge_id: `self_${index}_${task.node_id}`,
    type: index % 2 === 0 ? "depends_on" : "waits_for",
    source_id: task.node_id,
    target_id: task.node_id
  }));

  return {
    ...blueprint,
    caseId: `${blueprint.caseId}-noise`,
    hardEdges: [...blueprint.hardEdges, ...duplicateEdges, ...selfLoops]
  };
}

function arbitraryHardEdges(
  taskIds: string[],
  options: { allowDuplicates: boolean; allowSelfLoops: boolean }
): fc.Arbitrary<TopologyHardEdgeBlueprint[]> {
  return fc
    .array(
      fc.tuple(
        fc.integer({ min: 0, max: taskIds.length - 1 }),
        fc.integer({ min: 0, max: taskIds.length - 1 }),
        fc.boolean(),
        topologyHardEdgeTypeArb
      ),
      { minLength: 0, maxLength: taskIds.length * 3 }
    )
    .map((entries) => materializeHardEdges(taskIds, entries, options));
}

function contributionEventsFromBlueprint(
  blueprint: TopologyBlueprint,
  timestamp: string,
  actor: ReturnType<typeof defaultActor>
) {
  if (!(blueprint.goalNodeId && blueprint.contributorTaskIds)) {
    return [];
  }

  return blueprint.contributorTaskIds.map((taskId, index) =>
    createEvent({
      case_id: blueprint.caseId,
      timestamp,
      actor,
      type: "edge.added",
      payload: {
        edge: {
          edge_id: `contrib_${index}`,
          type: "contributes_to",
          source_id: taskId,
          target_id: blueprint.goalNodeId as string,
          metadata: {},
          extensions: {},
          created_at: timestamp
        }
      }
    })
  );
}

function resolveProjection(
  blueprint: TopologyBlueprint,
  options: { projection?: "hard_unresolved" | "hard_goal_scope"; goalNodeId?: string }
): "hard_unresolved" | "hard_goal_scope" {
  const goalNodeId = options.goalNodeId ?? blueprint.goalNodeId;
  return options.projection ?? (goalNodeId ? "hard_goal_scope" : "hard_unresolved");
}

function collectUnresolvedNodeIds(tasks: TopologyTaskBlueprint[]): Set<string> {
  return new Set(tasks.filter((task) => task.state !== "done").map((task) => task.node_id));
}

function collectScopedNodeIds(
  blueprint: TopologyBlueprint,
  projection: "hard_unresolved" | "hard_goal_scope",
  unresolvedNodeIds: Set<string>
): string[] {
  if (projection === "hard_unresolved") {
    return [...unresolvedNodeIds].sort(sortStrings);
  }

  const scopedSeedIds = new Set(
    (blueprint.contributorTaskIds ?? []).filter((nodeId) => unresolvedNodeIds.has(nodeId))
  );
  expandWithUnresolvedPrerequisites(scopedSeedIds, blueprint.hardEdges, unresolvedNodeIds);
  return [...scopedSeedIds].filter((nodeId) => unresolvedNodeIds.has(nodeId)).sort(sortStrings);
}

function expandWithUnresolvedPrerequisites(
  scopedSeedIds: Set<string>,
  hardEdges: TopologyHardEdgeBlueprint[],
  unresolvedNodeIds: Set<string>
): void {
  const prerequisitesBySource = buildPrerequisiteAdjacency(hardEdges);
  const stack = [...scopedSeedIds];

  while (stack.length > 0) {
    const currentNodeId = stack.pop() as string;
    for (const prerequisiteNodeId of prerequisitesBySource.get(currentNodeId) ?? []) {
      if (!unresolvedNodeIds.has(prerequisiteNodeId) || scopedSeedIds.has(prerequisiteNodeId)) {
        continue;
      }
      scopedSeedIds.add(prerequisiteNodeId);
      stack.push(prerequisiteNodeId);
    }
  }
}

function buildPrerequisiteAdjacency(hardEdges: TopologyHardEdgeBlueprint[]): Map<string, string[]> {
  const prerequisitesBySource = new Map<string, string[]>();

  for (const edge of hardEdges) {
    const prerequisites = prerequisitesBySource.get(edge.source_id) ?? [];
    prerequisites.push(edge.target_id);
    prerequisitesBySource.set(edge.source_id, prerequisites.sort(sortStrings));
  }

  return prerequisitesBySource;
}

function collectReferenceEdges(
  hardEdges: TopologyHardEdgeBlueprint[],
  scopedNodeIds: string[]
): { edgeKeys: string[]; warnings: Set<string> } {
  const scopedNodeSet = new Set(scopedNodeIds);
  const warnings = new Set<string>();
  const edgeKeys = new Set<string>();

  for (const edge of hardEdges) {
    if (!(scopedNodeSet.has(edge.source_id) && scopedNodeSet.has(edge.target_id))) {
      continue;
    }
    if (edge.source_id === edge.target_id) {
      warnings.add("self_loop_ignored");
      continue;
    }
    edgeKeys.add(edgeKey(edge.source_id, edge.target_id));
  }

  return {
    edgeKeys: [...edgeKeys].sort(sortStrings),
    warnings
  };
}

function collectReferenceComponents(
  scopedNodeIds: string[],
  edgeKeys: string[]
): Array<{ node_ids: string[]; edge_count: number }> {
  const adjacency = buildAdjacency(scopedNodeIds, edgeKeys);
  const visited = new Set<string>();
  const components: Array<{ node_ids: string[]; edge_count: number }> = [];

  for (const nodeId of scopedNodeIds) {
    if (visited.has(nodeId)) {
      continue;
    }

    const componentNodeIds = collectConnectedNodeIds(nodeId, adjacency, visited);
    components.push({
      node_ids: componentNodeIds,
      edge_count: countEdgesWithinComponent(componentNodeIds, edgeKeys)
    });
  }

  return components;
}

function buildAdjacency(scopedNodeIds: string[], edgeKeys: string[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();

  for (const nodeId of scopedNodeIds) {
    adjacency.set(nodeId, []);
  }

  for (const key of edgeKeys) {
    const [sourceId, targetId] = key.split("::") as [string, string];
    adjacency.set(sourceId, [...(adjacency.get(sourceId) ?? []), targetId].sort(sortStrings));
    adjacency.set(targetId, [...(adjacency.get(targetId) ?? []), sourceId].sort(sortStrings));
  }

  return adjacency;
}

function collectConnectedNodeIds(
  startNodeId: string,
  adjacency: Map<string, string[]>,
  visited: Set<string>
): string[] {
  const queue = [startNodeId];
  const componentNodeIds: string[] = [];

  while (queue.length > 0) {
    const currentNodeId = queue.shift() as string;
    if (visited.has(currentNodeId)) {
      continue;
    }
    visited.add(currentNodeId);
    componentNodeIds.push(currentNodeId);

    for (const neighborNodeId of adjacency.get(currentNodeId) ?? []) {
      if (!visited.has(neighborNodeId)) {
        queue.push(neighborNodeId);
      }
    }
  }

  return componentNodeIds.sort(sortStrings);
}

function countEdgesWithinComponent(componentNodeIds: string[], edgeKeys: string[]): number {
  const componentNodeSet = new Set(componentNodeIds);
  return edgeKeys.filter((key) => {
    const [sourceId, targetId] = key.split("::") as [string, string];
    return componentNodeSet.has(sourceId) && componentNodeSet.has(targetId);
  }).length;
}

function materializeHardEdges(
  taskIds: string[],
  entries: Array<[number, number, boolean, Extract<EdgeType, "depends_on" | "waits_for">]>,
  options: { allowDuplicates: boolean; allowSelfLoops: boolean }
): TopologyHardEdgeBlueprint[] {
  const hardEdges: TopologyHardEdgeBlueprint[] = [];
  const seenUndirectedPairs = new Set<string>();

  for (const [leftIndex, rightIndex, keepDirection, edgeType] of entries) {
    const leftNodeId = taskIds[leftIndex] as string;
    const rightNodeId = taskIds[rightIndex] as string;
    const undirectedKey = edgeKey(leftNodeId, rightNodeId);

    if (
      !shouldIncludeHardEdge(leftNodeId, rightNodeId, undirectedKey, seenUndirectedPairs, options)
    ) {
      continue;
    }

    seenUndirectedPairs.add(undirectedKey);
    hardEdges.push(
      buildHardEdge(hardEdges.length, leftNodeId, rightNodeId, keepDirection, edgeType)
    );
  }

  return hardEdges;
}

function shouldIncludeHardEdge(
  leftNodeId: string,
  rightNodeId: string,
  undirectedKey: string,
  seenUndirectedPairs: Set<string>,
  options: { allowDuplicates: boolean; allowSelfLoops: boolean }
): boolean {
  if (!options.allowSelfLoops && leftNodeId === rightNodeId) {
    return false;
  }
  if (!options.allowDuplicates && seenUndirectedPairs.has(undirectedKey)) {
    return false;
  }
  return true;
}

function buildHardEdge(
  index: number,
  leftNodeId: string,
  rightNodeId: string,
  keepDirection: boolean,
  edgeType: Extract<EdgeType, "depends_on" | "waits_for">
): TopologyHardEdgeBlueprint {
  return {
    edge_id: `hard_${index}`,
    type: edgeType,
    source_id: keepDirection ? leftNodeId : rightNodeId,
    target_id: keepDirection ? rightNodeId : leftNodeId
  };
}

function canonicalizeNodePair(leftNodeId: string, rightNodeId: string): [string, string] {
  return leftNodeId.localeCompare(rightNodeId) <= 0
    ? [leftNodeId, rightNodeId]
    : [rightNodeId, leftNodeId];
}

function edgeKey(leftNodeId: string, rightNodeId: string): string {
  const [sourceId, targetId] = canonicalizeNodePair(leftNodeId, rightNodeId);
  return `${sourceId}::${targetId}`;
}

function sortStrings(left: string, right: string): number {
  return left.localeCompare(right);
}
