#!/usr/bin/env -S node --experimental-strip-types

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import readline from "node:readline";

const SPEC_VERSION = "0.1-draft";

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
  await runServer();
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
        name: "casegraph-importer-markdown",
        version: "0.1.0"
      },
      operations,
      notes: [],
      risks: []
    },
    warnings
  };
}

async function runServer(): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });

  for await (const line of input) {
    if (line.trim().length === 0) {
      continue;
    }

    let request: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
    };

    try {
      request = JSON.parse(line) as {
        id?: number | string | null;
        method?: string;
        params?: unknown;
      };
    } catch (error) {
      writeError(null, -32700, "Parse error", error);
      continue;
    }

    if (typeof request.method !== "string") {
      writeError(request.id ?? null, -32600, "Invalid Request");
      continue;
    }

    try {
      switch (request.method) {
        case "initialize":
          writeResult(request.id ?? null, {
            name: "casegraph-importer-markdown",
            version: "0.1.0"
          });
          break;
        case "health":
          writeResult(request.id ?? null, { ok: true });
          break;
        case "capabilities.list":
          writeResult(request.id ?? null, {
            methods: ["importer.ingest"],
            importer: {
              formats: ["markdown"],
              modes: ["append"]
            }
          });
          break;
        case "importer.ingest":
          writeResult(
            request.id ?? null,
            await parseMarkdownChecklistPatch(assertIngestParams(request.params))
          );
          break;
        case "shutdown":
          writeResult(request.id ?? null, { ok: true });
          input.close();
          process.exit(0);
          break;
        default:
          writeError(request.id ?? null, -32601, `Method ${request.method} not found`);
      }
    } catch (error) {
      writeError(request.id ?? null, -32000, toErrorMessage(error), error);
    }
  }
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
      isRecord(input.options) && input.options.mode === "append"
        ? { mode: "append" }
        : undefined
  };
}

function writeResult(id: number | string | null, result: unknown): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`
  );
}

function writeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, data }
    })}\n`
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
