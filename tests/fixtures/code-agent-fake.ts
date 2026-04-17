#!/usr/bin/env -S node --experimental-strip-types

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

const envPath = path.join(process.cwd(), "agent.env");
let config: {
  mode: "patch" | "prose" | "wrong_case" | "json_fence" | "retry_then_patch";
  case_id: string;
  node_id: string;
} = { mode: "patch", case_id: "demo", node_id: "task_x" };
try {
  const raw = await readFile(envPath, "utf8");
  config = { ...config, ...(JSON.parse(raw) as Partial<typeof config>) };
} catch {
  // use defaults if no env file
}

const counterPath = path.join(process.cwd(), "agent.counter");
let invocation = 0;
try {
  const raw = await readFile(counterPath, "utf8");
  invocation = Number.parseInt(raw.trim(), 10);
} catch {
  invocation = 0;
}
invocation += 1;
await writeFile(counterPath, String(invocation), "utf8");

const effectiveMode: typeof config.mode =
  config.mode === "retry_then_patch" && invocation === 1 ? "prose" : config.mode;

const caseIdInPatch = effectiveMode === "wrong_case" ? `${config.case_id}-wrong` : config.case_id;

const patch = {
  patch_id: `patch_fake_agent_attempt_${invocation}`,
  spec_version: "0.1-draft",
  case_id: caseIdInPatch,
  base_revision: 0,
  summary: "fake agent marks task done",
  generator: { kind: "worker", name: "code-agent-fake" },
  operations: [
    {
      op: "change_state",
      node_id: config.node_id,
      state: "done"
    }
  ]
};

process.stdout.write(`# Fake code agent attempt=${invocation} prompt=${prompt.length} chars\n`);

if (effectiveMode === "prose") {
  process.stdout.write("I thought about it but chose not to emit a patch.\n");
} else {
  const fence = effectiveMode === "json_fence" ? "json" : "casegraph-patch";
  process.stdout.write(`\`\`\`${fence}\n${JSON.stringify(patch, null, 2)}\n\`\`\`\n`);
}
