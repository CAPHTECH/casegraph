import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  analyzeBottlenecks,
  analyzeBridges,
  analyzeComponents,
  analyzeCriticalPath,
  analyzeCutpoints,
  analyzeCycles,
  analyzeFragility,
  analyzeImpact,
  analyzeMinimalUnblockSet,
  analyzeSlack,
  type BottleneckAnalysisResult,
  type BridgeAnalysisResult,
  type ComponentAnalysisResult,
  type CriticalPathAnalysisResult,
  type CutpointAnalysisResult,
  type CycleAnalysisResult,
  type EventEnvelope,
  type FragilityAnalysisResult,
  type ImpactAnalysisResult,
  type MinimalUnblockSetResult,
  replayCaseEvents,
  type SlackAnalysisResult,
  type TopologyProjection
} from "@caphtech/casegraph-core";
import {
  analyzeTopology,
  type TopologyAnalysisResult
} from "@caphtech/casegraph-core/experimental";

export type EvalQueryKind =
  | "impact"
  | "critical_path"
  | "slack"
  | "bottlenecks"
  | "unblock"
  | "topology"
  | "cycles"
  | "components"
  | "bridges"
  | "cutpoints"
  | "fragility";

export interface EvalHitRate {
  hits: number;
  total: number;
  hit_rate: number;
}

export interface EvalQueryLabels {
  must_include_node_ids?: string[];
  must_not_include_node_ids?: string[];
  expected_warning_ids?: string[];
  expected_beta_0?: number;
  expected_beta_1?: number;
  expected_component_count?: number;
  expected_component_node_sets?: string[][];
  expected_cycle_node_sets?: string[][];
  expected_bridge_pairs?: string[];
  expected_cutpoint_ids?: string[];
  top_k_contains?: string[];
}

export interface EvalQuerySpec {
  name: string;
  kind: EvalQueryKind;
  projection?: TopologyProjection;
  source_node_id?: string;
  goal_node_id?: string | null;
  target_node_id?: string;
  labels?: EvalQueryLabels;
}

export interface EvalCorpusSpec {
  corpus_id: string;
  events_file: string;
  queries: EvalQuerySpec[];
}

export interface EvalManifest {
  corpora: EvalCorpusSpec[];
}

export interface EvalQueryMetric {
  manifest_id: string;
  corpus_id: string;
  query_name: string;
  kind: EvalQueryKind;
  checks: Record<string, boolean>;
  partial_label_checks: Record<string, boolean>;
}

export interface EventEvalMetrics {
  manifest_count: number;
  corpus_count: number;
  query_count: number;
  invariant: {
    overall: EvalHitRate;
    by_check: Record<string, EvalHitRate>;
  };
  partial_labels: {
    overall: EvalHitRate;
    by_check: Record<string, EvalHitRate>;
  };
  queries: EvalQueryMetric[];
  external_manifest: {
    path: string | null;
    loaded: boolean;
    skipped: boolean;
  };
}

type AnalysisQueryResult =
  | { kind: "impact"; result: ImpactAnalysisResult }
  | { kind: "critical_path"; result: CriticalPathAnalysisResult }
  | { kind: "slack"; result: SlackAnalysisResult }
  | { kind: "bottlenecks"; result: BottleneckAnalysisResult }
  | { kind: "unblock"; result: MinimalUnblockSetResult }
  | { kind: "topology"; result: TopologyAnalysisResult }
  | { kind: "cycles"; result: CycleAnalysisResult }
  | { kind: "components"; result: ComponentAnalysisResult }
  | { kind: "bridges"; result: BridgeAnalysisResult }
  | { kind: "cutpoints"; result: CutpointAnalysisResult }
  | { kind: "fragility"; result: FragilityAnalysisResult };

