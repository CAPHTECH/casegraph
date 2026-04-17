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
      events_checked: 1,
      targets: []
    });

    const run = await runWorkspaceMigrations(workspaceRoot, { dryRun: true });
    expect(run).toMatchObject({
      supported: true,
      dry_run: true,
      changed: false,
      applied_steps: [],
      cache_rebuilt: false,
      targets: []
    });
  });

  it("plans and applies supported legacy workspace, case, event-log, and patch migrations", async () => {
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
    const patchFile = path.join(workspaceRoot, "legacy.patch.json");

    await writeFile(
      patchFile,
      `${JSON.stringify(
        {
          patch_id: "patch_legacy",
          spec_version: "0.0.9",
          case_id: "migration-legacy",
          base_revision: 1,
          summary: "Legacy patch",
          operations: [
            {
              op: "add_node",
              node: {
                node_id: "task_from_patch",
                kind: "task",
                title: "From patch",
                state: "todo",
                description: "",
                labels: [],
                acceptance: [],
                metadata: {},
                extensions: {}
              }
            }
          ],
          notes: [],
          risks: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await replaceInFile(workspaceFile, "spec_version: 0.1-draft", "spec_version: 0.0.9");
    const caseContents = await readFile(caseFile, "utf8");
    await writeFile(caseFile, `spec_version: 0.0.9\n${caseContents}`, "utf8");
    await replaceInFile(eventsFile, '"spec_version":"0.1-draft"', '"spec_version":"0.0.9"');

    const check = await checkWorkspaceMigrations(workspaceRoot, {
      patchFiles: [patchFile]
    });
    expect(check).toMatchObject({
      supported: true,
      issues: [],
      pending_steps: [
        { step_id: "workspace-spec-0.0.9-to-0.1-draft" },
        { step_id: "case-spec-0.0.9-to-0.1-draft" },
        { step_id: "event-log-spec-0.0.9-to-0.1-draft" },
        { step_id: "patch-spec-0.0.9-to-0.1-draft" }
      ]
    });
    expect(check.targets).toEqual([
      expect.objectContaining({
        target: "workspace",
        from_version: "0.0.9",
        action: "rewrite_spec_version",
        status: "pending"
      }),
      expect.objectContaining({
        target: "case",
        from_version: "0.0.9",
        action: "rewrite_spec_version",
        status: "pending",
        case_id: "migration-legacy"
      }),
      expect.objectContaining({
        target: "event_log",
        from_version: "0.0.9",
        action: "reader_compatible",
        status: "pending",
        case_id: "migration-legacy"
      }),
      expect.objectContaining({
        target: "patch_file",
        from_version: "0.0.9",
        action: "rewrite_spec_version",
        status: "pending"
      })
    ]);

    const dryRun = await runWorkspaceMigrations(workspaceRoot, {
      dryRun: true,
      patchFiles: [patchFile]
    });
    expect(dryRun).toMatchObject({
      dry_run: true,
      changed: false,
      applied_steps: [],
      cache_rebuilt: false
    });
    expect(dryRun.targets.every((target) => target.status === "dry_run")).toBe(true);

    const run = await runWorkspaceMigrations(workspaceRoot, {
      patchFiles: [patchFile]
    });
    expect(run).toMatchObject({
      dry_run: false,
      changed: true,
      cache_rebuilt: true,
      applied_steps: [
        { step_id: "workspace-spec-0.0.9-to-0.1-draft" },
        { step_id: "case-spec-0.0.9-to-0.1-draft" },
        { step_id: "event-log-spec-0.0.9-to-0.1-draft" },
        { step_id: "patch-spec-0.0.9-to-0.1-draft" }
      ]
    });
    expect(run.targets).toEqual([
      expect.objectContaining({
        target: "workspace",
        status: "applied",
        changed: true
      }),
      expect.objectContaining({
        target: "case",
        status: "applied",
        changed: true
      }),
      expect.objectContaining({
        target: "event_log",
        status: "applied",
        changed: false
      }),
      expect.objectContaining({
        target: "patch_file",
        status: "applied",
        changed: true
      })
    ]);

    expect(await readFile(workspaceFile, "utf8")).toContain(`spec_version: ${SPEC_VERSION}`);
    expect(await readFile(caseFile, "utf8")).not.toContain("spec_version:");
    expect(await readFile(eventsFile, "utf8")).toContain('"spec_version":"0.0.9"');
    expect(await readFile(patchFile, "utf8")).toContain(`"spec_version": "${SPEC_VERSION}"`);
  });

  it("fails on unknown workspace, case, and event versions", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-migration-");
    createdWorkspaces.push(workspaceRoot);

    await createCase(
      workspaceRoot,
      {
        case_id: "migration-unknown",
        title: "Unknown version",
        description: "No migration path"
      },
      createDefaultMutationContext()
    );

    const workspaceFile = path.join(workspaceRoot, ".casegraph", "workspace.yaml");
    const caseFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      "migration-unknown",
      "case.yaml"
    );
    const eventsFile = path.join(
      workspaceRoot,
      ".casegraph",
      "cases",
      "migration-unknown",
      "events.jsonl"
    );

    await replaceInFile(workspaceFile, "spec_version: 0.1-draft", "spec_version: 0.0.7");
    const caseContents = await readFile(caseFile, "utf8");
    await writeFile(caseFile, `spec_version: 0.0.7\n${caseContents}`, "utf8");
    await replaceInFile(eventsFile, '"spec_version":"0.1-draft"', '"spec_version":"0.0.7"');

    const check = await checkWorkspaceMigrations(workspaceRoot);
    expect(check.supported).toBe(false);
    expect(check.issues.map((issue) => issue.scope)).toEqual(["workspace", "case", "event"]);
    expect(check.targets.map((target) => target.status)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported"
    ]);

    await expect(runWorkspaceMigrations(workspaceRoot)).rejects.toMatchObject({
      code: "migration_unsupported_version"
    });
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
