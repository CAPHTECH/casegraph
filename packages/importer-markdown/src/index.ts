#!/usr/bin/env -S node --experimental-strip-types

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SPEC_VERSION } from "@casegraph/core";
import { isRecord, runPluginStdioServer } from "@casegraph/core/plugin-server";

const IMPORTER_NAME = "casegraph-importer-markdown";
const IMPORTER_VERSION = "0.1.0";

interface ImporterIngestParams {
  case_id: string;
  base_revision: number;
  input: {
    kind: "file";
    path: string;
  };
  options?: {
    mode?: "append";
  };
}

interface ParsedChecklistResult {
  patch: Record<string, unknown>;
  warnings: string[];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPluginStdioServer({
    info: {
      name: IMPORTER_NAME,
      version: IMPORTER_VERSION,
      capabilities: {},
      methods: ["importer.ingest"],
      extra: {
        importer: {
          formats: ["markdown"],
          modes: ["append"]
        }
      }
    },
    handlers: {
      "importer.ingest": (params) => parseMarkdownChecklistPatch(assertIngestParams(params))
    }
  });
}

export async function parseMarkdownChecklistPatch(
  params: ImporterIngestParams
): Promise<ParsedChecklistResult> {
  if (params.input.kind !== "file") {
    throw new Error(`Unsupported input kind ${params.input.kind}`);
  }

  const contents = await readFile(params.input.path, "utf8");
  const warnings: string[] = [];
  const operations: Array<Record<string, unknown>> = [];
  const stack: Array<{ indent: number; nodeId: string }> = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const match = /^([ \t]*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const indent = normalizeIndent(match[1] ?? "");
    const checked = (match[2] ?? " ") !== " ";
    const payload = parseChecklistPayload((match[3] ?? "").trim());

    if (payload.title.length === 0) {
      warnings.push(`Skipped checklist line ${index + 1}: empty title`);
      continue;
    }

    const nodeId = createNodeId(payload.title, index + 1);
    operations.push({
      op: "add_node",
      node: {
        node_id: nodeId,
        kind: "task",
        title: payload.title,
        state: checked ? "done" : "todo",
        description: "",
        labels: payload.labels,
        acceptance: [],
        metadata: payload.metadata,
        extensions: {}
      }
    });

    while (stack.length > 0 && indent <= (stack.at(-1)?.indent ?? -1)) {
      stack.pop();
    }

    const parent = stack.at(-1);
    if (parent) {
      operations.push({
        op: "add_edge",
        edge: {
          edge_id: `edge_${parent.nodeId}_depends_on_${nodeId}`,
          type: "depends_on",
          source_id: parent.nodeId,
          target_id: nodeId,
          metadata: {},
          extensions: {}
        }
      });
    }

    stack.push({ indent, nodeId });
  }

  if (operations.length === 0) {
    warnings.push("No checklist items were imported");
  }

  const patchId = `patch_md_${createHash("sha1")
    .update(`${params.case_id}\0${params.base_revision}\0${contents}`)
    .digest("hex")
    .slice(0, 12)}`;

  return {
    patch: {
      patch_id: patchId,
      spec_version: SPEC_VERSION,
      case_id: params.case_id,
      base_revision: params.base_revision,
      summary: "Import markdown checklist items",
      generator: {
        kind: "planner",
        name: IMPORTER_NAME,
        version: IMPORTER_VERSION
      },
      operations,
      notes: [],
      risks: []
    },
    warnings
  };
}

function parseChecklistPayload(raw: string): {
  title: string;
  labels: string[];
  metadata: Record<string, string>;
} {
  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  const labels: string[] = [];
  const metadata: Record<string, string> = {};

  while (tokens.length > 0) {
    const last = tokens.at(-1) as string;
    if (/^#[A-Za-z0-9_-]+$/.test(last)) {
      labels.unshift(last.slice(1));
      tokens.pop();
      continue;
    }

    const metadataMatch = /^\[([A-Za-z0-9_]+):([^\]]+)\]$/.exec(last);
    if (metadataMatch) {
      metadata[metadataMatch[1] as string] = metadataMatch[2] as string;
      tokens.pop();
      continue;
    }

    break;
  }

  return {
    title: tokens.join(" ").trim(),
    labels,
    metadata
  };
}

function createNodeId(title: string, lineNumber: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `task_${slug.length > 0 ? slug : "item"}_l${lineNumber}`;
}

function normalizeIndent(raw: string): number {
  return raw.replace(/\t/g, "  ").length;
}

function assertIngestParams(input: unknown): ImporterIngestParams {
  if (
    !isRecord(input) ||
    typeof input.case_id !== "string" ||
    typeof input.base_revision !== "number" ||
    !isRecord(input.input) ||
    input.input.kind !== "file" ||
    typeof input.input.path !== "string"
  ) {
    throw new Error("Invalid importer.ingest params");
  }

  return {
    case_id: input.case_id,
    base_revision: input.base_revision,
    input: {
      kind: "file",
      path: input.input.path
    },
    options:
      isRecord(input.options) && input.options.mode === "append" ? { mode: "append" } : undefined
  };
}