export async function collectEventEvalMetrics(options: {
  builtinManifestPath: string;
  externalManifestPath?: string;
}): Promise<EventEvalMetrics> {
  const manifestPaths = [options.builtinManifestPath];
  let externalManifestLoaded = false;

  if (options.externalManifestPath) {
    manifestPaths.push(options.externalManifestPath);
    externalManifestLoaded = true;
  }

  const queryMetrics: EvalQueryMetric[] = [];
  let corpusCount = 0;

  for (const manifestPath of manifestPaths) {
    const manifest = await loadEvalManifest(manifestPath);
    corpusCount += manifest.corpora.length;
    for (const corpus of manifest.corpora) {
      const events = await loadEventsFile(manifestPath, corpus.events_file);
      const state = replayCaseEvents(events);

      for (const query of corpus.queries) {
        queryMetrics.push(
          await evaluateQueryMetric(path.basename(manifestPath), corpus.corpus_id, state, query)
        );
      }
    }
  }

  return {
    manifest_count: manifestPaths.length,
    corpus_count: corpusCount,
    query_count: queryMetrics.length,
    invariant: {
      overall: summarizeQueryChecks(queryMetrics, "checks"),
      by_check: summarizeChecksByName(queryMetrics, "checks")
    },
    partial_labels: {
      overall: summarizeQueryChecks(queryMetrics, "partial_label_checks"),
      by_check: summarizeChecksByName(queryMetrics, "partial_label_checks")
    },
    queries: queryMetrics,
    external_manifest: {
      path: options.externalManifestPath ?? null,
      loaded: externalManifestLoaded,
      skipped: !externalManifestLoaded
    }
  };
}

async function loadEvalManifest(manifestPath: string): Promise<EvalManifest> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<EvalManifest>;
  if (!Array.isArray(raw.corpora)) {
    throw new Error(`Invalid analysis eval manifest: ${manifestPath}`);
  }
  return { corpora: raw.corpora };
}

async function loadEventsFile(
  manifestPath: string,
  relativeEventsPath: string
): Promise<EventEnvelope[]> {
  const resolvedPath = path.resolve(path.dirname(manifestPath), relativeEventsPath);
  const contents = await readFile(resolvedPath, "utf8");
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as EventEnvelope[];
  }

  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope);
}

async function evaluateQueryMetric(
  manifestId: string,
  corpusId: string,
  state: ReturnType<typeof replayCaseEvents>,
  query: EvalQuerySpec
): Promise<EvalQueryMetric> {
  const firstRun = runAnalysisQuery(state, query);
  const secondRun = runAnalysisQuery(state, query);

  return {
    manifest_id: manifestId,
    corpus_id: corpusId,
    query_name: query.name,
    kind: query.kind,
    checks: {
      deterministic_repeat: stableStringify(firstRun.result) === stableStringify(secondRun.result),
      ...evaluateInvariantChecks(state, firstRun)
    },
    partial_label_checks: evaluatePartialLabelChecks(firstRun, query.labels)
  };
}

function runAnalysisQuery(
  state: ReturnType<typeof replayCaseEvents>,
  query: EvalQuerySpec
): AnalysisQueryResult {
  switch (query.kind) {
    case "impact":
      return {
        kind: "impact",
        result: analyzeImpact(state, query.source_node_id as string)
      };
    case "critical_path":
      return {
        kind: "critical_path",
        result: analyzeCriticalPath(state, query.goal_node_id ?? undefined)
      };
    case "slack":
      return {
        kind: "slack",
        result: analyzeSlack(state, query.goal_node_id ?? undefined)
      };
    case "bottlenecks":
      return {
        kind: "bottlenecks",
        result: analyzeBottlenecks(state, query.goal_node_id ?? undefined)
      };
    case "unblock":
      return {
        kind: "unblock",
        result: analyzeMinimalUnblockSet(state, query.target_node_id as string)
      };
    case "topology":
      return {
        kind: "topology",
        result: analyzeTopology(state, {
          projection: query.projection,
          goalNodeId: query.goal_node_id ?? undefined
        })
      };
    case "cycles":
      return {
        kind: "cycles",
        result: analyzeCycles(state, {
          projection: query.projection,
          goalNodeId: query.goal_node_id ?? undefined
        })
      };
    case "components":
      return {
        kind: "components",
        result: analyzeComponents(state, {
          projection: query.projection,
          goalNodeId: query.goal_node_id ?? undefined
        })
      };
    case "bridges":
      return {
        kind: "bridges",
        result: analyzeBridges(state, {
          projection: query.projection,
          goalNodeId: query.goal_node_id ?? undefined
        })
      };
    case "cutpoints":
      return {
        kind: "cutpoints",
        result: analyzeCutpoints(state, {
          projection: query.projection,
          goalNodeId: query.goal_node_id ?? undefined
        })
      };
    case "fragility":
      return {
        kind: "fragility",
        result: analyzeFragility(state, {
          projection: query.projection,
          goalNodeId: query.goal_node_id ?? undefined
        })
      };
  }
}

