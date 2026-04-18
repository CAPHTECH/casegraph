import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "@caphtech/casegraph-cli/app";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];
type NodeLike = { node_id: string };
type ReasonLike = { message: string };

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("cli phase 1 acceptance", () => {
  it("returns exit code 0 for top-level help output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(["--help"], {
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text)
      }
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Usage: cg");
    expect(stdout.join("")).toContain("CaseGraph CLI");
    expect(stderr.join("")).not.toContain("internal_error");
  });

  it("creates a release case and exposes frontier/blockers in JSON", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "release-1.8.0",
      "--title",
      "Release 1.8.0",
      "--description",
      "May release"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "task_run_regression",
      "--kind",
      "task",
      "--title",
      "Run regression test"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "task_update_notes",
      "--kind",
      "task",
      "--title",
      "Update release notes"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "task_submit_store",
      "--kind",
      "task",
      "--title",
      "Submit to App Store"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_submit_depends_regression",
      "--type",
      "depends_on",
      "--from",
      "task_submit_store",
      "--to",
      "task_run_regression"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_submit_depends_notes",
      "--type",
      "depends_on",
      "--from",
      "task_submit_store",
      "--to",
      "task_update_notes"
    ]);

    const frontier = await runJsonCommand(workspaceRoot, ["frontier", "--case", "release-1.8.0"]);
    expect(frontier.code).toBe(0);
    expect(frontier.json.ok).toBe(true);
    expect(nodeIds(frontier.json.data.nodes as NodeLike[])).toEqual([
      "task_run_regression",
      "task_update_notes"
    ]);

    const blockers = await runJsonCommand(workspaceRoot, ["blockers", "--case", "release-1.8.0"]);
    expect(blockers.code).toBe(0);
    expect(blockers.json.data.items).toHaveLength(1);
    expect(blockers.json.data.items[0].node.node_id).toBe("task_submit_store");
    expect(messages(blockers.json.data.items[0].reasons as ReasonLike[])).toEqual([
      "depends_on:task_run_regression is not done",
      "depends_on:task_update_notes is not done"
    ]);

    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "task_run_regression",
      "--case",
      "release-1.8.0"
    ]);
    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "task_update_notes",
      "--case",
      "release-1.8.0"
    ]);

    const nextFrontier = await runJsonCommand(workspaceRoot, [
      "frontier",
      "--case",
      "release-1.8.0"
    ]);
    expect(nodeIds(nextFrontier.json.data.nodes as NodeLike[])).toEqual(["task_submit_store"]);
  });

  it("closes a completed case once goals are terminal and frontier is empty", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "close-demo",
      "--title",
      "Close demo"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "close-demo",
      "--id",
      "goal_release_done",
      "--kind",
      "goal",
      "--title",
      "Release done"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "close-demo",
      "--id",
      "task_publish",
      "--kind",
      "task",
      "--title",
      "Publish release"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "close-demo",
      "--id",
      "edge_publish_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_publish",
      "--to",
      "goal_release_done"
    ]);
    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "task_publish",
      "--case",
      "close-demo"
    ]);
    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "goal_release_done",
      "--case",
      "close-demo"
    ]);

    const close = await runJsonCommand(workspaceRoot, ["case", "close", "--case", "close-demo"]);
    expect(close.code).toBe(0);
    expect(close.json.data).toMatchObject({
      changed: true,
      forced: false,
      case: {
        case_id: "close-demo",
        state: "closed"
      },
      checks: {
        ready_node_ids: [],
        non_terminal_goal_ids: []
      }
    });

    const show = await runJsonCommand(workspaceRoot, ["case", "show", "--case", "close-demo"]);
    expect(show.json.data.case.state).toBe("closed");
  });

  it("rejects close while ready work or unfinished goals remain", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "close-blocked",
      "--title",
      "Close blocked"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "close-blocked",
      "--id",
      "goal_release_done",
      "--kind",
      "goal",
      "--title",
      "Release done"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "close-blocked",
      "--id",
      "task_publish",
      "--kind",
      "task",
      "--title",
      "Publish release"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "close-blocked",
      "--id",
      "edge_publish_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_publish",
      "--to",
      "goal_release_done"
    ]);

    const close = await runJsonCommand(workspaceRoot, ["case", "close", "--case", "close-blocked"]);
    expect(close.code).toBe(4);
    expect(close.json.error.code).toBe("case_close_blocked");
    expect(close.json.error.details.checks.ready_node_ids).toEqual(["task_publish"]);
    expect(close.json.error.details.checks.non_terminal_goal_ids).toEqual(["goal_release_done"]);
  });

  it("requires force when validation warnings remain during close", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "close-warning",
      "--title",
      "Close warning"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "close-warning",
      "--id",
      "goal_release_done",
      "--kind",
      "goal",
      "--title",
      "Release done"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "close-warning",
      "--id",
      "task_publish",
      "--kind",
      "task",
      "--title",
      "Publish release",
      "--metadata",
      "{\"requires_evidence\":true}"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "close-warning",
      "--id",
      "edge_publish_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_publish",
      "--to",
      "goal_release_done"
    ]);
    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "task_publish",
      "--case",
      "close-warning"
    ]);
    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "goal_release_done",
      "--case",
      "close-warning"
    ]);

    const blocked = await runJsonCommand(workspaceRoot, ["case", "close", "--case", "close-warning"]);
    expect(blocked.code).toBe(4);
    expect(blocked.json.error.code).toBe("case_close_requires_force");
    expect(blocked.json.error.details.checks.validation_warnings).toMatchObject([
      { code: "missing_required_evidence", ref: "task_publish" }
    ]);

    const forced = await runJsonCommand(workspaceRoot, [
      "case",
      "close",
      "--case",
      "close-warning",
      "--force"
    ]);
    expect(forced.code).toBe(0);
    expect(forced.json.data).toMatchObject({
      changed: true,
      forced: true,
      case: {
        state: "closed"
      }
    });
  });

  it("rebuilds cache and verifies events through CLI", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "move-2026-05",
      "--title",
      "Move in May 2026",
      "--description",
      "Personal move"
    ]);

    const verify = await runJsonCommand(workspaceRoot, [
      "events",
      "verify",
      "--case",
      "move-2026-05"
    ]);
    expect(verify.json.data.event_count).toBe(1);

    const rebuild = await runJsonCommand(workspaceRoot, ["cache", "rebuild"]);
    expect(rebuild.json.data.cases).toBe(1);

    const validate = await runJsonCommand(workspaceRoot, ["validate", "storage"]);
    expect(validate.json.data.valid).toBe(true);
  });

  it("reports current migration status and a no-op dry run through CLI", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    const check = await runJsonCommand(workspaceRoot, ["migrate", "check"]);
    expect(check.code).toBe(0);
    expect(check.json.data).toMatchObject({
      current_spec_version: "0.1-draft",
      supported: true,
      pending_steps: [],
      issues: [],
      targets: []
    });

    const run = await runJsonCommand(workspaceRoot, ["migrate", "run", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.json.data).toMatchObject({
      dry_run: true,
      changed: false,
      applied_steps: [],
      cache_rebuilt: false,
      targets: []
    });
  });

  it("applies supported legacy migration paths through CLI", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "migration-legacy",
      "--title",
      "Legacy migration case",
      "--description",
      "Legacy version"
    ]);

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
          operations: [],
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

    const check = await runJsonCommand(workspaceRoot, [
      "migrate",
      "check",
      "--patch-file",
      patchFile
    ]);
    expect(check.code).toBe(0);
    expect(check.json.data.pending_steps.map((step: { step_id: string }) => step.step_id)).toEqual([
      "workspace-spec-0.0.9-to-0.1-draft",
      "case-spec-0.0.9-to-0.1-draft",
      "event-log-spec-0.0.9-to-0.1-draft",
      "patch-spec-0.0.9-to-0.1-draft"
    ]);

    const run = await runJsonCommand(workspaceRoot, ["migrate", "run", "--patch-file", patchFile]);
    expect(run.code).toBe(0);
    expect(run.json.data).toMatchObject({
      changed: true,
      cache_rebuilt: true
    });
    expect(run.json.data.targets.map((target: { status: string }) => target.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied"
    ]);
  });

  it("fails migrate run with structured issues on unknown versions", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "migration-unknown",
      "--title",
      "Unknown migration case",
      "--description",
      "Unknown version"
    ]);

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

    const run = await runJsonCommand(workspaceRoot, ["migrate", "run"]);
    expect(run.code).toBe(2);
    expect(run.json.ok).toBe(false);
    expect(run.json.error.code).toBe("migration_unsupported_version");
    expect(run.json.error.details.issues.map((issue: { scope: string }) => issue.scope)).toEqual([
      "workspace",
      "case",
      "event"
    ]);
  });

  it("emits JSON errors for parse failures when json output is requested", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    const result = await runJsonCommand(workspaceRoot, ["unknown-command"]);

    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.command).toBe("cg");
    expect(result.json.error.code).toBe("internal_error");
  });

  it("emits a single JSON payload for action errors", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, ["init"]);
    const result = await runJsonCommand(workspaceRoot, ["validate"]);

    expect(result.code).toBe(2);
    expect(result.stderr.startsWith("{")).toBe(true);
    expect(result.json.ok).toBe(false);
    expect(result.json.error.code).toBe("missing_case");
    expect(result.json.error.message).toBe("--case is required for validate");
  });

  it("imports markdown, reviews the patch, and applies it through CLI", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);
    const markdownFile = path.join(workspaceRoot, "release-notes.md");
    const patchFile = path.join(workspaceRoot, "release-import.patch.json");

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "release-1.8.0",
      "--title",
      "Release 1.8.0",
      "--description",
      "May release"
    ]);

    await writeFile(
      markdownFile,
      [
        "- [ ] Prepare release #release [priority:high]",
        "  - [x] Run regression #qa",
        "  - [ ] Update release notes [due_date:2026-05-01]"
      ].join("\n"),
      "utf8"
    );

    const imported = await runJsonCommand(workspaceRoot, [
      "import",
      "markdown",
      "--case",
      "release-1.8.0",
      "--file",
      markdownFile,
      "--output",
      patchFile
    ]);
    expect(imported.code).toBe(0);
    expect(imported.json.data.output_file).toBe(patchFile);
    expect(imported.json.data.patch.base_revision).toBe(1);

    const review = await runJsonCommand(workspaceRoot, ["patch", "review", "--file", patchFile]);
    expect(review.json.data.valid).toBe(true);

    const applied = await runJsonCommand(workspaceRoot, ["patch", "apply", "--file", patchFile]);
    expect(applied.code).toBe(0);
    expect(applied.json.revision.current).toBe(2);

    const frontier = await runJsonCommand(workspaceRoot, ["frontier", "--case", "release-1.8.0"]);
    expect(nodeIds(frontier.json.data.nodes as NodeLike[])).toEqual([
      "task_update_release_notes_l3"
    ]);
  });

  it("returns impact and critical path analysis in JSON", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "release-1.8.0",
      "--title",
      "Release 1.8.0",
      "--description",
      "May release"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "goal_release_ready",
      "--kind",
      "goal",
      "--title",
      "Release 1.8.0 ready"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "task_run_regression",
      "--kind",
      "task",
      "--title",
      "Run regression test",
      "--metadata",
      '{"estimate_minutes":45}'
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "task_update_notes",
      "--kind",
      "task",
      "--title",
      "Update release notes",
      "--metadata",
      '{"estimate_minutes":15}'
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "task_submit_store",
      "--kind",
      "task",
      "--title",
      "Submit to App Store",
      "--metadata",
      '{"estimate_minutes":20}'
    ]);

    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_submit_depends_regression",
      "--type",
      "depends_on",
      "--from",
      "task_submit_store",
      "--to",
      "task_run_regression"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_submit_depends_notes",
      "--type",
      "depends_on",
      "--from",
      "task_submit_store",
      "--to",
      "task_update_notes"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_regression_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_run_regression",
      "--to",
      "goal_release_ready"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_notes_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_update_notes",
      "--to",
      "goal_release_ready"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-1.8.0",
      "--id",
      "edge_submit_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_submit_store",
      "--to",
      "goal_release_ready"
    ]);

    const criticalPath = await runJsonCommand(workspaceRoot, [
      "analyze",
      "critical-path",
      "--case",
      "release-1.8.0",
      "--goal",
      "goal_release_ready"
    ]);
    expect(criticalPath.code).toBe(0);
    expect(criticalPath.json.data.depth_path.node_ids).toEqual([
      "task_run_regression",
      "task_submit_store"
    ]);
    expect(criticalPath.json.data.duration_path.node_ids).toEqual([
      "task_run_regression",
      "task_submit_store"
    ]);

    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "task_run_regression",
      "--case",
      "release-1.8.0"
    ]);
    await runJsonCommand(workspaceRoot, [
      "task",
      "done",
      "task_update_notes",
      "--case",
      "release-1.8.0"
    ]);

    const impact = await runJsonCommand(workspaceRoot, [
      "analyze",
      "impact",
      "--case",
      "release-1.8.0",
      "--node",
      "task_run_regression"
    ]);
    expect(impact.code).toBe(0);
    expect(nodeIds(impact.json.data.hard_impact as NodeLike[])).toEqual(["task_submit_store"]);
    expect(nodeIds(impact.json.data.context_impact as NodeLike[])).toEqual(["goal_release_ready"]);
    expect(nodeIds(impact.json.data.frontier_invalidations as NodeLike[])).toEqual([
      "task_submit_store"
    ]);
  });

  it("returns path, structure, and unblock analysis in JSON", async () => {
    const workspaceRoot = await createTempWorkspace("casegraph-cli-");
    createdWorkspaces.push(workspaceRoot);

    await runJsonCommand(workspaceRoot, [
      "case",
      "new",
      "--id",
      "release-topology",
      "--title",
      "Release topology",
      "--description",
      "Topology analysis"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "goal_release_ready",
      "--kind",
      "goal",
      "--title",
      "Release ready"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "task_prepare",
      "--kind",
      "task",
      "--title",
      "Prepare build",
      "--metadata",
      '{"estimate_minutes":20}'
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "task_review",
      "--kind",
      "task",
      "--title",
      "Review build",
      "--metadata",
      '{"estimate_minutes":10}'
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "task_docs",
      "--kind",
      "task",
      "--title",
      "Write docs",
      "--metadata",
      '{"estimate_minutes":5}'
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "task_publish",
      "--kind",
      "task",
      "--title",
      "Publish release",
      "--metadata",
      '{"estimate_minutes":5}'
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "event_release_window",
      "--kind",
      "event",
      "--title",
      "Release window"
    ]);
    await runJsonCommand(workspaceRoot, [
      "node",
      "add",
      "--case",
      "release-topology",
      "--id",
      "task_monitor",
      "--kind",
      "task",
      "--title",
      "Monitor release",
      "--metadata",
      '{"estimate_minutes":5}'
    ]);

    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_review_prepare",
      "--type",
      "depends_on",
      "--from",
      "task_review",
      "--to",
      "task_prepare"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_docs_prepare",
      "--type",
      "depends_on",
      "--from",
      "task_docs",
      "--to",
      "task_prepare"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_publish_review",
      "--type",
      "depends_on",
      "--from",
      "task_publish",
      "--to",
      "task_review"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_monitor_publish",
      "--type",
      "depends_on",
      "--from",
      "task_monitor",
      "--to",
      "task_publish"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_monitor_window",
      "--type",
      "waits_for",
      "--from",
      "task_monitor",
      "--to",
      "event_release_window"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_publish_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_publish",
      "--to",
      "goal_release_ready"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_docs_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_docs",
      "--to",
      "goal_release_ready"
    ]);
    await runJsonCommand(workspaceRoot, [
      "edge",
      "add",
      "--case",
      "release-topology",
      "--id",
      "edge_monitor_goal",
      "--type",
      "contributes_to",
      "--from",
      "task_monitor",
      "--to",
      "goal_release_ready"
    ]);

    const slack = await runJsonCommand(workspaceRoot, [
      "analyze",
      "slack",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(slack.code).toBe(0);
    expect(slack.json.data.projected_duration_minutes).toBe(40);
    expect(slack.json.data.nodes.map((node: { node_id: string }) => node.node_id)).toEqual([
      "task_prepare",
      "task_review",
      "task_publish",
      "task_monitor",
      "task_docs",
      "event_release_window"
    ]);
    const docsNode = slack.json.data.nodes.find(
      (node: { node_id: string; slack_minutes: number }) => node.node_id === "task_docs"
    );
    expect(docsNode?.slack_minutes).toBe(15);

    const bottlenecks = await runJsonCommand(workspaceRoot, [
      "analyze",
      "bottlenecks",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(bottlenecks.code).toBe(0);
    expect(bottlenecks.json.data.nodes[0]).toMatchObject({
      node_id: "task_prepare",
      downstream_count: 4,
      goal_context_count: 1
    });

    const unblock = await runJsonCommand(workspaceRoot, [
      "analyze",
      "unblock",
      "--case",
      "release-topology",
      "--node",
      "task_monitor"
    ]);
    expect(unblock.code).toBe(0);
    expect(unblock.json.data.actionable_leaf_node_ids).toEqual(["task_prepare"]);
    expect(unblock.json.data.blockers).toEqual([
      expect.objectContaining({
        node_id: "task_prepare",
        actionable: true
      }),
      expect.objectContaining({
        node_id: "event_release_window",
        actionable: false
      })
    ]);

    const cycles = await runJsonCommand(workspaceRoot, [
      "analyze",
      "cycles",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(cycles.code).toBe(0);
    expect(cycles.json.data.cycle_count).toBe(0);

    const components = await runJsonCommand(workspaceRoot, [
      "analyze",
      "components",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(components.code).toBe(0);
    expect(components.json.data.components).toEqual([
      {
        edge_count: 5,
        node_count: 6,
        node_ids: [
          "event_release_window",
          "task_docs",
          "task_monitor",
          "task_prepare",
          "task_publish",
          "task_review"
        ]
      }
    ]);

    const bridges = await runJsonCommand(workspaceRoot, [
      "analyze",
      "bridges",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(bridges.code).toBe(0);
    expect(
      bridges.json.data.bridges.map(
        (bridge: { source_id: string; target_id: string }) =>
          `${bridge.source_id}::${bridge.target_id}`
      )
    ).toEqual([
      "event_release_window::task_monitor",
      "task_docs::task_prepare",
      "task_monitor::task_publish",
      "task_prepare::task_review",
      "task_publish::task_review"
    ]);

    const cutpoints = await runJsonCommand(workspaceRoot, [
      "analyze",
      "cutpoints",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(cutpoints.code).toBe(0);
    expect(
      cutpoints.json.data.cutpoints.map((cutpoint: { node_id: string }) => cutpoint.node_id)
    ).toEqual(["task_monitor", "task_prepare", "task_publish", "task_review"]);

    const fragility = await runJsonCommand(workspaceRoot, [
      "analyze",
      "fragility",
      "--case",
      "release-topology",
      "--goal",
      "goal_release_ready"
    ]);
    expect(fragility.code).toBe(0);
    expect(fragility.json.data.nodes[0]).toMatchObject({
      node_id: "task_prepare",
      reason_tags: ["cutpoint", "bridge", "bottleneck"]
    });
    expect(fragility.json.data.warnings).toEqual([]);
  });
});

async function runJsonCommand(workspaceRoot: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["--format", "json", ...args], {
    cwd: workspaceRoot,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    }
  });

  const output = stdout.join("").trim();
  const errorOutput = stderr.join("").trim();
  const payload = output.length > 0 ? output : errorOutput;
  return {
    code,
    stdout: output,
    stderr: errorOutput,
    json: payload.length > 0 ? JSON.parse(payload) : null
  };
}

function nodeIds(nodes: NodeLike[]): string[] {
  return nodes.map((node) => node.node_id);
}

function messages(reasons: ReasonLike[]): string[] {
  return reasons.map((reason) => reason.message);
}

async function replaceInFile(filePath: string, searchValue: string, replaceValue: string) {
  const contents = await readFile(filePath, "utf8");
  await writeFile(filePath, contents.replace(searchValue, replaceValue), "utf8");
}
