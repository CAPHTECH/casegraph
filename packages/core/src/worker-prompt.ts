import { SPEC_VERSION } from "./constants.js";
import { validateGraphPatchDocument } from "./patch.js";
import type { GraphPatch } from "./types.js";
import type { WorkerExecuteParams } from "./worker-types.js";

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
    `Reply with ONE fenced block labeled \`${PREFERRED_FENCE}\` containing a GraphPatch JSON:`
  );
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
        operations: [
          {
            op: "change_state",
            node_id: params.task.node_id,
            state: "done"
          }
        ]
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push(
    "The `base_revision` field will be rewritten by CaseGraph; leave it at 0. Emit no prose outside the fence."
  );
  return lines.join("\n");
}

export function extractPatchFromText(text: string, caseId: string): GraphPatch | null {
  const blocks = collectFencedBlocks(text);
  const candidate = pickCandidate(blocks);
  if (!candidate) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const validation = validateGraphPatchDocument(overrideCaseId(parsed, caseId));
  if (!validation.patch || validation.errors.length > 0) {
    return null;
  }
  return validation.patch;
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