function evaluateInvariantChecks(
  state: ReturnType<typeof replayCaseEvents>,
  queryResult: AnalysisQueryResult
): Record<string, boolean> {
  switch (queryResult.kind) {
    case "impact":
      return {
        referenced_nodes_exist: allNodeIdsExist(state, collectImpactNodeIds(queryResult.result)),
        referenced_edges_exist: allEdgeIdsExist(state, collectImpactEdgeIds(queryResult.result)),
        frontier_invalidations_subset_hard_impact: queryResult.result.frontier_invalidations.every(
          (node) =>
            queryResult.result.hard_impact.some((hardNode) => hardNode.node_id === node.node_id)
        )
      };
    case "critical_path":
      return {
        depth_nodes_exist: allNodeIdsExist(state, queryResult.result.depth_path.node_ids),
        depth_edges_exist: allEdgeIdsExist(state, queryResult.result.depth_path.edge_ids),
        duration_matches_step_estimates: durationMatchesStepEstimates(queryResult.result),
        missing_estimate_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.missing_estimate_node_ids
        )
      };
    case "slack":
      return {
        slack_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.nodes.map((node) => node.node_id)
        ),
        critical_nodes_have_zero_slack: queryResult.result.nodes.every(
          (node) => !node.is_critical || node.slack_minutes === 0
        ),
        schedule_bounds_monotonic: queryResult.result.nodes.every(
          (node) =>
            node.earliest_start_minutes <= node.earliest_finish_minutes &&
            node.latest_start_minutes <= node.latest_finish_minutes &&
            node.earliest_start_minutes <= node.latest_start_minutes
        )
      };
    case "bottlenecks":
      return {
        bottleneck_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.nodes.map((node) => node.node_id)
        ),
        downstream_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.nodes.flatMap((node) => node.downstream_node_ids)
        ),
        frontier_invalidations_subset_downstream: queryResult.result.nodes.every((node) =>
          node.frontier_invalidation_node_ids.every((downstreamNodeId) =>
            node.downstream_node_ids.includes(downstreamNodeId)
          )
        )
      };
    case "unblock":
      return {
        blocker_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.blockers.map((blocker) => blocker.node_id)
        ),
        actionable_leafs_are_blockers: queryResult.result.actionable_leaf_node_ids.every((nodeId) =>
          queryResult.result.blockers.some((blocker) => blocker.node_id === nodeId)
        ),
        blocker_paths_reach_target: queryResult.result.blockers.every(
          (blocker) =>
            blocker.via_node_ids[blocker.via_node_ids.length - 1] ===
              queryResult.result.target_node_id &&
            allNodeIdsExist(state, blocker.via_node_ids) &&
            allEdgeIdsExist(state, blocker.via_edge_ids)
        )
      };
    case "topology":
      return {
        topology_component_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.components.flatMap((component) => component.node_ids)
        ),
        topology_components_cover_node_count: topologyComponentsCoverNodeCount(queryResult.result),
        topology_component_edge_counts_sum: topologyComponentEdgeCountsMatch(queryResult.result),
        topology_cycle_witness_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.cycle_witnesses.flatMap((witness) => witness.node_ids)
        ),
        topology_cycle_witness_edges_exist: topologyWitnessEdgesExist(state, queryResult.result),
        topology_betti_formula_consistent:
          queryResult.result.beta_1 ===
          queryResult.result.edge_count - queryResult.result.node_count + queryResult.result.beta_0
      };
    case "cycles":
      return {
        cycle_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.cycles.flatMap((cycle) => cycle.node_ids)
        ),
        cycle_edges_exist: queryResult.result.cycles.every((cycle) =>
          cycle.edge_pairs.every((edgePair) =>
            hasHardEdgePair(state, edgePair.source_id, edgePair.target_id)
          )
        ),
        cycle_count_matches_surface:
          queryResult.result.cycle_count === queryResult.result.cycles.length
      };
    case "components":
      return {
        component_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.components.flatMap((component) => component.node_ids)
        ),
        component_nodes_cover_count:
          queryResult.result.components.reduce(
            (sum, component) => sum + component.node_count,
            0
          ) === queryResult.result.components.flatMap((component) => component.node_ids).length,
        component_count_matches_surface:
          queryResult.result.component_count === queryResult.result.components.length
      };
    case "bridges":
      return {
        bridge_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.bridges.flatMap((bridge) => [
            bridge.source_id,
            bridge.target_id,
            ...bridge.left_node_ids,
            ...bridge.right_node_ids
          ])
        ),
        bridge_partitions_non_empty: queryResult.result.bridges.every(
          (bridge) => bridge.left_node_ids.length > 0 && bridge.right_node_ids.length > 0
        ),
        bridge_partitions_disjoint: queryResult.result.bridges.every((bridge) =>
          bridge.left_node_ids.every((nodeId) => !bridge.right_node_ids.includes(nodeId))
        )
      };
    case "cutpoints":
      return {
        cutpoint_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.cutpoints.map((cutpoint) => cutpoint.node_id)
        ),
        cutpoint_partitions_non_empty: queryResult.result.cutpoints.every((cutpoint) =>
          cutpoint.separated_component_node_sets.every((nodeIds) => nodeIds.length > 0)
        ),
        cutpoint_partitions_exclude_cutpoint: queryResult.result.cutpoints.every((cutpoint) =>
          cutpoint.separated_component_node_sets.every(
            (nodeIds) => !nodeIds.includes(cutpoint.node_id)
          )
        )
      };
    case "fragility":
      return {
        fragility_nodes_exist: allNodeIdsExist(
          state,
          queryResult.result.nodes.map((node) => node.node_id)
        ),
        fragility_scores_descending: queryResult.result.nodes.every((node, index, nodes) => {
          const previousNode = nodes[index - 1];
          return !previousNode || previousNode.fragility_score >= node.fragility_score;
        }),
        fragility_reason_tags_nonempty: queryResult.result.nodes.every(
          (node) => node.reason_tags.length > 0
        )
      };
  }
}

