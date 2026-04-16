import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyPatch,
  getFrontierItems,
  reviewPatch,
  validatePatchDocument
} from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

import releaseFixture from "./fixtures/release-case.fixture.json";
import {
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

describe("phase 2 patch engine", () => {
  it("applies a valid patch as one revision and updates frontier", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-patch-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const patch = {
      patch_id: "patch_release_phase2",
      spec_version: "0.1-draft",
      case_id: releaseFixture.case.case_id,
      base_revision: 10,
      summary: "Mark regression done via patch",
      operations: [
        {
          op: "change_state",
          node_id: "task_run_regression",
          state: "done"
        },
        {
          op: "set_case_field",
          changes: {
            labels: ["phase2"]
          }
        }
      ]
    };

    const review = await reviewPatch(workspaceRoot, patch);
    expect(review.valid).toBe(true);

    const nextState = await applyPatch(workspaceRoot, patch);
    expect(nextState.caseRecord.case_revision.current).toBe(11);
    expect(nextState.caseRecord.labels).toEqual(["phase2"]);

    const frontier = await getFrontierItems(workspaceRoot, releaseFixture.case.case_id);
    expect(frontier.nodes.map((node) => node.node_id)).toEqual(["task_update_notes"]);
  });

  it("rejects stale patches and remove_node patches that leave dangling edges", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-patch-");
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const stalePatch = {
      patch_id: "patch_stale",
      spec_version: "0.1-draft",
      case_id: releaseFixture.case.case_id,
      base_revision: 9,
      summary: "Stale patch",
      operations: [
        {
          op: "change_state",
          node_id: "task_run_regression",
          state: "done"
        }
      ]
    };

    const staleReview = await reviewPatch(workspaceRoot, stalePatch);
    expect(staleReview.valid).toBe(false);
    expect(staleReview.stale).toBe(true);

    await expect(applyPatch(workspaceRoot, stalePatch)).rejects.toMatchObject({
      code: "patch_stale",
      exitCode: 4
    });

    const invalidPatch = {
      patch_id: "patch_invalid_remove",
      spec_version: "0.1-draft",
      case_id: releaseFixture.case.case_id,
      base_revision: 10,
      summary: "Remove a node without its edges",
      operations: [
        {
          op: "remove_node",
          node_id: "task_run_regression"
        }
      ]
    };

    const invalidReview = await reviewPatch(workspaceRoot, invalidPatch);
    expect(invalidReview.valid).toBe(false);
    expect(
      invalidReview.errors.some((issue) => issue.code === "dangling_edge")
    ).toBe(true);
  });

  it("validates patch documents before review/apply", async () => {
    const validation = validatePatchDocument({
      patch_id: "patch_invalid",
      spec_version: "0.1-draft",
      case_id: "release-1.8.0",
      base_revision: 1,
      summary: "Broken patch",
      operations: [
        {
          op: "add_node",
          node: {
            node_id: "task_invalid",
            kind: "task",
            title: "Invalid node",
            state: "bogus"
          }
        }
      ]
    });

    expect(validation.valid).toBe(false);
    expect(validation.patch).toBeNull();
    expect(validation.errors.some((issue) => issue.code === "patch_node_value_invalid")).toBe(
      true
    );
  });
});
