#!/usr/bin/env -S node --experimental-strip-types

import { readFile } from "node:fs/promises";
import path from "node:path";

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

const envPath = path.join(process.cwd(), "agent.env");
let config: {
  mode: "patch" | "prose" | "wrong_case" | "json_fence";
  case_id: string;
  node_id: string;
} = { mode: "patch", case_id: "demo", node_id: "task_x" };
try {
  const raw = await readFile(envPath, "utf8");
  config = { ...config, ...(JSON.parse(raw) as Partial<typeof config>) };
} catch {
  // use defaults if no env file
}

const caseIdInPatch = config.mode === "wrong_case" ? `${config.case_id}-wrong` : config.case_id;

const patch = {
  patch_id: "patch_fake_agent",
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

process.stdout.write(`# Fake code agent received prompt (${prompt.length} chars)\n`);

if (config.mode === "prose") {
  process.stdout.write("I thought about it but chose not to emit a patch.\n");
} else {
  const fence = config.mode === "json_fence" ? "json" : "casegraph-patch";
  process.stdout.write(`\`\`\`${fence}\n${JSON.stringify(patch, null, 2)}\n\`\`\`\n`);
}
