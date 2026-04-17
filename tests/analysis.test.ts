import {
  analyzeCriticalPath,
  analyzeCriticalPathForCase,
  analyzeImpactForCase,
  createEvent,
  defaultActor,
  replayCaseEvents
} from "@caphtech/casegraph-core";
import { afterEach, describe, expect, it } from "vitest";

import releaseFixture from "./fixtures/release-case.fixture.json";
import {
  advanceReleaseFixture,
  createTempWorkspace,
  removeTempWorkspace,
  seedFixture
} from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("analysis surfaces", () => {
  it("reports hard/context impact and frontier invalidations", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-analysis-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);
    await advanceReleaseFixture(workspaceRoot, releaseFixture.case.case_id);

    const result = await analyzeImpactForCase(
      workspaceRoot,
      releaseFixture.case.case_id,
      "task_run_regression"
    );

    expect(result.hard_impact.map((node) => node.node_id)).toEqual(["task_submit_store"]);
    expect(result.context_impact.map((node) => node.node_id)).toEqual(["goal_release_ready"]);
    expect(result.frontier_invalidations.map((node) => node.node_id)).toEqual([
      "task_submit_store"
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("computes a goal-scoped critical path with duration", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-analysis-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const result = await analyzeCriticalPathForCase(
      workspaceRoot,
      releaseFixture.case.case_id,
      "goal_release_ready"
    );

    expect(result.depth_path.node_ids).toEqual(["task_run_regression", "task_submit_store"]);
    expect(result.depth_path.hop_count).toBe(1);
    expect(result.depth_path.total_estimate_minutes).toBe(65);
    expect(result.duration_path?.node_ids).toEqual(["task_run_regression", "task_submit_store"]);
    expect(result.duration_path?.total_estimate_minutes).toBe(65);
    expect(result.missing_estimate_node_ids).toEqual([]);
  });

  it("rejects critical path analysis when the scoped graph contains a hard cycle", async () => {
    const actor = defaultActor();
    const timestamp = "2026-01-01T00:00:00.000Z";
    const state = replayCaseEvents([
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "case.created",
        payload: {
          case: {
            case_id: "cycle-case",
            title: "Cycle case",
            description: "cycle",
            state: "open",
            labels: [],
            metadata: {},
            extensions: {},
            created_at: timestamp,
            updated_at: timestamp
          }
        }
      }),
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "node.added",
        payload: {
          node: {
            node_id: "goal_delivery",
            kind: "goal",
            title: "Delivery",
            description: "",
            state: "todo",
            labels: [],
            acceptance: [],
            metadata: {},
            extensions: {},
            created_at: timestamp,
            updated_at: timestamp
          }
        }
      }),
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "node.added",
        payload: {
          node: {
            node_id: "task_a",
            kind: "task",
            title: "Task A",
            description: "",
            state: "todo",
            labels: [],
            acceptance: [],
            metadata: {},
            extensions: {},
            created_at: timestamp,
            updated_at: timestamp
          }
        }
      }),
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "node.added",
        payload: {
          node: {
            node_id: "task_b",
            kind: "task",
            title: "Task B",
            description: "",
            state: "todo",
            labels: [],
            acceptance: [],
            metadata: {},
            extensions: {},
            created_at: timestamp,
            updated_at: timestamp
          }
        }
      }),
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "edge.added",
        payload: {
          edge: {
            edge_id: "e1",
            type: "depends_on",
            source_id: "task_a",
            target_id: "task_b",
            metadata: {},
            extensions: {},
            created_at: timestamp
          }
        }
      }),
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "edge.added",
        payload: {
          edge: {
            edge_id: "e2",
            type: "depends_on",
            source_id: "task_b",
            target_id: "task_a",
            metadata: {},
            extensions: {},
            created_at: timestamp
          }
        }
      }),
      createEvent({
        case_id: "cycle-case",
        timestamp,
        actor,
        type: "edge.added",
        payload: {
          edge: {
            edge_id: "e3",
            type: "contributes_to",
            source_id: "task_a",
            target_id: "goal_delivery",
            metadata: {},
            extensions: {},
            created_at: timestamp
          }
        }
      })
    ]);

    try {
      analyzeCriticalPath(state, "goal_delivery");
      throw new Error("Expected analyzeCriticalPath to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "analysis_cycle_present",
        exitCode: 2
      });
    }
  });
});
