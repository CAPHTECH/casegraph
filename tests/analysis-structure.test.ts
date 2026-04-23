import {
  analyzeBridges,
  analyzeComponents,
  analyzeCutpoints,
  analyzeCycles,
  analyzeFragility,
  type BridgeAnalysisResult,
  type ComponentAnalysisResult,
  type CutpointAnalysisResult,
  type CycleAnalysisResult,
  createEvent,
  defaultActor,
  type FragilityAnalysisResult,
  replayCaseEvents
} from "@caphtech/casegraph-core";
import { describe, expect, it } from "vitest";

interface TestNodeInput {
  node_id: string;
  kind?: "goal" | "task" | "decision" | "event" | "evidence";
  state?: "proposed" | "todo" | "doing" | "waiting" | "done" | "cancelled" | "failed";
  title?: string;
}

interface TestEdgeInput {
  edge_id: string;
  type?: "depends_on" | "waits_for" | "alternative_to" | "verifies" | "contributes_to";
  source_id: string;
  target_id: string;
}

describe("user-facing structure analyses", () => {
  it("reports cycles, components, bridges, cutpoints, and fragility from the same graph", () => {
    const state = buildState({
      caseId: "structure-case",
      nodes: [
        { node_id: "goal_release_ready", kind: "goal" },
        { node_id: "task_prepare" },
        { node_id: "task_review" },
        { node_id: "task_publish" },
        { node_id: "task_docs" },
        { node_id: "task_cleanup" },
        { node_id: "task_archive" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_review", target_id: "task_prepare" },
        { edge_id: "e2", source_id: "task_publish", target_id: "task_review" },
        { edge_id: "e3", source_id: "task_prepare", target_id: "task_publish" },
        { edge_id: "e4", source_id: "task_docs", target_id: "task_prepare" },
        { edge_id: "e5", source_id: "task_archive", target_id: "task_cleanup" },
        {
          edge_id: "e6",
          type: "contributes_to",
          source_id: "task_publish",
          target_id: "goal_release_ready"
        },
        {
          edge_id: "e7",
          type: "contributes_to",
          source_id: "task_docs",
          target_id: "goal_release_ready"
        }
      ]
    });

    const cycles = analyzeCycles(state);
    expect(cycles.cycle_count).toBe(1);
    expect(cycles.cycles).toEqual([
      {
        node_ids: ["task_prepare", "task_publish", "task_review"],
        edge_pairs: [
          { source_id: "task_prepare", target_id: "task_publish" },
          { source_id: "task_prepare", target_id: "task_review" },
          { source_id: "task_publish", target_id: "task_review" }
        ]
      }
    ]);
    expect(cycles.explanations[0]).toMatchObject({
      kind: "cycle",
      label: "dependency loop 1",
      evidence: {
        projection: "hard_unresolved",
        goal_node_id: null,
        cycle_count: 1,
        node_ids: ["task_prepare", "task_publish", "task_review"]
      }
    });
    expectCycleExplanationsToMatchEvidence(cycles);

    const components = analyzeComponents(state);
    expect(components.component_count).toBe(3);
    expect(components.components).toEqual([
      { node_ids: ["goal_release_ready"], edge_count: 0, node_count: 1 },
      { node_ids: ["task_archive", "task_cleanup"], edge_count: 1, node_count: 2 },
      {
        node_ids: ["task_docs", "task_prepare", "task_publish", "task_review"],
        edge_count: 4,
        node_count: 4
      }
    ]);
    expect(components.explanations[2]).toMatchObject({
      kind: "component",
      label: "work region 3",
      evidence: {
        component_count: 3,
        node_count: 4,
        edge_count: 4
      }
    });
    expectComponentExplanationsToMatchEvidence(components);

    const bridges = analyzeBridges(state);
    expect(bridges.bridges).toEqual([
      {
        source_id: "task_archive",
        target_id: "task_cleanup",
        left_node_ids: ["task_archive"],
        right_node_ids: ["task_cleanup"]
      },
      {
        source_id: "task_docs",
        target_id: "task_prepare",
        left_node_ids: ["task_docs"],
        right_node_ids: ["task_prepare", "task_publish", "task_review"]
      }
    ]);
    expect(bridges.explanations[1]).toMatchObject({
      kind: "bridge",
      label: "single dependency edge 2",
      evidence: {
        bridge_count: 2,
        source_id: "task_docs",
        target_id: "task_prepare",
        left_node_ids: ["task_docs"],
        right_node_ids: ["task_prepare", "task_publish", "task_review"]
      }
    });
    expectBridgeExplanationsToMatchEvidence(bridges);

    const cutpoints = analyzeCutpoints(state);
    expect(cutpoints.cutpoints).toEqual([
      {
        node_id: "task_prepare",
        separated_component_count: 2,
        separated_component_node_sets: [["task_docs"], ["task_publish", "task_review"]]
      }
    ]);
    expect(cutpoints.explanations[0]).toMatchObject({
      kind: "cutpoint",
      label: "single separating node 1",
      evidence: {
        cutpoint_count: 1,
        node_id: "task_prepare",
        separated_component_count: 2,
        separated_component_node_sets: [["task_docs"], ["task_publish", "task_review"]]
      }
    });
    expectCutpointExplanationsToMatchEvidence(cutpoints);

    const fragility = analyzeFragility(state);
    expect(fragility.nodes.map((node) => node.node_id)).toEqual([
      "task_prepare",
      "task_archive",
      "task_cleanup",
      "task_docs"
    ]);
    expect(fragility.nodes[0]).toMatchObject({
      node_id: "task_prepare",
      fragility_score: 13,
      incident_bridge_count: 1,
      cutpoint_component_count: 2,
      reason_tags: ["cutpoint", "bridge"]
    });
    expect(fragility.warnings).toContain("bottleneck_signal_unavailable_due_to_cycles");
    expect(fragility.explanations[0]).toMatchObject({
      kind: "fragility",
      label: "intervention candidate 1",
      evidence: {
        rank: 1,
        node_id: "task_prepare",
        fragility_score: 13,
        reason_tags: ["cutpoint", "bridge"],
        warnings: ["bottleneck_signal_unavailable_due_to_cycles"]
      }
    });
    expectFragilityExplanationsToMatchEvidence(fragility);
  });

  it("keeps simple dependency-loop explanations aligned with edge-pair evidence", () => {
    const state = buildState({
      caseId: "simple-cycle-explanation-case",
      nodes: [{ node_id: "task_a" }, { node_id: "task_b" }, { node_id: "task_c" }],
      edges: [
        { edge_id: "edge_b_a", source_id: "task_b", target_id: "task_a" },
        { edge_id: "edge_c_b", source_id: "task_c", target_id: "task_b" },
        { edge_id: "edge_a_c", source_id: "task_a", target_id: "task_c" }
      ]
    });

    const cycles = analyzeCycles(state);

    expect(cycles.cycles).toEqual([
      {
        node_ids: ["task_a", "task_b", "task_c"],
        edge_pairs: [
          { source_id: "task_a", target_id: "task_b" },
          { source_id: "task_a", target_id: "task_c" },
          { source_id: "task_b", target_id: "task_c" }
        ]
      }
    ]);
    expect(cycles.explanations[0]).toMatchObject({
      kind: "cycle",
      label: "dependency loop 1",
      summary: "Involves 3 unresolved nodes: task_a,task_b,task_c."
    });
    expectCycleExplanationsToMatchEvidence(cycles);
  });

  it("ignores self-loops and duplicate hard edges when explaining noisy figure-eight structure", () => {
    const state = buildState({
      caseId: "noisy-figure-eight-explanation-case",
      nodes: [
        { node_id: "task_a" },
        { node_id: "task_b" },
        { node_id: "task_c" },
        { node_id: "task_d" },
        { node_id: "task_e" },
        { node_id: "task_forest_a" },
        { node_id: "task_forest_b" },
        { node_id: "task_forest_c" },
        { node_id: "task_forest_d" }
      ],
      edges: [
        { edge_id: "edge_b_a", source_id: "task_b", target_id: "task_a" },
        { edge_id: "edge_c_b", source_id: "task_c", target_id: "task_b" },
        { edge_id: "edge_a_c", source_id: "task_a", target_id: "task_c" },
        { edge_id: "edge_d_c", source_id: "task_d", target_id: "task_c" },
        { edge_id: "edge_e_d", source_id: "task_e", target_id: "task_d" },
        { edge_id: "edge_c_e", source_id: "task_c", target_id: "task_e" },
        { edge_id: "edge_a_b_duplicate", source_id: "task_a", target_id: "task_b" },
        { edge_id: "edge_a_a_self", source_id: "task_a", target_id: "task_a" },
        { edge_id: "edge_forest_b_a", source_id: "task_forest_b", target_id: "task_forest_a" },
        { edge_id: "edge_forest_d_c", source_id: "task_forest_d", target_id: "task_forest_c" }
      ]
    });

    const cycles = analyzeCycles(state);
    expect(cycles.warnings).toEqual(["self_loop_ignored"]);
    expect(cycles.cycles).toEqual([
      {
        node_ids: ["task_a", "task_b", "task_c"],
        edge_pairs: [
          { source_id: "task_a", target_id: "task_b" },
          { source_id: "task_a", target_id: "task_c" },
          { source_id: "task_b", target_id: "task_c" }
        ]
      },
      {
        node_ids: ["task_c", "task_d", "task_e"],
        edge_pairs: [
          { source_id: "task_c", target_id: "task_d" },
          { source_id: "task_c", target_id: "task_e" },
          { source_id: "task_d", target_id: "task_e" }
        ]
      }
    ]);
    expect(
      edgePairKeys(cycles.explanations.flatMap((explanation) => explanation.evidence.edge_pairs))
    ).not.toContain("task_a::task_a");
    expect(
      edgePairKeys(cycles.explanations[0]?.evidence.edge_pairs ?? []).filter(
        (edgeKey) => edgeKey === "task_a::task_b"
      )
    ).toHaveLength(1);
    expectCycleExplanationsToMatchEvidence(cycles);

    const components = analyzeComponents(state);
    expect(components.components).toEqual([
      {
        node_ids: ["task_a", "task_b", "task_c", "task_d", "task_e"],
        edge_count: 6,
        node_count: 5
      },
      { node_ids: ["task_forest_a", "task_forest_b"], edge_count: 1, node_count: 2 },
      { node_ids: ["task_forest_c", "task_forest_d"], edge_count: 1, node_count: 2 }
    ]);
    expectComponentExplanationsToMatchEvidence(components);

    const bridges = analyzeBridges(state);
    expect(bridges.bridges).toEqual([
      {
        source_id: "task_forest_a",
        target_id: "task_forest_b",
        left_node_ids: ["task_forest_a"],
        right_node_ids: ["task_forest_b"]
      },
      {
        source_id: "task_forest_c",
        target_id: "task_forest_d",
        left_node_ids: ["task_forest_c"],
        right_node_ids: ["task_forest_d"]
      }
    ]);
    expectBridgeExplanationsToMatchEvidence(bridges);

    const cutpoints = analyzeCutpoints(state);
    expect(cutpoints.cutpoints).toEqual([
      {
        node_id: "task_c",
        separated_component_count: 2,
        separated_component_node_sets: [
          ["task_a", "task_b"],
          ["task_d", "task_e"]
        ]
      }
    ]);
    expectCutpointExplanationsToMatchEvidence(cutpoints);
  });

  it("keeps fragility explanations deterministic when evidence is tied", () => {
    const state = buildState({
      caseId: "fragility-tie-explanation-case",
      nodes: [
        { node_id: "task_alpha" },
        { node_id: "task_beta" },
        { node_id: "task_delta" },
        { node_id: "task_gamma" }
      ],
      edges: [
        { edge_id: "edge_beta_alpha", source_id: "task_beta", target_id: "task_alpha" },
        { edge_id: "edge_alpha_beta", source_id: "task_alpha", target_id: "task_beta" },
        { edge_id: "edge_gamma_delta", source_id: "task_gamma", target_id: "task_delta" },
        { edge_id: "edge_delta_gamma", source_id: "task_delta", target_id: "task_gamma" }
      ]
    });

    const fragility = analyzeFragility(state);

    expect(fragility.warnings).toEqual(["bottleneck_signal_unavailable_due_to_cycles"]);
    expect(
      fragility.nodes.map((node) => ({
        node_id: node.node_id,
        fragility_score: node.fragility_score,
        reason_tags: node.reason_tags
      }))
    ).toEqual([
      { node_id: "task_alpha", fragility_score: 3, reason_tags: ["bridge"] },
      { node_id: "task_beta", fragility_score: 3, reason_tags: ["bridge"] },
      { node_id: "task_delta", fragility_score: 3, reason_tags: ["bridge"] },
      { node_id: "task_gamma", fragility_score: 3, reason_tags: ["bridge"] }
    ]);
    expect(fragility.explanations.map((explanation) => explanation.evidence.rank)).toEqual([
      1, 2, 3, 4
    ]);
    expectFragilityExplanationsToMatchEvidence(fragility);
  });

  it("applies goal scoping to user-facing structure analyses", () => {
    const state = buildState({
      caseId: "goal-structure-case",
      nodes: [
        { node_id: "goal_release_ready", kind: "goal" },
        { node_id: "task_prepare" },
        { node_id: "task_review" },
        { node_id: "task_publish" },
        { node_id: "task_docs" },
        { node_id: "task_cleanup" },
        { node_id: "task_archive" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_review", target_id: "task_prepare" },
        { edge_id: "e2", source_id: "task_publish", target_id: "task_review" },
        { edge_id: "e3", source_id: "task_prepare", target_id: "task_publish" },
        { edge_id: "e4", source_id: "task_docs", target_id: "task_prepare" },
        { edge_id: "e5", source_id: "task_archive", target_id: "task_cleanup" },
        {
          edge_id: "e6",
          type: "contributes_to",
          source_id: "task_publish",
          target_id: "goal_release_ready"
        },
        {
          edge_id: "e7",
          type: "contributes_to",
          source_id: "task_docs",
          target_id: "goal_release_ready"
        }
      ]
    });

    const components = analyzeComponents(state, {
      projection: "hard_goal_scope",
      goalNodeId: "goal_release_ready"
    });
    expect(components.components).toEqual([
      {
        node_ids: ["task_docs", "task_prepare", "task_publish", "task_review"],
        edge_count: 4,
        node_count: 4
      }
    ]);

    const bridges = analyzeBridges(state, {
      projection: "hard_goal_scope",
      goalNodeId: "goal_release_ready"
    });
    expect(bridges.bridges).toEqual([
      {
        source_id: "task_docs",
        target_id: "task_prepare",
        left_node_ids: ["task_docs"],
        right_node_ids: ["task_prepare", "task_publish", "task_review"]
      }
    ]);
  });

  it("warns consistently when goal scoping resolves to no unresolved nodes", () => {
    const state = buildState({
      caseId: "empty-goal-structure-case",
      nodes: [
        { node_id: "goal_archive_ready", kind: "goal", state: "done" },
        { node_id: "task_archived", state: "done" }
      ],
      edges: [
        {
          edge_id: "e1",
          type: "contributes_to",
          source_id: "task_archived",
          target_id: "goal_archive_ready"
        }
      ]
    });

    const options = {
      projection: "hard_goal_scope" as const,
      goalNodeId: "goal_archive_ready"
    };

    const cycles = analyzeCycles(state, options);
    expect(cycles.cycle_count).toBe(0);
    expect(cycles.cycles).toEqual([]);
    expect(cycles.explanations).toEqual([]);
    expect(cycles.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const components = analyzeComponents(state, options);
    expect(components.component_count).toBe(0);
    expect(components.components).toEqual([]);
    expect(components.explanations).toEqual([]);
    expect(components.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const bridges = analyzeBridges(state, options);
    expect(bridges.bridge_count).toBe(0);
    expect(bridges.bridges).toEqual([]);
    expect(bridges.explanations).toEqual([]);
    expect(bridges.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const cutpoints = analyzeCutpoints(state, options);
    expect(cutpoints.cutpoint_count).toBe(0);
    expect(cutpoints.cutpoints).toEqual([]);
    expect(cutpoints.explanations).toEqual([]);
    expect(cutpoints.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const fragility = analyzeFragility(state, options);
    expect(fragility.nodes).toEqual([]);
    expect(fragility.explanations).toEqual([]);
    expect(fragility.warnings).toEqual(["scope_has_no_unresolved_nodes"]);
  });

  it("does not warn when hard_unresolved has no unresolved nodes", () => {
    const state = buildState({
      caseId: "empty-structure-hard-unresolved-case",
      nodes: [
        { node_id: "task_done_a", state: "done" },
        { node_id: "task_done_b", state: "done" }
      ],
      edges: [{ edge_id: "e1", source_id: "task_done_a", target_id: "task_done_b" }]
    });

    const cycles = analyzeCycles(state);
    expect(cycles.warnings).toEqual([]);

    const components = analyzeComponents(state);
    expect(components.warnings).toEqual([]);

    const bridges = analyzeBridges(state);
    expect(bridges.warnings).toEqual([]);

    const cutpoints = analyzeCutpoints(state);
    expect(cutpoints.warnings).toEqual([]);

    const fragility = analyzeFragility(state);
    expect(fragility.warnings).toEqual([]);
  });
});

function buildState(input: { caseId: string; nodes: TestNodeInput[]; edges: TestEdgeInput[] }) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const actor = defaultActor();

  return replayCaseEvents([
    createEvent({
      case_id: input.caseId,
      timestamp,
      actor,
      type: "case.created",
      payload: {
        case: {
          case_id: input.caseId,
          title: input.caseId,
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
    ...input.nodes.map((node) =>
      createEvent({
        case_id: input.caseId,
        timestamp,
        actor,
        type: "node.added",
        payload: {
          node: {
            node_id: node.node_id,
            kind: node.kind ?? "task",
            title: node.title ?? node.node_id,
            description: "",
            state: node.state ?? "todo",
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
    ...input.edges.map((edge) =>
      createEvent({
        case_id: input.caseId,
        timestamp,
        actor,
        type: "edge.added",
        payload: {
          edge: {
            edge_id: edge.edge_id,
            type: edge.type ?? "depends_on",
            source_id: edge.source_id,
            target_id: edge.target_id,
            metadata: {},
            extensions: {},
            created_at: timestamp
          }
        }
      })
    )
  ]);
}

function expectCycleExplanationsToMatchEvidence(result: CycleAnalysisResult): void {
  expect(result.explanations).toHaveLength(result.cycles.length);
  for (const [index, cycle] of result.cycles.entries()) {
    expect(result.explanations[index]?.evidence).toEqual({
      projection: result.projection,
      goal_node_id: result.goal_node_id,
      warnings: result.warnings,
      cycle_index: index + 1,
      cycle_count: result.cycle_count,
      node_ids: cycle.node_ids,
      edge_pairs: cycle.edge_pairs
    });
  }
}

function expectComponentExplanationsToMatchEvidence(result: ComponentAnalysisResult): void {
  expect(result.explanations).toHaveLength(result.components.length);
  for (const [index, component] of result.components.entries()) {
    expect(result.explanations[index]?.evidence).toEqual({
      projection: result.projection,
      goal_node_id: result.goal_node_id,
      warnings: result.warnings,
      component_index: index + 1,
      component_count: result.component_count,
      node_ids: component.node_ids,
      node_count: component.node_count,
      edge_count: component.edge_count
    });
  }
}

function expectBridgeExplanationsToMatchEvidence(result: BridgeAnalysisResult): void {
  expect(result.explanations).toHaveLength(result.bridges.length);
  for (const [index, bridge] of result.bridges.entries()) {
    expect(result.explanations[index]?.evidence).toEqual({
      projection: result.projection,
      goal_node_id: result.goal_node_id,
      warnings: result.warnings,
      bridge_index: index + 1,
      bridge_count: result.bridge_count,
      source_id: bridge.source_id,
      target_id: bridge.target_id,
      left_node_ids: bridge.left_node_ids,
      right_node_ids: bridge.right_node_ids
    });
  }
}

function expectCutpointExplanationsToMatchEvidence(result: CutpointAnalysisResult): void {
  expect(result.explanations).toHaveLength(result.cutpoints.length);
  for (const [index, cutpoint] of result.cutpoints.entries()) {
    expect(result.explanations[index]?.evidence).toEqual({
      projection: result.projection,
      goal_node_id: result.goal_node_id,
      warnings: result.warnings,
      cutpoint_index: index + 1,
      cutpoint_count: result.cutpoint_count,
      node_id: cutpoint.node_id,
      separated_component_count: cutpoint.separated_component_count,
      separated_component_node_sets: cutpoint.separated_component_node_sets
    });
  }
}

function expectFragilityExplanationsToMatchEvidence(result: FragilityAnalysisResult): void {
  expect(result.explanations).toHaveLength(result.nodes.length);
  for (const [index, node] of result.nodes.entries()) {
    expect(result.explanations[index]?.evidence).toEqual({
      projection: result.projection,
      goal_node_id: result.goal_node_id,
      warnings: result.warnings,
      rank: index + 1,
      node_id: node.node_id,
      kind: node.kind,
      state: node.state,
      title: node.title,
      fragility_score: node.fragility_score,
      incident_bridge_count: node.incident_bridge_count,
      cutpoint_component_count: node.cutpoint_component_count,
      downstream_count: node.downstream_count,
      goal_context_count: node.goal_context_count,
      max_distance: node.max_distance,
      reason_tags: node.reason_tags
    });
  }
}

function edgePairKeys(edgePairs: Array<{ source_id: string; target_id: string }>): string[] {
  return edgePairs.map((edgePair) => `${edgePair.source_id}::${edgePair.target_id}`);
}
