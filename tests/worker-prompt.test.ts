import {
  buildAgentPrompt,
  buildRetryPrompt,
  extractPatchFromText,
  SPEC_VERSION,
  type WorkerExecuteParams
} from "@caphtech/casegraph-kernel";
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
    const result = extractPatchFromText(validFencedPatch("casegraph-patch"), "demo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.patch_id).toBe("patch_x");
      expect(result.patch.operations[0]).toMatchObject({ op: "change_state", node_id: "task_x" });
    }
  });

  it("falls back to a json fence when no casegraph-patch fence exists", () => {
    const result = extractPatchFromText(validFencedPatch("json"), "demo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.patch_id).toBe("patch_x");
    }
  });

  it("returns no_fence_found when no fence is present", () => {
    const result = extractPatchFromText("just prose, no code block", "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("no_fence_found");
    }
  });

  it("returns json_parse_error on malformed JSON inside the fence", () => {
    const text = "```casegraph-patch\n{ not valid json\n```";
    const result = extractPatchFromText(text, "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("json_parse_error");
      expect(result.reason.message).toMatch(/json/i);
    }
  });

  it("returns patch_invalid with enumerated errors for a malformed patch", () => {
    // Missing `changes` on update_node (the exact Claude mistake we saw in dogfood)
    const malformed = {
      patch_id: "patch_bad",
      spec_version: SPEC_VERSION,
      case_id: "demo",
      base_revision: 0,
      summary: "update_node without changes",
      operations: [
        {
          op: "update_node",
          node_id: "task_x",
          metadata: { priority: "high" }
        }
      ]
    };
    const text = `\`\`\`casegraph-patch\n${JSON.stringify(malformed)}\n\`\`\``;
    const result = extractPatchFromText(text, "demo");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason.code === "patch_invalid") {
      expect(result.reason.errors.length).toBeGreaterThan(0);
      expect(result.reason.message).toMatch(/update_node|changes/);
    }
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
    const result = extractPatchFromText(text, "demo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.patch_id).toBe("patch_from_cg");
    }
  });

  it("buildRetryPrompt includes the original prompt plus the rejection reason", () => {
    const original = buildAgentPrompt(params);
    const retry = buildRetryPrompt({
      originalPrompt: original,
      previousResponse: "I thought about it but chose not to emit a patch.",
      reason: {
        code: "patch_invalid",
        message: "update_node requires changes",
        errors: []
      }
    });
    expect(retry.startsWith(original)).toBe(true);
    expect(retry).toContain("CaseGraph rejected your previous attempt");
    expect(retry).toContain("Rejection code: patch_invalid");
    expect(retry).toContain("update_node requires changes");
    expect(retry).toContain("I thought about it but chose not to emit a patch.");
  });

  it("buildRetryPrompt truncates a pathologically large previous response", () => {
    const huge = "x".repeat(5000);
    const retry = buildRetryPrompt({
      originalPrompt: "original",
      previousResponse: huge,
      reason: { code: "no_fence_found", message: "no fence" }
    });
    expect(retry).toContain("... [truncated");
    expect(retry.length).toBeLessThan(5000);
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
    const result = extractPatchFromText(text, "demo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.case_id).toBe("demo");
    }
  });
});
