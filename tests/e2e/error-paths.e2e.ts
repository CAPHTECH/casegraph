import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptyWorkspaceDir, removeTempDir, runCgJson } from "../helpers/e2e.js";

interface OkResult {
  ok: true;
  data: Record<string, unknown>;
  revision?: { current: number };
}

interface ErrResult {
  ok: false;
  error: { code: string; message: string };
}

const createdWorkspaces: string[] = [];

afterEach(async () => {
  while (createdWorkspaces.length > 0) {
    await removeTempDir(createdWorkspaces.pop() as string);
  }
});

async function bootstrapCase(workspaceRoot: string): Promise<number> {
  await runCgJson(workspaceRoot, ["init", "--title", "ErrorPaths"]);
  await runCgJson(workspaceRoot, ["case", "new", "--id", "c1", "--title", "C1"]);
  await runCgJson(workspaceRoot, [
    "node",
    "add",
    "--case",
    "c1",
    "--id",
    "task_a",
    "--kind",
    "task",
    "--title",
    "Task A"
  ]);
  const evid = await runCgJson<OkResult>(workspaceRoot, [
    "evidence",
    "add",
    "--case",
    "c1",
    "--id",
    "evidence_1",
    "--target",
    "task_a",
    "--title",
    "Proof"
  ]);
  return evid.json?.revision?.current as number;
}

async function writePatch(
  workspaceRoot: string,
  name: string,
  patch: Record<string, unknown>
): Promise<string> {
  const file = path.join(workspaceRoot, name);
  await writeFile(file, JSON.stringify(patch), "utf8");
  return file;
}

describe("black-box e2e error paths", () => {
  it("rejects event.record on a non-event node with exit 2 validation_error", async () => {
    const workspaceRoot = await createEmptyWorkspaceDir("casegraph-e2e-err-event-");
    createdWorkspaces.push(workspaceRoot);
    await bootstrapCase(workspaceRoot);

    const result = await runCgJson<ErrResult>(workspaceRoot, [
      "event",
      "record",
      "--case",
      "c1",
      "task_a"
    ]);
    expect(result.code).toBe(2);
    expect(result.json?.ok).toBe(false);
    expect(result.json?.error.code).toBe("validation_error");
    expect(result.json?.error.message).toContain("requires kind 'event'");
  });

  it("rejects event.record on a missing node with exit 3 not_found", async () => {
    const workspaceRoot = await createEmptyWorkspaceDir("casegraph-e2e-err-missing-");
    createdWorkspaces.push(workspaceRoot);
    await bootstrapCase(workspaceRoot);

    const result = await runCgJson<ErrResult>(workspaceRoot, [
      "event",
      "record",
      "--case",
      "c1",
      "ghost_node"
    ]);
    expect(result.code).toBe(3);
    expect(result.json?.ok).toBe(false);
    expect(result.json?.error.code).toBe("not_found");
  });

  it("rejects patch update_node with empty changes via patch_invalid on apply (exit 2)", async () => {
    const workspaceRoot = await createEmptyWorkspaceDir("casegraph-e2e-err-empty-");
    createdWorkspaces.push(workspaceRoot);
    const revision = await bootstrapCase(workspaceRoot);

    const patchFile = await writePatch(workspaceRoot, "empty.patch.json", {
      patch_id: "p_empty",
      spec_version: "0.1-draft",
      case_id: "c1",
      base_revision: revision,
      summary: "empty update_node",
      generator: { kind: "user", name: "e2e" },
      operations: [{ op: "update_node", node_id: "task_a", changes: {} }]
    });

    const validate = await runCgJson<{
      ok: true;
      data: { valid: boolean; errors: { code: string }[] };
    }>(workspaceRoot, ["patch", "validate", "--file", patchFile]);
    expect(validate.code).toBe(0);
    expect(validate.json?.data.valid).toBe(false);
    expect(
      validate.json?.data.errors.some((e) => e.code === "patch_update_node_changes_empty")
    ).toBe(true);

    const apply = await runCgJson<ErrResult>(workspaceRoot, [
      "patch",
      "apply",
      "--file",
      patchFile
    ]);
    expect(apply.code).toBe(2);
    expect(apply.json?.error.code).toBe("patch_invalid");
  });

  it("rejects change_state targeting an evidence node as patch_invalid (exit 2)", async () => {
    const workspaceRoot = await createEmptyWorkspaceDir("casegraph-e2e-err-evidence-");
    createdWorkspaces.push(workspaceRoot);
    const revision = await bootstrapCase(workspaceRoot);

    const patchFile = await writePatch(workspaceRoot, "evidence.patch.json", {
      patch_id: "p_evidence",
      spec_version: "0.1-draft",
      case_id: "c1",
      base_revision: revision,
      summary: "evidence regression",
      generator: { kind: "user", name: "e2e" },
      operations: [{ op: "change_state", node_id: "evidence_1", state: "todo" }]
    });

    const review = await runCgJson<ErrResult>(workspaceRoot, [
      "patch",
      "review",
      "--file",
      patchFile
    ]);
    expect(review.code).toBe(0);
    const data = (
      review.json as unknown as { data: { valid: boolean; errors: { code: string }[] } }
    ).data;
    expect(data.valid).toBe(false);
    expect(data.errors.some((e) => e.code === "patch_change_state_evidence")).toBe(true);

    const apply = await runCgJson<ErrResult>(workspaceRoot, [
      "patch",
      "apply",
      "--file",
      patchFile
    ]);
    expect(apply.code).toBe(2);
    expect(apply.json?.error.code).toBe("patch_invalid");
  });
});
