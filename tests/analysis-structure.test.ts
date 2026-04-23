import {
  analyzeBridges,
  analyzeComponents,
  analyzeCutpoints,
  analyzeCycles,
  analyzeFragility,
  createEvent,
  defaultActor,
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

    const cutpoints = analyzeCutpoints(state);
    expect(cutpoints.cutpoints).toEqual([
      {
        node_id: "task_prepare",
        separated_component_count: 2,
        separated_component_node_sets: [["task_docs"], ["task_publish", "task_review"]]
      }
    ]);

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
    expect(cycles.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const components = analyzeComponents(state, options);
    expect(components.component_count).toBe(0);
    expect(components.components).toEqual([]);
    expect(components.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const bridges = analyzeBridges(state, options);
    expect(bridges.bridge_count).toBe(0);
    expect(bridges.bridges).toEqual([]);
    expect(bridges.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const cutpoints = analyzeCutpoints(state, options);
    expect(cutpoints.cutpoint_count).toBe(0);
    expect(cutpoints.cutpoints).toEqual([]);
    expect(cutpoints.warnings).toEqual(["scope_has_no_unresolved_nodes"]);

    const fragility = analyzeFragility(state, options);
    expect(fragility.nodes).toEqual([]);
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
