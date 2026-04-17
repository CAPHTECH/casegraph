import {
  buildAgentPrompt,
  extractPatchFromText,
  SPEC_VERSION,
  type WorkerExecuteParams
} from "@casegraph/core";
import { describe, expect, it } from "vitest";

const params: WorkerExecuteParams = {
  case: { case_id: "demo", title: "Demo", base_revision: 3 },
  task: {
    node_id: "task_x",
    kind: "task",
    state: "todo",
    title: "Example task",
    description: "Example description",
    acceptance: ["a1", "a2"],
    labels: [],
    metadata: {}
  },
  context: {
    related_nodes: [
      {
        node_id: "task_y",
        kind: "task",
        state: "done",
        title: "Prereq",
        relation: "depends_on"
      }
    ],
    attachments: [],
    metadata: {}
  },
  execution_policy: {
    effectful: true,
    approval: "required",
    timeout_seconds: 30,
    command_id: "cmd_1"
  }
};

function validFencedPatch(fence: string, caseId = "demo"): string {
  const patch = {
    patch_id: "patch_x",
    spec_version: SPEC_VERSION,
    case_id: caseId,
    base_revision: 0,
    summary: "mark done",
    operations: [{ op: "change_state", node_id: "task_x", state: "done" }]
  };
  return `prose before\n\`\`\`${fence}\n${JSON.stringify(patch)}\n\`\`\`\ntrailing prose`;
}

describe("worker-prompt", () => {
  it("buildAgentPrompt mentions case, task, related, and the fence contract", () => {
    const text = buildAgentPrompt(params);
    expect(text).toContain("demo");
    expect(text).toContain("task_x");
    expect(text).toContain("task_y");
    expect(text).toContain("depends_on");
    expect(text).toContain("```casegraph-patch");
  });

  it("extractPatchFromText parses a casegraph-patch fence", () => {
    const patch = extractPatchFromText(validFencedPatch("casegraph-patch"), "demo");
    expect(patch?.patch_id).toBe("patch_x");
    expect(patch?.operations[0]).toMatchObject({ op: "change_state", node_id: "task_x" });
  });

  it("falls back to a json fence when no casegraph-patch fence exists", () => {
    const patch = extractPatchFromText(validFencedPatch("json"), "demo");
    expect(patch?.patch_id).toBe("patch_x");
  });

  it("returns null when no fence is present", () => {
    expect(extractPatchFromText("just prose, no code block", "demo")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const text = "```casegraph-patch\n{ not valid json\n```";
    expect(extractPatchFromText(text, "demo")).toBeNull();
  });

  it("prefers casegraph-patch over a json fence when both exist", () => {
    const jsonPatch = {
      patch_id: "patch_from_json",
      spec_version: SPEC_VERSION,
      case_id: "demo",
      base_revision: 0,
      summary: "json fence",
      operations: [{ op: "change_state", node_id: "task_x", state: "doing" }]
    };
    const cgPatch = {
      patch_id: "patch_from_cg",
      spec_version: SPEC_VERSION,
      case_id: "demo",
      base_revision: 0,
      summary: "cg fence",
      operations: [{ op: "change_state", node_id: "task_x", state: "done" }]
    };
    const text =
      "```json\n" +
      JSON.stringify(jsonPatch) +
      "\n```\n" +
      "```casegraph-patch\n" +
      JSON.stringify(cgPatch) +
      "\n```";
    const extracted = extractPatchFromText(text, "demo");
    expect(extracted?.patch_id).toBe("patch_from_cg");
  });

  it("injects case_id when the fence block omits it", () => {
    const patch = {
      patch_id: "patch_no_case",
      spec_version: SPEC_VERSION,
      base_revision: 0,
      summary: "no case_id in block",
      operations: [{ op: "change_state", node_id: "task_x", state: "done" }]
    };
    const text = `\`\`\`casegraph-patch\n${JSON.stringify(patch)}\n\`\`\``;
    const extracted = extractPatchFromText(text, "demo");
    expect(extracted?.case_id).toBe("demo");
  });
});
