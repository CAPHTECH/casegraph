#!/usr/bin/env -S node --experimental-strip-types

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAgentPrompt,
  buildRetryPrompt,
  extractPatchFromText,
  type PatchExtractionResult,
  type WorkerArtifact,
  type WorkerExecuteParams,
  type WorkerExecuteResult
} from "@caphtech/casegraph-kernel";
import { isRecord, runPluginStdioServer } from "@caphtech/casegraph-core/plugin-server";

const WORKER_NAME = "local-llm";
const WORKER_VERSION = "0.1.0";
const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.1:8b";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_RETRIES = 1;

const WORKER_CAPABILITIES = {
  effectful: false,
  needs_approval: false,
  shell_access: false,
  network_access: true,
  read_files: false,
  write_files: false
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPluginStdioServer({
    info: {
      name: `casegraph-worker-${WORKER_NAME}`,
      version: WORKER_VERSION,
      capabilities: WORKER_CAPABILITIES,
      methods: ["worker.execute"],
      extra: { worker: WORKER_CAPABILITIES }
    },
    handlers: {
      "worker.execute": (params) => execute(assertExecuteParams(params))
    }
  });
}

interface LlmAttempt {
  prompt: string;
  responseText: string;
  httpStatus: number | null;
  unreachableError: string | null;
  chunkCount: number;
  extraction: PatchExtractionResult;
}

interface CallOllamaOptions {
  host: string;
  model: string;
  prompt: string;
  timeoutSeconds: number;
  caseId: string;
  onChunk?: (chunk: string) => void | Promise<void>;
}

interface StreamResult {
  responseText: string;
  chunkCount: number;
  error: string | null;
}

async function readOllamaStream(
  body: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void | Promise<void>
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const state: StreamResult & { streamDone: boolean } = {
    responseText: "",
    chunkCount: 0,
    error: null,
    streamDone: false
  };
  let buffer = "";
  while (!state.streamDone) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const cut = buffer.lastIndexOf("\n");
    if (cut < 0) continue;
    const lines = buffer.slice(0, cut).split("\n");
    buffer = buffer.slice(cut + 1);
    for (const line of lines) {
      await applyStreamLine(line, state, onChunk);
    }
  }
  return { responseText: state.responseText, chunkCount: state.chunkCount, error: state.error };
}

async function applyStreamLine(
  line: string,
  state: StreamResult & { streamDone: boolean },
  onChunk?: (chunk: string) => void | Promise<void>
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const parsed = parseOllamaLine(trimmed);
  if (parsed.chunk !== null) {
    state.responseText += parsed.chunk;
    state.chunkCount += 1;
    if (onChunk) await onChunk(parsed.chunk);
  }
  if (parsed.error !== null) state.error = parsed.error;
  if (parsed.done) state.streamDone = true;
}

function parseOllamaLine(line: string): {
  chunk: string | null;
  done: boolean;
  error: string | null;
} {
  let obj: { response?: unknown; done?: unknown; error?: unknown };
  try {
    obj = JSON.parse(line) as typeof obj;
  } catch {
    return { chunk: null, done: false, error: null };
  }
  return {
    chunk: typeof obj.response === "string" && obj.response.length > 0 ? obj.response : null,
    done: obj.done === true,
    error: typeof obj.error === "string" && obj.error.length > 0 ? obj.error : null
  };
}

function attemptFooter(run: LlmAttempt): string {
  return [
    "",
    `http_status: ${run.httpStatus ?? ""}`,
    `unreachable: ${run.unreachableError ?? ""}`,
    `chunks: ${run.chunkCount}`,
    `extraction_ok: ${run.extraction.ok}`,
    ...(run.extraction.ok
      ? []
      : [`rejection: ${run.extraction.reason.code}: ${run.extraction.reason.message}`]),
    ""
  ].join("\n");
}

type AttemptDecision =
  | { kind: "stop"; observation: string | null }
  | {
      kind: "retry";
      observation: string;
      reason: NonNullable<Extract<PatchExtractionResult, { ok: false }>["reason"]>;
    };

function interpretAttempt(run: LlmAttempt, attempt: number): AttemptDecision {
  if (run.unreachableError || (run.httpStatus !== null && run.httpStatus >= 400)) {
    return { kind: "stop", observation: null };
  }
  if (run.extraction.ok) {
    return { kind: "stop", observation: null };
  }
  const reason = run.extraction.reason;
  if (attempt < MAX_RETRIES) {
    return {
      kind: "retry",
      observation: `Retry ${attempt + 1} after (${reason.code}): ${reason.message}`,
      reason
    };
  }
  return {
    kind: "stop",
    observation: `Patch rejected (${reason.code}): ${reason.message}`
  };
}