function evaluatePartialLabelChecks(
  queryResult: AnalysisQueryResult,
  labels: EvalQueryLabels | undefined
): Record<string, boolean> {
  if (!labels) {
    return {};
  }

  const checks: Record<string, boolean> = {};
  const referencedNodeIds = new Set(collectReferencedNodeIds(queryResult));
  const warnings = collectWarnings(queryResult);
  const primaryRankingNodeIds = collectPrimaryRankingNodeIds(queryResult);

  if (labels.must_include_node_ids) {
    checks.must_include_node_ids = labels.must_include_node_ids.every((nodeId) =>
      referencedNodeIds.has(nodeId)
    );
  }
  if (labels.must_not_include_node_ids) {
    checks.must_not_include_node_ids = labels.must_not_include_node_ids.every(
      (nodeId) => !referencedNodeIds.has(nodeId)
    );
  }
  if (labels.expected_warning_ids) {
    checks.expected_warning_ids = labels.expected_warning_ids.every((warningId) =>
      warnings.includes(warningId)
    );
  }
  applyExpectedTopologyChecks(checks, queryResult, labels);
  applyExpectedStructureChecks(checks, queryResult, labels);
  if (labels.top_k_contains) {
    const topKNodeIds = primaryRankingNodeIds.slice(0, labels.top_k_contains.length);
    checks.top_k_contains = labels.top_k_contains.every((nodeId) => topKNodeIds.includes(nodeId));
  }

  return checks;
}

function collectReferencedNodeIds(queryResult: AnalysisQueryResult): string[] {
  switch (queryResult.kind) {
    case "impact":
      return collectImpactNodeIds(queryResult.result);
    case "critical_path":
      return [
        ...queryResult.result.depth_path.node_ids,
        ...(queryResult.result.duration_path?.node_ids ?? []),
        ...queryResult.result.missing_estimate_node_ids
      ];
    case "slack":
      return queryResult.result.nodes.map((node) => node.node_id);
    case "bottlenecks":
      return queryResult.result.nodes.flatMap((node) => [
        node.node_id,
        ...node.downstream_node_ids,
        ...node.frontier_invalidation_node_ids,
        ...node.goal_context_node_ids
      ]);
    case "unblock":
      return [
        queryResult.result.target_node_id,
        ...queryResult.result.actionable_leaf_node_ids,
        ...queryResult.result.blockers.flatMap((blocker) => [
          blocker.node_id,
          ...blocker.via_node_ids
        ])
      ];
    case "topology":
      return [
        ...queryResult.result.components.flatMap((component) => component.node_ids),
        ...queryResult.result.cycle_witnesses.flatMap((witness) => witness.node_ids)
      ];
    case "cycles":
      return queryResult.result.cycles.flatMap((cycle) => cycle.node_ids);
    case "components":
      return queryResult.result.components.flatMap((component) => component.node_ids);
    case "bridges":
      return queryResult.result.bridges.flatMap((bridge) => [
        bridge.source_id,
        bridge.target_id,
        ...bridge.left_node_ids,
        ...bridge.right_node_ids
      ]);
    case "cutpoints":
      return queryResult.result.cutpoints.flatMap((cutpoint) => [
        cutpoint.node_id,
        ...cutpoint.separated_component_node_sets.flat()
      ]);
    case "fragility":
      return queryResult.result.nodes.map((node) => node.node_id);
  }
}

