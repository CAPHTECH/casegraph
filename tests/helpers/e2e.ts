import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface E2eCommandResult<TJson = unknown> {
  code: number;
  stdout: string;
  stderr: string;
  json: TJson | null;
}

export async function createEmptyWorkspaceDir(prefix = "casegraph-e2e-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempDir(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function runCgJson<TJson = unknown>(
  workspaceRoot: string,
  args: string[]
): Promise<E2eCommandResult<TJson>> {
  const result = await runCg(workspaceRoot, ["--format", "json", ...args]);
  const payload = result.stdout.trim() || result.stderr.trim();

  if (payload.length === 0) {
    return { ...result, json: null };
  }

  try {
    return { ...result, json: JSON.parse(payload) as TJson };
  } catch (error) {
    throw new Error(
      [
        `failed to parse JSON output for: ${["pnpm", "--silent", "run", "cg", ...args].join(" ")}`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
        `cause: ${String(error)}`
      ].join("\n")
    );
  }
}

export async function runCgText(
  workspaceRoot: string,
  args: string[]
): Promise<E2eCommandResult<null>> {
  const result = await runCg(workspaceRoot, args);
  return { ...result, json: null };
}

async function runCg(
  workspaceRoot: string,
  args: string[]
): Promise<Omit<E2eCommandResult<never>, "json">> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "run", "cg", "--workspace", workspaceRoot, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      });
    });
  });
}