async function callOllama(options: CallOllamaOptions): Promise<LlmAttempt> {
  let responseText = "";
  let chunkCount = 0;
  let unreachableError: string | null = null;
  let httpStatus: number | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  try {
    const response = await fetch(`${options.host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: options.model, prompt: options.prompt, stream: true }),
      signal: controller.signal
    });
    httpStatus = response.status;
    if (!response.ok) {
      responseText = await response.text();
    } else if (response.body) {
      const streamed = await readOllamaStream(response.body, options.onChunk);
      responseText = streamed.responseText;
      chunkCount = streamed.chunkCount;
      unreachableError = streamed.error;
    }
  } catch (error) {
    unreachableError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  return {
    prompt: options.prompt,
    responseText,
    httpStatus,
    unreachableError,
    chunkCount,
    extraction: extractPatchFromText(responseText, options.caseId)
  };
}

export async function execute(params: WorkerExecuteParams): Promise<WorkerExecuteResult> {
  const host = process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const model = process.env.CASEGRAPH_LOCAL_LLM_MODEL ?? DEFAULT_MODEL;
  const originalPrompt = buildAgentPrompt(params);
  const timeoutSeconds =
    params.execution_policy.timeout_seconds > 0
      ? params.execution_policy.timeout_seconds
      : DEFAULT_TIMEOUT_SECONDS;

  const logPath = path.join(
    process.cwd(),
    ".casegraph",
    "cases",
    params.case.case_id,
    "worker-logs",
    `${params.execution_policy.command_id}.log`
  );
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(
    logPath,
    [
      "# casegraph-worker-local-llm log",
      `host: ${host}`,
      `model: ${model}`,
      `streaming: true`,
      ""
    ].join("\n"),
    "utf8"
  );

  const observations: string[] = [];
  const attempts: LlmAttempt[] = [];
  let currentPrompt = originalPrompt;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await appendFile(logPath, `\n## attempt ${attempt + 1}\n### response (streaming)\n`, "utf8");
    const run = await callOllama({
      host,
      model,
      prompt: currentPrompt,
      timeoutSeconds,
      caseId: params.case.case_id,
      onChunk: async (chunk) => {
        await appendFile(logPath, chunk, "utf8");
      }
    });
    await appendFile(logPath, attemptFooter(run), "utf8");
    attempts.push(run);
    const next = interpretAttempt(run, attempt);
    if (next.observation) observations.push(next.observation);
    if (next.kind === "stop") break;
    currentPrompt = buildRetryPrompt({
      originalPrompt,
      previousResponse: run.responseText,
      reason: next.reason
    });
  }

  const relativeLogPath = path.relative(process.cwd(), logPath);
  // biome-ignore lint/style/noNonNullAssertion: loop always runs at least once
  const final = attempts.at(-1)!;
  const artifact: WorkerArtifact = {
    kind: "log",
    path: relativeLogPath,
    description: "Local LLM response (streaming)",
    metadata: {
      host,
      model,
      attempts: attempts.length,
      chunks: attempts.reduce((sum, a) => sum + a.chunkCount, 0),
      http_status: final.httpStatus,
      unreachable: final.unreachableError !== null
    }
  };

  if (final.unreachableError) {
    return {
      status: "failed",
      summary: `Local LLM unreachable at ${host}`,
      artifacts: [artifact],
      observations: [final.unreachableError],
      warnings: []
    };
  }
  if (final.httpStatus !== null && final.httpStatus >= 400) {
    return {
      status: "failed",
      summary: `Local LLM returned HTTP ${final.httpStatus}`,
      artifacts: [artifact],
      observations: [final.responseText],
      warnings: []
    };
  }

  return {
    status: final.extraction.ok ? "succeeded" : "failed",
    summary: final.extraction.ok
      ? `Local LLM produced a GraphPatch for ${params.task.node_id}`
      : `Local LLM did not produce a GraphPatch for ${params.task.node_id}`,
    artifacts: [artifact],
    observations,
    ...(final.extraction.ok ? { patch: final.extraction.patch } : {}),
    warnings: []
  };
}

function assertExecuteParams(input: unknown): WorkerExecuteParams {
  if (
    !(
      isRecord(input) &&
      isRecord(input.case) &&
      isRecord(input.task) &&
      isRecord(input.context) &&
      isRecord(input.execution_policy) &&
      typeof input.case.case_id === "string" &&
      typeof input.task.node_id === "string" &&
      typeof input.execution_policy.command_id === "string"
    )
  ) {
    throw new Error("Invalid worker.execute params");
  }
  return input as unknown as WorkerExecuteParams;
}