function applyExpectedTopologyChecks(
  checks: Record<string, boolean>,
  queryResult: AnalysisQueryResult,
  labels: EvalQueryLabels
): void {
  if (labels.expected_beta_0 !== undefined && queryResult.kind === "topology") {
    checks.expected_beta_0 = queryResult.result.beta_0 === labels.expected_beta_0;
  }
  if (labels.expected_beta_1 !== undefined && queryResult.kind === "topology") {
    checks.expected_beta_1 = queryResult.result.beta_1 === labels.expected_beta_1;
  }
  if (labels.expected_component_count !== undefined) {
    checks.expected_component_count = matchesExpectedComponentCount(
      queryResult,
      labels.expected_component_count
    );
  }
  if (labels.expected_component_node_sets) {
    checks.expected_component_node_sets = matchExpectedComponentNodeSets(
      queryResult,
      labels.expected_component_node_sets
    );
  }
}

function applyExpectedStructureChecks(
  checks: Record<string, boolean>,
  queryResult: AnalysisQueryResult,
  labels: EvalQueryLabels
): void {
  if (labels.expected_cycle_node_sets && queryResult.kind === "cycles") {
    checks.expected_cycle_node_sets = labels.expected_cycle_node_sets.every((expectedNodeIds) =>
      queryResult.result.cycles.some(
        (cycle) => stableNodeSetKey(cycle.node_ids) === stableNodeSetKey(expectedNodeIds)
      )
    );
  }
  if (labels.expected_bridge_pairs && queryResult.kind === "bridges") {
    checks.expected_bridge_pairs = labels.expected_bridge_pairs.every((expectedBridgePair) =>
      queryResult.result.bridges.some(
        (bridge) => `${bridge.source_id}::${bridge.target_id}` === expectedBridgePair
      )
    );
  }
  if (labels.expected_cutpoint_ids && queryResult.kind === "cutpoints") {
    checks.expected_cutpoint_ids = labels.expected_cutpoint_ids.every((nodeId) =>
      queryResult.result.cutpoints.some((cutpoint) => cutpoint.node_id === nodeId)
    );
  }
}

function collectPrimaryRankingNodeIds(queryResult: AnalysisQueryResult): string[] {
  switch (queryResult.kind) {
    case "impact":
      return queryResult.result.hard_impact.map((node) => node.node_id);
    case "critical_path":
      return queryResult.result.depth_path.node_ids;
    case "slack":
      return queryResult.result.nodes.map((node) => node.node_id);
    case "bottlenecks":
      return queryResult.result.nodes.map((node) => node.node_id);
    case "unblock":
      return queryResult.result.actionable_leaf_node_ids;
    case "topology":
      return queryResult.result.components[0]?.node_ids ?? [];
    case "cycles":
      return queryResult.result.cycles[0]?.node_ids ?? [];
    case "components":
      return queryResult.result.components[0]?.node_ids ?? [];
    case "bridges":
      return queryResult.result.bridges.map((bridge) => bridge.source_id);
    case "cutpoints":
      return queryResult.result.cutpoints.map((cutpoint) => cutpoint.node_id);
    case "fragility":
      return queryResult.result.nodes.map((node) => node.node_id);
  }
}

function collectWarnings(queryResult: AnalysisQueryResult): string[] {
  return queryResult.result.warnings;
}

function collectImpactNodeIds(result: ImpactAnalysisResult): string[] {
  return [
    ...result.hard_impact.map((node) => node.node_id),
    ...result.context_impact.map((node) => node.node_id),
    ...result.frontier_invalidations.map((node) => node.node_id)
  ];
}

function collectImpactEdgeIds(result: ImpactAnalysisResult): string[] {
  return [
    ...result.hard_impact.flatMap((node) => node.via_edge_ids),
    ...result.context_impact.flatMap((node) => node.via_edge_ids),
    ...result.frontier_invalidations.flatMap((node) => node.via_edge_ids)
  ];
}

