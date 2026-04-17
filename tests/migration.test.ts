import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkWorkspaceMigrations,
  createCase,
  createDefaultMutationContext,
  runWorkspaceMigrations,
  SPEC_VERSION
} from "@casegraph/core";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("workspace migration checks", () => {
  it("reports the current workspace as supported and no-op", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-migration-");
    createdWorkspaces.push(workspaceRoot);

    await createCase(
      workspaceRoot,
      {
        case_id: "migration-current",
        title: "Current version",
        description: "No migration needed"
      },
      createDefaultMutationContext()
    );

    const check = await checkWorkspaceMigrations(workspaceRoot);
    expect(check).toMatchObject({
      workspace: workspaceRoot,
      current_spec_version: SPEC_VERSION,
      supported: true,
      pending_steps: [],
      issues: [],
      cases_checked: 1,
      events_checked: 1
    });

    const run = await runWorkspaceMigrations(workspaceRoot, { dryRun: true });
    expect(run).toMatchObject({
      supported: true,
      dry_run: true,
      changed: false,
      applied_steps: []
    });
  });

  it("detects unsupported workspace, case, and event versions", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-migration-");
    createdWorkspaces.push(workspaceRoot);

    await createCase(
      workspaceRoot,
      {
        case_id: "migration-legacy",
        title: "Legacy version",
        description: "Needs migration"
      },
      createDefaultMutationContext()
    );

    const workspaceFile = path.join(workspaceRoot, ".casegraph", "workspace.yaml");
    const caseFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      "migration-legacy",
      "case.yaml"
    );
    const eventsFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      "migration-legacy",
      "events.jsonl"
    );

    await replaceInFile(workspaceFile, "spec_version: 0.1-draft", "spec_version: 0.0.9");
    const caseContents = await readFile(caseFile, "utf8");
    await writeFile(caseFile, `spec_version: 0.0.9\n${caseContents}`, "utf8");
    await replaceInFile(eventsFile, '"spec_version":"0.1-draft"', '"spec_version":"0.0.9"');

    const check = await checkWorkspaceMigrations(workspaceRoot);
    expect(check.supported).toBe(false);
    expect(check.issues.map((issue) => issue.scope)).toEqual(["workspace", "case", "event"]);
    expect(check.issues.map((issue) => issue.detected_spec_version)).toEqual([
      "0.0.9",
      "0.0.9",
      "0.0.9"
    ]);
  });
});

async function replaceInFile(
  filePath: string,
  searchValue: string,
  replaceValue: string
): Promise<void> {
  const contents = await readFile(filePath, "utf8");
  await writeFile(filePath, contents.replace(searchValue, replaceValue), "utf8");
}
