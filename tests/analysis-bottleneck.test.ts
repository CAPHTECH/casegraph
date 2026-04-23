import {
  analyzeBottlenecks,
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

describe("analyzeBottlenecks", () => {
  it("ranks prerequisites by downstream hard reachability", () => {
    const state = buildState({
      caseId: "ranking-case",
      nodes: [
        { node_id: "task_prepare" },
        { node_id: "task_package" },
        { node_id: "task_validate" },
        { node_id: "task_docs" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_package", target_id: "task_prepare" },
        { edge_id: "e2", source_id: "task_validate", target_id: "task_package" },
        { edge_id: "e3", source_id: "task_docs", target_id: "task_prepare" }
      ]
    });

    const result = analyzeBottlenecks(state);

    expect(result.nodes.map((node) => node.node_id)).toEqual(["task_prepare", "task_package"]);
    expect(result.nodes[0]).toMatchObject({
      node_id: "task_prepare",
      downstream_node_ids: ["task_docs", "task_package", "task_validate"],
      downstream_count: 3,
      max_distance: 2
    });
    expect(result.nodes[1]).toMatchObject({
      node_id: "task_package",
      downstream_node_ids: ["task_validate"],
      downstream_count: 1,
      max_distance: 1
    });
  });

  it("counts frontier invalidations deterministically within the downstream scope", () => {
    const state = buildState({
      caseId: "frontier-case",
      nodes: [
        { node_id: "task_gate", state: "doing" },
        { node_id: "task_followup" },
        { node_id: "task_publish" },
        { node_id: "task_unrelated_frontier" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_followup", target_id: "task_gate" },
        { edge_id: "e2", source_id: "task_publish", target_id: "task_followup" }
      ]
    });

    const result = analyzeBottlenecks(state);
    const gateSummary = result.nodes.find((node) => node.node_id === "task_gate");

    expect(gateSummary).toMatchObject({
      node_id: "task_gate",
      downstream_node_ids: ["task_followup", "task_publish"],
      frontier_invalidation_node_ids: [],
      frontier_invalidation_count: 0
    });
  });

  it("applies goal scoping and contributes_to context enrichment", () => {
    const state = buildState({
      caseId: "goal-scope-case",
      nodes: [
        { node_id: "goal_release_ready", kind: "goal" },
        { node_id: "task_prepare" },
        { node_id: "task_package" },
        { node_id: "task_docs" },
        { node_id: "task_cleanup" },
        { node_id: "task_archive" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_package", target_id: "task_prepare" },
        { edge_id: "e2", source_id: "task_docs", target_id: "task_prepare" },
        {
          edge_id: "e3",
          type: "contributes_to",
          source_id: "task_package",
          target_id: "goal_release_ready"
        },
        {
          edge_id: "e4",
          type: "contributes_to",
          source_id: "task_docs",
          target_id: "goal_release_ready"
        },
        { edge_id: "e5", source_id: "task_archive", target_id: "task_cleanup" }
      ]
    });

    const result = analyzeBottlenecks(state, "goal_release_ready");

    expect(result.nodes.map((node) => node.node_id)).toEqual([
      "task_prepare",
      "task_docs",
      "task_package"
    ]);
    expect(result.nodes[0]).toMatchObject({
      node_id: "task_prepare",
      downstream_node_ids: ["task_docs", "task_package"],
      goal_context_node_ids: ["goal_release_ready"],
      goal_context_count: 1
    });
    expect(result.nodes[1]?.goal_context_node_ids).toEqual(["goal_release_ready"]);
    expect(result.nodes[2]?.goal_context_node_ids).toEqual(["goal_release_ready"]);
  });

  it("rejects scoped hard cycles", () => {
    const state = buildState({
      caseId: "cycle-case",
      nodes: [
        { node_id: "goal_delivery", kind: "goal" },
        { node_id: "task_a" },
        { node_id: "task_b" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_a", target_id: "task_b" },
        { edge_id: "e2", source_id: "task_b", target_id: "task_a" },
        {
          edge_id: "e3",
          type: "contributes_to",
          source_id: "task_a",
          target_id: "goal_delivery"
        }
      ]
    });

    try {
      analyzeBottlenecks(state, "goal_delivery");
      throw new Error("Expected analyzeBottlenecks to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "analysis_cycle_present",
        exitCode: 2
      });
    }
  });

  it("warns when the scoped graph has no unresolved nodes", () => {
    const state = buildState({
      caseId: "empty-scope-case",
      nodes: [
        { node_id: "goal_release_ready", kind: "goal", state: "done" },
        { node_id: "task_prepare", state: "done" }
      ],
      edges: [
        {
          edge_id: "e1",
          type: "contributes_to",
          source_id: "task_prepare",
          target_id: "goal_release_ready"
        }
      ]
    });

    const result = analyzeBottlenecks(state, "goal_release_ready");

    expect(result.nodes).toEqual([]);
    expect(result.warnings).toEqual(["scope_has_no_unresolved_nodes"]);
  });

  it("does not warn when hard_unresolved has no unresolved nodes", () => {
    const state = buildState({
      caseId: "empty-hard-unresolved-bottleneck-case",
      nodes: [
        { node_id: "task_done_a", state: "done" },
        { node_id: "task_done_b", state: "done" }
      ],
      edges: [{ edge_id: "e1", source_id: "task_done_a", target_id: "task_done_b" }]
    });

    const result = analyzeBottlenecks(state);

    expect(result.nodes).toEqual([]);
    expect(result.warnings).toEqual([]);
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