function durationMatchesStepEstimates(result: CriticalPathAnalysisResult): boolean {
  if (!result.duration_path) {
    return true;
  }

  const totalEstimateMinutes = result.duration_path.steps.reduce(
    (sum, step) => sum + (step.estimate_minutes ?? 0),
    0
  );
  return result.duration_path.total_estimate_minutes === totalEstimateMinutes;
}

function allNodeIdsExist(state: ReturnType<typeof replayCaseEvents>, nodeIds: string[]): boolean {
  return nodeIds.every((nodeId) => state.nodes.has(nodeId));
}

function allEdgeIdsExist(state: ReturnType<typeof replayCaseEvents>, edgeIds: string[]): boolean {
  return edgeIds.every((edgeId) => state.edges.has(edgeId));
}

function topologyComponentsCoverNodeCount(result: TopologyAnalysisResult): boolean {
  const nodeIds = result.components.flatMap((component) => component.node_ids);
  return nodeIds.length === result.node_count && new Set(nodeIds).size === result.node_count;
}

function topologyComponentEdgeCountsMatch(result: TopologyAnalysisResult): boolean {
  const totalComponentEdges = result.components.reduce(
    (sum, component) => sum + component.edge_count,
    0
  );
  return totalComponentEdges === result.edge_count;
}

function topologyWitnessEdgesExist(
  state: ReturnType<typeof replayCaseEvents>,
  result: TopologyAnalysisResult
): boolean {
  return result.cycle_witnesses.every((witness) =>
    witness.edge_pairs.every((edgePair) =>
      hasHardEdgePair(state, edgePair.source_id, edgePair.target_id)
    )
  );
}

function hasHardEdgePair(
  state: ReturnType<typeof replayCaseEvents>,
  leftNodeId: string,
  rightNodeId: string
): boolean {
  return [...state.edges.values()].some((edge) => {
    if (!(edge.type === "depends_on" || edge.type === "waits_for")) {
      return false;
    }
    return (
      (edge.source_id === leftNodeId && edge.target_id === rightNodeId) ||
      (edge.source_id === rightNodeId && edge.target_id === leftNodeId)
    );
  });
}

function matchesExpectedComponentCount(
  queryResult: AnalysisQueryResult,
  expectedComponentCount: number
): boolean {
  if (queryResult.kind === "topology") {
    return queryResult.result.components.length === expectedComponentCount;
  }
  if (queryResult.kind === "components") {
    return queryResult.result.component_count === expectedComponentCount;
  }
  return false;
}

function matchExpectedComponentNodeSets(
  queryResult: AnalysisQueryResult,
  expectedNodeSets: string[][]
): boolean {
  if (queryResult.kind === "topology") {
    return expectedNodeSets.every((expectedNodeIds) =>
      queryResult.result.components.some(
        (component) => stableNodeSetKey(component.node_ids) === stableNodeSetKey(expectedNodeIds)
      )
    );
  }
  if (queryResult.kind === "components") {
    return expectedNodeSets.every((expectedNodeIds) =>
      queryResult.result.components.some(
        (component) => stableNodeSetKey(component.node_ids) === stableNodeSetKey(expectedNodeIds)
      )
    );
  }
  return false;
}

function stableNodeSetKey(nodeIds: string[]): string {
  return [...nodeIds].sort((left, right) => left.localeCompare(right)).join("|");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function summarizeQueryChecks(
  queryMetrics: EvalQueryMetric[],
  field: "checks" | "partial_label_checks"
): EvalHitRate {
  const hits = queryMetrics.reduce(
    (total, query) => total + Object.values(query[field]).filter(Boolean).length,
    0
  );
  const total = queryMetrics.reduce((sum, query) => sum + Object.keys(query[field]).length, 0);
  return {
    hits,
    total,
    hit_rate: total === 0 ? 1 : hits / total
  };
}

function summarizeChecksByName(
  queryMetrics: EvalQueryMetric[],
  field: "checks" | "partial_label_checks"
): Record<string, EvalHitRate> {
  const aggregate = new Map<string, { hits: number; total: number }>();

  for (const query of queryMetrics) {
    for (const [checkName, passed] of Object.entries(query[field])) {
      const current = aggregate.get(checkName) ?? { hits: 0, total: 0 };
      aggregate.set(checkName, {
        hits: current.hits + (passed ? 1 : 0),
        total: current.total + 1
      });
    }
  }

  return Object.fromEntries(
    [...aggregate.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([checkName, value]) => [
        checkName,
        {
          hits: value.hits,
          total: value.total,
          hit_rate: value.total === 0 ? 1 : value.hits / value.total
        }
      ])
  );
}
