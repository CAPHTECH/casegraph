import {
  analyzeMinimalUnblockSet,
  createEvent,
  defaultActor,
  replayCaseEvents
} from "@caphtech/casegraph-core";
import { describe, expect, it } from "vitest";

describe("minimal unblock analysis", () => {
  it("returns the minimal actionable leaf set across blocked prerequisite chains", () => {
    const state = buildState([
      taskNode("task_publish", "Publish release"),
      taskNode("task_review", "Review release", "waiting"),
      taskNode("task_fix", "Fix release"),
      taskNode("task_ship", "Ship release"),
      dependencyEdge("edge_publish_review", "task_publish", "task_review"),
      dependencyEdge("edge_publish_ship", "task_publish", "task_ship"),
      dependencyEdge("edge_review_fix", "task_review", "task_fix")
    ]);

    const result = analyzeMinimalUnblockSet(state, "task_publish");

    expect(result.actionable_leaf_node_ids).toEqual(["task_fix", "task_ship"]);
    expect(result.blockers).toEqual([
      {
        node_id: "task_ship",
        kind: "actionable_leaf",
        node_kind: "task",
        state: "todo",
        title: "Ship release",
        distance: 1,
        via_node_ids: ["task_ship", "task_publish"],
        via_edge_ids: ["edge_publish_ship"],
        actionable: true
      },
      {
        node_id: "task_fix",
        kind: "actionable_leaf",
        node_kind: "task",
        state: "todo",
        title: "Fix release",
        distance: 2,
        via_node_ids: ["task_fix", "task_review", "task_publish"],
        via_edge_ids: ["edge_review_fix", "edge_publish_review"],
        actionable: true
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("treats unresolved waits_for targets as event leaf blockers", () => {
    const state = buildState([
      taskNode("task_deploy", "Deploy release"),
      eventNode("event_release_window", "Release window"),
      waitEdge("edge_deploy_window", "task_deploy", "event_release_window")
    ]);

    const result = analyzeMinimalUnblockSet(state, "task_deploy");

    expect(result.actionable_leaf_node_ids).toEqual([]);
    expect(result.blockers).toEqual([
      {
        node_id: "event_release_window",
        kind: "wait_leaf",
        node_kind: "event",
        state: "todo",
        title: "Release window",
        distance: 1,
        via_node_ids: ["event_release_window", "task_deploy"],
        via_edge_ids: ["edge_deploy_window"],
        actionable: false
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("returns no blockers when the target is already ready", () => {
    const state = buildState([taskNode("task_review", "Review release")]);

    const result = analyzeMinimalUnblockSet(state, "task_review");

    expect(result.actionable_leaf_node_ids).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual(["target_already_ready"]);
  });

  it("rejects hard cycles in the target prerequisite scope", () => {
    const state = buildState([
      taskNode("task_a", "Task A"),
      taskNode("task_b", "Task B"),
      dependencyEdge("edge_ab", "task_a", "task_b"),
      dependencyEdge("edge_ba", "task_b", "task_a")
    ]);

    expect(() => analyzeMinimalUnblockSet(state, "task_a")).toThrowError(
      expect.objectContaining({
        code: "analysis_cycle_present",
        exitCode: 2
      })
    );
  });
});

const CASE_ID = "unblock-case";
const ACTOR = defaultActor();
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

type GraphEntry =
  | ReturnType<typeof taskNode>
  | ReturnType<typeof eventNode>
  | ReturnType<typeof edge>;

function buildState(entries: GraphEntry[]) {
  const events = [
    createEvent({
      case_id: CASE_ID,
      timestamp: TIMESTAMP,
      actor: ACTOR,
      type: "case.created",
      payload: {
        case: {
          case_id: CASE_ID,
          title: "Minimal unblock case",
          description: "",
          state: "open",
          labels: [],
          metadata: {},
          extensions: {},
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP
        }
      }
    }),
    ...entries.map((entry) => toEvent(entry))
  ];

  return replayCaseEvents(events);
}

function taskNode(
  nodeId: string,
  title: string,
  state: "todo" | "doing" | "waiting" | "failed" | "done" = "todo"
) {
  return {
    kind: "node" as const,
    node: {
      node_id: nodeId,
      kind: "task" as const,
      title,
      description: "",
      state,
      labels: [],
      acceptance: [],
      metadata: {},
      extensions: {},
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP
    }
  };
}

function eventNode(nodeId: string, title: string, state: "todo" | "done" = "todo") {
  return {
    kind: "node" as const,
    node: {
      node_id: nodeId,
      kind: "event" as const,
      title,
      description: "",
      state,
      labels: [],
      acceptance: [],
      metadata: {},
      extensions: {},
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP
    }
  };
}

function dependencyEdge(edgeId: string, sourceId: string, targetId: string) {
  return edge(edgeId, "depends_on", sourceId, targetId);
}

function waitEdge(edgeId: string, sourceId: string, targetId: string) {
  return edge(edgeId, "waits_for", sourceId, targetId);
}

function edge(
  edgeId: string,
  type: "depends_on" | "waits_for",
  sourceId: string,
  targetId: string
) {
  return {
    kind: "edge" as const,
    edge: {
      edge_id: edgeId,
      type,
      source_id: sourceId,
      target_id: targetId,
      metadata: {},
      extensions: {},
      created_at: TIMESTAMP
    }
  };
}

function toEvent(entry: GraphEntry) {
  if (entry.kind === "node") {
    return createEvent({
      case_id: CASE_ID,
      timestamp: TIMESTAMP,
      actor: ACTOR,
      type: "node.added",
      payload: {
        node: entry.node
      }
    });
  }

  return createEvent({
    case_id: CASE_ID,
    timestamp: TIMESTAMP,
    actor: ACTOR,
    type: "edge.added",
    payload: {
      edge: entry.edge
    }
  });
}
