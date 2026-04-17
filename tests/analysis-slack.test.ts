import {
  analyzeSlack,
  createEvent,
  defaultActor,
  type EdgeType,
  type EventEnvelope,
  type NodeKind,
  type NodeState,
  replayCaseEvents
} from "@casegraph/core";
import { describe, expect, it } from "vitest";

interface TestNode {
  node_id: string;
  kind?: NodeKind;
  state?: NodeState;
  title?: string;
  estimate_minutes?: number;
}

interface TestEdge {
  edge_id: string;
  type: EdgeType;
  source_id: string;
  target_id: string;
}

function buildState(input: { caseId?: string; nodes: TestNode[]; edges?: TestEdge[] }) {
  const actor = defaultActor();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const caseId = input.caseId ?? "slack-case";
  const events: EventEnvelope[] = [
    createEvent({
      case_id: caseId,
      timestamp,
      actor,
      type: "case.created",
      payload: {
        case: {
          case_id: caseId,
          title: "Slack case",
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
        case_id: caseId,
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
            metadata:
              node.estimate_minutes === undefined
                ? {}
                : { estimate_minutes: node.estimate_minutes },
            extensions: {},
            created_at: timestamp,
            updated_at: timestamp
          }
        }
      })
    ),
    ...(input.edges ?? []).map((edge) =>
      createEvent({
        case_id: caseId,
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
    )
  ];

  return replayCaseEvents(events);
}

describe("analyzeSlack", () => {
  it("computes slack with a critical chain and a non-critical side branch", () => {
    const state = buildState({
      nodes: [
        { node_id: "task_design", estimate_minutes: 30 },
        { node_id: "task_build", estimate_minutes: 20 },
        { node_id: "task_release", estimate_minutes: 10 },
        { node_id: "task_docs", estimate_minutes: 5 }
      ],
      edges: [
        {
          edge_id: "e_design_build",
          type: "depends_on",
          source_id: "task_build",
          target_id: "task_design"
        },
        {
          edge_id: "e_build_release",
          type: "depends_on",
          source_id: "task_release",
          target_id: "task_build"
        },
        {
          edge_id: "e_design_docs",
          type: "depends_on",
          source_id: "task_docs",
          target_id: "task_design"
        }
      ]
    });

    const result = analyzeSlack(state);

    expect(result.projected_duration_minutes).toBe(60);
    expect(result.missing_estimate_node_ids).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.nodes.map((node) => node.node_id)).toEqual([
      "task_design",
      "task_build",
      "task_release",
      "task_docs"
    ]);
    expect(result.nodes).toEqual([
      expect.objectContaining({
        node_id: "task_design",
        earliest_start_minutes: 0,
        earliest_finish_minutes: 30,
        latest_start_minutes: 0,
        latest_finish_minutes: 30,
        slack_minutes: 0,
        is_critical: true
      }),
      expect.objectContaining({
        node_id: "task_build",
        earliest_start_minutes: 30,
        earliest_finish_minutes: 50,
        latest_start_minutes: 30,
        latest_finish_minutes: 50,
        slack_minutes: 0,
        is_critical: true
      }),
      expect.objectContaining({
        node_id: "task_release",
        earliest_start_minutes: 50,
        earliest_finish_minutes: 60,
        latest_start_minutes: 50,
        latest_finish_minutes: 60,
        slack_minutes: 0,
        is_critical: true
      }),
      expect.objectContaining({
        node_id: "task_docs",
        earliest_start_minutes: 30,
        earliest_finish_minutes: 35,
        latest_start_minutes: 55,
        latest_finish_minutes: 60,
        slack_minutes: 25,
        is_critical: false
      })
    ]);
  });

  it("limits analysis to a goal contributor set plus prerequisite closure", () => {
    const state = buildState({
      nodes: [
        { node_id: "goal_release", kind: "goal" },
        { node_id: "goal_marketing", kind: "goal" },
        { node_id: "task_plan", estimate_minutes: 15 },
        { node_id: "task_build", estimate_minutes: 25 },
        { node_id: "task_campaign", estimate_minutes: 10 }
      ],
      edges: [
        {
          edge_id: "e_plan_build",
          type: "depends_on",
          source_id: "task_build",
          target_id: "task_plan"
        },
        {
          edge_id: "e_plan_campaign",
          type: "depends_on",
          source_id: "task_campaign",
          target_id: "task_plan"
        },
        {
          edge_id: "e_build_goal",
          type: "contributes_to",
          source_id: "task_build",
          target_id: "goal_release"
        },
        {
          edge_id: "e_campaign_goal",
          type: "contributes_to",
          source_id: "task_campaign",
          target_id: "goal_marketing"
        }
      ]
    });

    const result = analyzeSlack(state, "goal_release");

    expect(result.goal_node_id).toBe("goal_release");
    expect(result.projected_duration_minutes).toBe(40);
    expect(result.missing_estimate_node_ids).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.nodes.map((node) => node.node_id)).toEqual(["task_plan", "task_build"]);
    expect(result.nodes.every((node) => node.is_critical)).toBe(true);
  });

  it("returns warnings and no node schedule when scoped estimates are missing", () => {
    const state = buildState({
      nodes: [{ node_id: "task_collect", estimate_minutes: 20 }, { node_id: "task_compare" }],
      edges: [
        {
          edge_id: "e_collect_compare",
          type: "depends_on",
          source_id: "task_compare",
          target_id: "task_collect"
        }
      ]
    });

    const result = analyzeSlack(state);

    expect(result.projected_duration_minutes).toBeNull();
    expect(result.nodes).toEqual([]);
    expect(result.missing_estimate_node_ids).toEqual(["task_compare"]);
    expect(result.warnings).toEqual([
      "missing_estimates_present",
      "slack_unavailable_due_to_missing_estimates"
    ]);
  });

  it("rejects slack analysis when the hard dependency scope contains a cycle", () => {
    const state = buildState({
      caseId: "slack-cycle",
      nodes: [
        { node_id: "task_a", estimate_minutes: 10 },
        { node_id: "task_b", estimate_minutes: 15 }
      ],
      edges: [
        {
          edge_id: "e_ab",
          type: "depends_on",
          source_id: "task_a",
          target_id: "task_b"
        },
        {
          edge_id: "e_ba",
          type: "depends_on",
          source_id: "task_b",
          target_id: "task_a"
        }
      ]
    });

    try {
      analyzeSlack(state);
      throw new Error("Expected analyzeSlack to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "analysis_cycle_present",
        exitCode: 2
      });
    }
  });
});
