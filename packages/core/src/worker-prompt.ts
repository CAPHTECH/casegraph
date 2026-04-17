import { SPEC_VERSION } from "./constants.js";
import { validateGraphPatchDocument } from "./patch.js";
import type { GraphPatch, ValidationIssue } from "./types.js";
import type { WorkerExecuteParams } from "./worker-types.js";

export type PatchExtractionResult =
  | { ok: true; patch: GraphPatch }
  | { ok: false; reason: PatchExtractionFailure };

export type PatchExtractionFailure =
  | { code: "no_fence_found"; message: string }
  | { code: "json_parse_error"; message: string }
  | { code: "patch_invalid"; message: string; errors: ValidationIssue[] };

const FENCE_RE = /```([a-zA-Z0-9_-]+)\n([\s\S]*?)```/g;
const PREFERRED_FENCE = "casegraph-patch";
const FALLBACK_FENCE = "json";

export function buildAgentPrompt(params: WorkerExecuteParams): string {
  const lines: string[] = [];
  lines.push("You are a CaseGraph worker. Produce exactly one GraphPatch as a fenced block.");
  lines.push("");
  lines.push(`Case: ${params.case.case_id} ("${params.case.title}")`);
  lines.push(`Base revision: ${params.case.base_revision}`);
  lines.push("");
  lines.push(`Task node: ${params.task.node_id} [${params.task.kind}/${params.task.state}]`);
  lines.push(`Title: ${params.task.title}`);
  if (params.task.description.trim().length > 0) {
    lines.push(`Description: ${params.task.description}`);
  }
  if (params.task.acceptance.length > 0) {
    lines.push("Acceptance:");
    for (const item of params.task.acceptance) {
      lines.push(`  - ${item}`);
    }
  }
  if (params.context.related_nodes.length > 0) {
    lines.push("Related nodes:");
    for (const related of params.context.related_nodes) {
      lines.push(
        `  - ${related.node_id} [${related.kind}/${related.state}] ${related.title} (relation=${related.relation})`
      );
    }
  }
  if (params.context.attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of params.context.attachments) {
      lines.push(`  - ${attachment.attachment_id} -> ${attachment.path_or_url}`);
    }
  }
  lines.push("");
  lines.push("Output contract:");
  lines.push(
    `Reply with ONE fenced block labeled \`${PREFERRED_FENCE}\` containing a GraphPatch JSON.`
  );
  lines.push("Keep `base_revision` at 0 (CaseGraph rewrites it). Emit no prose outside the fence.");
  lines.push("");
  lines.push("Envelope:");
  lines.push("```" + PREFERRED_FENCE);
  lines.push(
    JSON.stringify(
      {
        patch_id: "patch_<your_unique_id>",
        spec_version: SPEC_VERSION,
        case_id: params.case.case_id,
        base_revision: 0,
        summary: "<one-line summary>",
        generator: { kind: "worker", name: "<worker-name>" },
        operations: ["<one or more ops from the table below>"]
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push("Allowed operations (pick the minimum that accomplishes the task):");
  lines.push(
    "```json\n" +
      JSON.stringify(
        [
          {
            op: "change_state",
            node_id: "<node_id>",
            state: "done"
          },
          {
            op: "add_node",
            node: {
              node_id: "<new_node_id>",
              kind: "task",
              title: "<title>",
              state: "todo"
            }
          },
          {
            op: "update_node",
            node_id: "<existing_node_id>",
            changes: {
              title: "<new title>",
              metadata: { priority: "high" }
            }
          },
          {
            op: "remove_node",
            node_id: "<existing_node_id>"
          },
          {
            op: "add_edge",
            edge: {
              edge_id: "<new_edge_id>",
              type: "depends_on",
              source_id: "<dependent_node_id>",
              target_id: "<prerequisite_node_id>"
            }
          },
          {
            op: "remove_edge",
            edge_id: "<existing_edge_id>"
          },
          {
            op: "attach_evidence",
            evidence: {
              node_id: "<new_evidence_id>",
              title: "<evidence title>"
            },
            verifies_target_id: "<task_being_verified>"
          },
          {
            op: "set_case_field",
            changes: {
              state: "closed"
            }
          }
        ],
        null,
        2
      ) +
      "\n```"
  );
  lines.push("");
  lines.push("Schema notes (common mistakes):");
  lines.push("- `update_node` puts the mutable fields under `changes` (not directly on the op).");
  lines.push("- `change_state` accepts states: todo, doing, waiting, done, cancelled, failed.");
  lines.push("- Edge types: depends_on, waits_for, alternative_to, verifies, contributes_to.");
  lines.push("- `node.kind` is one of: goal, task, decision, event, evidence.");
  return lines.join("\n");
}

const MAX_REPRINT_CHARS = 1200;

export interface RetryPromptInput {
  originalPrompt: string;
  previousResponse: string;
  reason: PatchExtractionFailure;
}

export function buildRetryPrompt(input: RetryPromptInput): string {
  const reprint =
    input.previousResponse.length > MAX_REPRINT_CHARS
      ? `${input.previousResponse.slice(0, MAX_REPRINT_CHARS)}\n... [truncated, ${input.previousResponse.length - MAX_REPRINT_CHARS} more chars]`
      : input.previousResponse;
  return [
    input.originalPrompt,
    "",
    "---",
    "",
    "CaseGraph rejected your previous attempt.",
    "",
    "Your previous response was:",
    "<<<PREVIOUS",
    reprint,
    "PREVIOUS>>>",
    "",
    `Rejection code: ${input.reason.code}`,
    `Rejection message: ${input.reason.message}`,
    "",
    "Please emit a corrected GraphPatch fenced block that fixes the issue above. Emit no prose outside the fence."
  ].join("\n");
}

export function extractPatchFromText(text: string, caseId: string): PatchExtractionResult {
  const blocks = collectFencedBlocks(text);
  const candidate = pickCandidate(blocks);
  if (!candidate) {
    return {
      ok: false,
      reason: {
        code: "no_fence_found",
        message: "No fenced `casegraph-patch` or `json` code block was found in the agent response"
      }
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      reason: {
        code: "json_parse_error",
        message: `JSON.parse failed inside the fenced block: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }

  const validation = validateGraphPatchDocument(overrideCaseId(parsed, caseId));
  if (!validation.patch || validation.errors.length > 0) {
    return {
      ok: false,
      reason: {
        code: "patch_invalid",
        message: validation.errors
          .map((issue) => `${issue.code}${issue.ref ? ` @ ${issue.ref}` : ""}: ${issue.message}`)
          .join("; "),
        errors: validation.errors
      }
    };
  }
  return { ok: true, patch: validation.patch };
}

function collectFencedBlocks(text: string): Array<{ label: string; body: string }> {
  const out: Array<{ label: string; body: string }> = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = FENCE_RE.exec(text);
  while (match) {
    out.push({ label: match[1] ?? "", body: (match[2] ?? "").trim() });
    match = FENCE_RE.exec(text);
  }
  return out;
}

function pickCandidate(blocks: Array<{ label: string; body: string }>): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block && block.label === PREFERRED_FENCE) {
      return block.body;
    }
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block && block.label === FALLBACK_FENCE) {
      return block.body;
    }
  }
  return null;
}

function overrideCaseId(input: unknown, caseId: string): unknown {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as { case_id?: unknown }).case_id === "string"
  ) {
    return input;
  }
  return { ...(input as Record<string, unknown>), case_id: caseId };
}
