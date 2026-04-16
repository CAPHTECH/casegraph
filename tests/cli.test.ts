import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "@casegraph/cli/app";
import { afterEach, describe, expect, it } from "vitest";

import { createTempWorkspace, removeTempWorkspace } from "./helpers/workspace.js";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempWorkspace(createdWorkspaces.pop() as string);
  }
});

describe("cli phase 1 acceptance", () => {
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
    expect(frontier.json.data.nodes.map((node: any) => node.node_id)).toEqual([
      "task_run_regression",
      "task_update_notes"
    ]);

    const blockers = await runJsonCommand(workspaceRoot, ["blockers", "--case", "release-1.8.0"]);
    expect(blockers.code).toBe(0);
    expect(blockers.json.data.items).toHaveLength(1);
    expect(blockers.json.data.items[0].node.node_id).toBe("task_submit_store");
    expect(blockers.json.data.items[0].reasons.map((reason: any) => reason.message)).toEqual([
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
    expect(nextFrontier.json.data.nodes.map((node: any) => node.node_id)).toEqual([
      "task_submit_store"
    ]);
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

    expect(result.code).toBe(1);
    expect(result.stderr.startsWith("{")).toBe(true);
    expect(result.json.ok).toBe(false);
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
    expect(frontier.json.data.nodes.map((node: any) => node.node_id)).toEqual([
      "task_update_release_notes_l3"
    ]);
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
