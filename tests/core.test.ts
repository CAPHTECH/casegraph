import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  getFrontierItems,
  listBlockedItems,
  rebuildCache,
  showCase,
  validateCase,
  validateStorage
} from "@caphtech/casegraph-core";
import { afterEach, describe, expect, it } from "vitest";

import moveFixture from "./fixtures/move-case.fixture.json";
import releaseFixture from "./fixtures/release-case.fixture.json";
import {
  advanceMoveFixture,
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

describe("core phase 1 flows", () => {
  it("matches release fixture frontier and blockers", async () => {
    const workspaceRoot = await createTempWorkspace();
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const frontier = await getFrontierItems(workspaceRoot, releaseFixture.case.case_id);
    expect(frontier.nodes.map((node) => node.node_id)).toEqual(
      releaseFixture.expected.initial_frontier
    );

    const blockers = await listBlockedItems(workspaceRoot, releaseFixture.case.case_id);
    expect(blockers.items).toHaveLength(2);
    expect(
      blockers.items.map((item) => [
        item.node.node_id,
        item.reasons.map((reason) => reason.message)
      ])
    ).toEqual(
      Object.entries(releaseFixture.expected.initial_blockers).sort((left, right) =>
        left[0].localeCompare(right[0])
      )
    );

    await advanceReleaseFixture(workspaceRoot, releaseFixture.case.case_id);
    const advancedFrontier = await getFrontierItems(workspaceRoot, releaseFixture.case.case_id);
    expect(new Set(advancedFrontier.nodes.map((node) => node.node_id))).toEqual(
      new Set(releaseFixture.expected.after_completion_frontier)
    );
  });

  it("matches move fixture frontier and blockers", async () => {
    const workspaceRoot = await createTempWorkspace();
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, moveFixture);

    const frontier = await getFrontierItems(workspaceRoot, moveFixture.case.case_id);
    expect(new Set(frontier.nodes.map((node) => node.node_id))).toEqual(
      new Set(moveFixture.expected.initial_frontier)
    );

    const blockers = await listBlockedItems(workspaceRoot, moveFixture.case.case_id);
    expect(
      blockers.items.map((item) => [
        item.node.node_id,
        item.reasons.map((reason) => reason.message)
      ])
    ).toEqual(
      Object.entries(moveFixture.expected.initial_blockers).sort((left, right) =>
        left[0].localeCompare(right[0])
      )
    );

    await advanceMoveFixture(workspaceRoot, moveFixture.case.case_id);
    const advancedFrontier = await getFrontierItems(workspaceRoot, moveFixture.case.case_id);
    expect(new Set(advancedFrontier.nodes.map((node) => node.node_id))).toEqual(
      new Set(moveFixture.expected.after_completion_frontier)
    );
  });

  it("rebuilds cache after deletion without changing derived outputs", async () => {
    const workspaceRoot = await createTempWorkspace();
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const before = await showCase(workspaceRoot, releaseFixture.case.case_id);
    const cacheFile = path.join(workspaceRoot, ".casegraph", "cache", "state.sqlite");
    await rm(cacheFile, { force: true });

    const validationBefore = await validateStorage(workspaceRoot);
    expect(validationBefore.valid).toBe(false);

    await rebuildCache(workspaceRoot);

    const validationAfter = await validateStorage(workspaceRoot);
    expect(validationAfter.valid).toBe(true);

    const after = await showCase(workspaceRoot, releaseFixture.case.case_id);
    expect(after.frontier_summary).toEqual(before.frontier_summary);

    const rawEvents = await readFile(
      path.join(workspaceRoot, ".casegraph", "cases", releaseFixture.case.case_id, "events.jsonl"),
      "utf8"
    );
    expect(rawEvents.trim().length).toBeGreaterThan(0);
  });

  it("reports validate output for a healthy case", async () => {
    const workspaceRoot = await createTempWorkspace();
    createdWorkspaces.push(workspaceRoot);
    await seedFixture(workspaceRoot, releaseFixture);

    const result = await validateCase(workspaceRoot, releaseFixture.case.case_id);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
