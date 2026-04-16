#!/usr/bin/env -S node --experimental-strip-types

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord, runPluginStdioServer } from "@casegraph/core/plugin-server";

const SPEC_VERSION = "0.1-draft";
const SINK_NAME = "markdown";
const SINK_VERSION = "0.1.0";
const PROJECTION_FILENAME = "markdown.md";

const SINK_CAPABILITIES = {
  push: true,
  pull: true,
  dry_run: true,
  supports_labels: true,
  supports_notes: false,
  supports_due_date: false,
  supports_idempotency_key: false
};

interface NodeSnapshot {
  node_id: string;
  kind: string;
  state: string;
  title: string;
  labels: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface Mapping {
  sink_name: string;
  internal_node_id: string;
  external_item_id: string;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  last_known_external_hash: string | null;
}

interface PlanParams {
  case_id: string;
  base_revision: number;
  actionable: NodeSnapshot[];
  waiting: NodeSnapshot[];
  mapping: Mapping[];
}

interface SinkOperation {
  op: "upsert_item" | "complete_item" | "archive_item";
  internal_node_id: string;
  external_item_id?: string;
  title?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  bucket?: "actionable" | "waiting";
}

interface ApplyParams {
  case_id: string;
  plan: SinkOperation[];
}

interface PullParams {
  case_id: string;
  base_revision: number;
  mapping: Mapping[];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPluginStdioServer({
    info: {
      name: `casegraph-sink-${SINK_NAME}`,
      version: SINK_VERSION,
      capabilities: SINK_CAPABILITIES,
      methods: ["sink.planProjection", "sink.applyProjection", "sink.pullChanges"],
      extra: { sink: SINK_CAPABILITIES }
    },
    handlers: {
      "sink.planProjection": (params) => buildProjectionPlan(assertPlanParams(params)),
      "sink.applyProjection": (params) => applyProjection(assertApplyParams(params)),
      "sink.pullChanges": (params) => pullChanges(assertPullParams(params))
    }
  });
}

export function buildProjectionPlan(params: PlanParams): {
  plan: SinkOperation[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const plan: SinkOperation[] = [];
  const seen = new Set<string>();

  for (const node of params.actionable) {
    seen.add(node.node_id);
    plan.push({
      op: "upsert_item",
      internal_node_id: node.node_id,
      external_item_id: node.node_id,
      title: node.title,
      labels: node.labels,
      metadata: node.metadata,
      bucket: "actionable"
    });
  }

  for (const node of params.waiting) {
    if (seen.has(node.node_id)) {
      continue;
    }
    seen.add(node.node_id);
    plan.push({
      op: "upsert_item",
      internal_node_id: node.node_id,
      external_item_id: node.node_id,
      title: node.title,
      labels: node.labels,
      metadata: node.metadata,
      bucket: "waiting"
    });
  }

  for (const mapping of params.mapping) {
    if (seen.has(mapping.internal_node_id)) {
      continue;
    }
    plan.push({
      op: "archive_item",
      internal_node_id: mapping.internal_node_id,
      external_item_id: mapping.external_item_id
    });
  }

  return { plan, warnings };
}

export async function applyProjection(params: ApplyParams): Promise<{
  applied: SinkOperation[];
  mapping_deltas: Array<{
    internal_node_id: string;
    external_item_id: string;
    last_pushed_at: string;
    last_known_external_hash: string | null;
  }>;
  warnings: string[];
}> {
  const actionable = params.plan.filter(
    (op) => op.op === "upsert_item" && op.bucket === "actionable"
  );
  const waiting = params.plan.filter((op) => op.op === "upsert_item" && op.bucket === "waiting");
  const archived = params.plan.filter((op) => op.op === "archive_item");

  const lines: string[] = [];
  lines.push(`# CaseGraph projection: ${params.case_id}`);
  lines.push("");
  lines.push(`<!-- casegraph sink=${SINK_NAME} -->`);
  lines.push("");
  lines.push("## Actionable");
  lines.push("");
  if (actionable.length === 0) {
    lines.push("_(no actionable items)_");
  } else {
    for (const op of actionable) {
      lines.push(renderChecklistItem(op, false));
    }
  }
  lines.push("");
  lines.push("## Waiting");
  lines.push("");
  if (waiting.length === 0) {
    lines.push("_(no waiting items)_");
  } else {
    for (const op of waiting) {
      lines.push(renderChecklistItem(op, false));
    }
  }
  lines.push("");

  const content = `${lines.join("\n")}\n`;
  const filePath = projectionFilePath(params.case_id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");

  const now = new Date().toISOString();
  const applied: SinkOperation[] = [];
  const mappingDeltas: Array<{
    internal_node_id: string;
    external_item_id: string;
    last_pushed_at: string;
    last_known_external_hash: string | null;
  }> = [];

  for (const op of [...actionable, ...waiting]) {
    applied.push(op);
    mappingDeltas.push({
      internal_node_id: op.internal_node_id,
      external_item_id: op.external_item_id ?? op.internal_node_id,
      last_pushed_at: now,
      last_known_external_hash: "unchecked"
    });
  }

  for (const op of archived) {
    applied.push(op);
  }

  return {
    applied,
    mapping_deltas: mappingDeltas,
    warnings: []
  };
}

export async function pullChanges(params: PullParams): Promise<{
  patch: Record<string, unknown> | null;
  mapping_deltas: Array<{
    internal_node_id: string;
    external_item_id: string;
    last_pulled_at: string;
    last_known_external_hash: string;
  }>;
  warnings: string[];
  item_count: number;
}> {
  const filePath = projectionFilePath(params.case_id);
  const warnings: string[] = [];
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Projection file ${filePath} not found; push before pull: ${toErrorMessage(error)}`
    );
  }

  const mappingByNodeId = new Map<string, Mapping>();
  for (const mapping of params.mapping) {
    mappingByNodeId.set(mapping.internal_node_id, mapping);
  }

  const operations: Array<Record<string, unknown>> = [];
  const mappingDeltas: Array<{
    internal_node_id: string;
    external_item_id: string;
    last_pulled_at: string;
    last_known_external_hash: string;
  }> = [];
  const now = new Date().toISOString();

  const lines = contents.split(/\r?\n/);
  let itemCount = 0;

  for (const line of lines) {
    const match = /^\s*-\s+\[([ xX])\]\s+(.*?)\s*<!--\s*node:\s*([^\s]+)\s*-->\s*$/.exec(line);
    if (!match) {
      continue;
    }
    itemCount += 1;

    const checked = (match[1] ?? " ") !== " ";
    const nodeId = match[3] as string;
    const mapping = mappingByNodeId.get(nodeId);
    if (!mapping) {
      warnings.push(`Line refers to unmapped node ${nodeId}; skipping`);
      continue;
    }

    const newHash = checked ? "checked" : "unchecked";
    if (mapping.last_known_external_hash !== newHash) {
      operations.push({
        op: "change_state",
        node_id: nodeId,
        state: checked ? "done" : "todo"
      });
    }

    mappingDeltas.push({
      internal_node_id: nodeId,
      external_item_id: mapping.external_item_id,
      last_pulled_at: now,
      last_known_external_hash: newHash
    });
  }

  if (operations.length === 0) {
    warnings.push("No checkbox state changes detected");
    return {
      patch: null,
      mapping_deltas: mappingDeltas,
      warnings,
      item_count: itemCount
    };
  }

  const patchId = `patch_sink_md_${createHash("sha1")
    .update(`${params.case_id}\0${params.base_revision}\0${contents}`)
    .digest("hex")
    .slice(0, 12)}`;

  const patch: Record<string, unknown> = {
    patch_id: patchId,
    spec_version: SPEC_VERSION,
    case_id: params.case_id,
    base_revision: params.base_revision,
    summary: `Sync state changes from markdown sink (${operations.length} ops)`,
    generator: {
      kind: "sync",
      name: "casegraph-sink-markdown",
      version: SINK_VERSION
    },
    operations,
    notes: [],
    risks: []
  };

  return {
    patch,
    mapping_deltas: mappingDeltas,
    warnings,
    item_count: itemCount
  };
}

function renderChecklistItem(op: SinkOperation, checked: boolean): string {
  const mark = checked ? "x" : " ";
  const title = op.title ?? op.internal_node_id;
  const labels = (op.labels ?? []).map((label) => `#${label}`);
  const suffix = labels.length > 0 ? ` ${labels.join(" ")}` : "";
  return `- [${mark}] ${title}${suffix} <!-- node: ${op.internal_node_id} -->`;
}

function projectionFilePath(caseId: string): string {
  return path.join(
    process.cwd(),
    ".casegraph",
    "cases",
    caseId,
    "projections",
    PROJECTION_FILENAME
  );
}

function assertPlanParams(input: unknown): PlanParams {
  if (
    !isRecord(input) ||
    typeof input.case_id !== "string" ||
    typeof input.base_revision !== "number" ||
    !Array.isArray(input.actionable) ||
    !Array.isArray(input.waiting) ||
    !Array.isArray(input.mapping)
  ) {
    throw new Error("Invalid sink.planProjection params");
  }
  return {
    case_id: input.case_id,
    base_revision: input.base_revision,
    actionable: (input.actionable as NodeSnapshot[]).map(cloneNode),
    waiting: (input.waiting as NodeSnapshot[]).map(cloneNode),
    mapping: (input.mapping as Mapping[]).map(cloneMapping)
  };
}

function assertApplyParams(input: unknown): ApplyParams {
  if (!isRecord(input) || typeof input.case_id !== "string" || !Array.isArray(input.plan)) {
    throw new Error("Invalid sink.applyProjection params");
  }
  return {
    case_id: input.case_id,
    plan: input.plan as SinkOperation[]
  };
}

function assertPullParams(input: unknown): PullParams {
  if (
    !isRecord(input) ||
    typeof input.case_id !== "string" ||
    typeof input.base_revision !== "number" ||
    !Array.isArray(input.mapping)
  ) {
    throw new Error("Invalid sink.pullChanges params");
  }
  return {
    case_id: input.case_id,
    base_revision: input.base_revision,
    mapping: (input.mapping as Mapping[]).map(cloneMapping)
  };
}

function cloneNode(node: NodeSnapshot): NodeSnapshot {
  return {
    node_id: node.node_id,
    kind: node.kind,
    state: node.state,
    title: node.title,
    labels: Array.isArray(node.labels) ? [...node.labels] : [],
    metadata: isRecord(node.metadata) ? { ...node.metadata } : {},
    created_at: node.created_at,
    updated_at: node.updated_at
  };
}

function cloneMapping(mapping: Mapping): Mapping {
  return {
    sink_name: mapping.sink_name,
    internal_node_id: mapping.internal_node_id,
    external_item_id: mapping.external_item_id,
    last_pushed_at: mapping.last_pushed_at ?? null,
    last_pulled_at: mapping.last_pulled_at ?? null,
    last_known_external_hash: mapping.last_known_external_hash ?? null
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
