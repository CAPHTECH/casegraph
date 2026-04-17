import {
  analyzeTopology,
  analyzeTopologyForCase,
  createEvent,
  defaultActor,
  replayCaseEvents
} from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

import topologyFixture from "./fixtures/topology-analysis.fixture.json";
import { createTempWorkspace, removeTempWorkspace, seedFixture } from "./helpers/workspace.js";

interface TestNodeInput {
  node_id: string;
  kind?: "goal" | "task" | "decision" | "event" | "evidence";
  state?: "proposed" | "todo" | "doing" | "waiting" | "done" | "cancelled" | "failed";
  title?: string;
  metadata?: Record<string, unknown>;
}

interface TestEdgeInput {
  edge_id: string;
  type?: "depends_on" | "waits_for" | "alternative_to" | "verifies" | "contributes_to";
  source_id: string;
  target_id: string;
}

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("analyzeTopology", () => {
  it("computes Betti-0 over a disconnected forest", () => {
    const state = buildState({
      caseId: "forest-case",
      nodes: [
        { node_id: "task_a" },
        { node_id: "task_b" },
        { node_id: "task_c" },
        { node_id: "task_d" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_b", target_id: "task_a" },
        { edge_id: "e2", source_id: "task_d", target_id: "task_c" }
      ]
    });

    const result = analyzeTopology(state);

    expect(result.node_count).toBe(4);
    expect(result.edge_count).toBe(2);
    expect(result.beta_0).toBe(2);
    expect(result.beta_1).toBe(0);
    expect(result.components).toEqual([
      { node_ids: ["task_a", "task_b"], edge_count: 1 },
      { node_ids: ["task_c", "task_d"], edge_count: 1 }
    ]);
    expect(result.cycle_witnesses).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("extracts a single cycle witness from a simple loop", () => {
    const state = buildState({
      caseId: "cycle-case",
      nodes: [{ node_id: "task_a" }, { node_id: "task_b" }, { node_id: "task_c" }],
      edges: [
        { edge_id: "e1", source_id: "task_b", target_id: "task_a" },
        { edge_id: "e2", source_id: "task_c", target_id: "task_b" },
        { edge_id: "e3", source_id: "task_a", target_id: "task_c" }
      ]
    });

    const result = analyzeTopology(state);

    expect(result.beta_0).toBe(1);
    expect(result.beta_1).toBe(1);
    expect(result.cycle_witnesses).toEqual([
      {
        node_ids: ["task_a", "task_b", "task_c"],
        edge_pairs: [
          { source_id: "task_a", target_id: "task_b" },
          { source_id: "task_a", target_id: "task_c" },
          { source_id: "task_b", target_id: "task_c" }
        ]
      }
    ]);
  });

  it("extracts two witnesses from a figure-eight graph", () => {
    const state = buildState({
      caseId: "figure-eight-case",
      nodes: [
        { node_id: "task_a" },
        { node_id: "task_b" },
        { node_id: "task_c" },
        { node_id: "task_d" },
        { node_id: "task_e" }
      ],
      edges: [
        { edge_id: "e1", source_id: "task_b", target_id: "task_a" },
        { edge_id: "e2", source_id: "task_c", target_id: "task_b" },
        { edge_id: "e3", source_id: "task_a", target_id: "task_c" },
        { edge_id: "e4", source_id: "task_d", target_id: "task_c" },
        { edge_id: "e5", source_id: "task_e", target_id: "task_d" },
        { edge_id: "e6", source_id: "task_c", target_id: "task_e" }
      ]
    });

    const result = analyzeTopology(state);

    expect(result.beta_0).toBe(1);
    expect(result.beta_1).toBe(2);
    expect(result.cycle_witnesses).toEqual([
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
  });

  it("deduplicates multi-edges and ignores self-loops", () => {
    const state = buildState({
      caseId: "dedupe-case",
      nodes: [{ node_id: "task_a" }, { node_id: "task_b" }],
      edges: [
        { edge_id: "e1", source_id: "task_b", target_id: "task_a" },
        { edge_id: "e2", source_id: "task_a", target_id: "task_b" },
        { edge_id: "e3", source_id: "task_a", target_id: "task_a" }
      ]
    });

    const result = analyzeTopology(state);

    expect(result.edge_count).toBe(1);
    expect(result.beta_0).toBe(1);
    expect(result.beta_1).toBe(0);
    expect(result.warnings).toEqual(["self_loop_ignored"]);
  });

  it("applies hard goal scoping to contributing unresolved nodes and prerequisites", () => {
    const state = buildState({
      caseId: "goal-scope-case",
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
        {
          edge_id: "e5",
          type: "contributes_to",
          source_id: "task_publish",
          target_id: "goal_release_ready"
        },
        {
          edge_id: "e6",
          type: "contributes_to",
          source_id: "task_docs",
          target_id: "goal_release_ready"
        },
        { edge_id: "e7", source_id: "task_archive", target_id: "task_cleanup" }
      ]
    });

    const result = analyzeTopology(state, {
      projection: "hard_goal_scope",
      goalNodeId: "goal_release_ready"
    });

    expect(result.goal_node_id).toBe("goal_release_ready");
    expect(result.components).toEqual([
      {
        node_ids: ["task_docs", "task_prepare", "task_publish", "task_review"],
        edge_count: 4
      }
    ]);
    expect(result.beta_0).toBe(1);
    expect(result.beta_1).toBe(1);
  });

  it("warns when the scoped graph has no unresolved nodes", () => {
    const state = buildState({
      caseId: "empty-scope-case",
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

    const result = analyzeTopology(state, {
      projection: "hard_goal_scope",
      goalNodeId: "goal_archive_ready"
    });

    expect(result.node_count).toBe(0);
    expect(result.edge_count).toBe(0);
    expect(result.beta_0).toBe(0);
    expect(result.beta_1).toBe(0);
    expect(result.components).toEqual([]);
    expect(result.cycle_witnesses).toEqual([]);
    expect(result.warnings).toEqual(["scope_has_no_unresolved_nodes"]);
  });

  it("requires a goal node for hard goal scope", () => {
    const state = buildState({
      caseId: "missing-goal-case",
      nodes: [{ node_id: "task_prepare" }],
      edges: []
    });

    expect(() => analyzeTopology(state, { projection: "hard_goal_scope" })).toThrowError(
      expect.objectContaining({
        code: "analysis_goal_node_required",
        exitCode: 2
      })
    );
  });

  it("loads topology analysis through the workspace wrapper", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-topology-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, topologyFixture);

    const result = await analyzeTopologyForCase(workspaceRoot, topologyFixture.case.case_id, {
      projection: "hard_goal_scope",
      goalNodeId: "goal_release_ready"
    });

    expect(result.node_count).toBe(6);
    expect(result.edge_count).toBe(5);
    expect(result.beta_0).toBe(1);
    expect(result.beta_1).toBe(0);
    expect(result.components).toEqual([
      {
        node_ids: [
          "event_release_window",
          "task_docs",
          "task_monitor",
          "task_prepare",
          "task_publish",
          "task_review"
        ],
        edge_count: 5
      }
    ]);
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
            metadata: node.metadata ?? {},
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
