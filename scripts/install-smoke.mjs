#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const PACKAGES = [
  "@caphtech/casegraph-kernel",
  "@caphtech/casegraph-core",
  "@caphtech/casegraph-importer-markdown",
  "@caphtech/casegraph-sink-markdown",
  "@caphtech/casegraph-worker-shell",
  "@caphtech/casegraph-worker-code-agent",
  "@caphtech/casegraph-worker-local-llm",
  "@caphtech/casegraph-cli"
];

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const keepArtifacts = process.argv.includes("--keep");

async function main() {
  const tarballDir = await mkdtemp(path.join(tmpdir(), "cg-smoke-tgz-"));
  const installDir = await mkdtemp(path.join(tmpdir(), "cg-smoke-install-"));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "cg-smoke-ws-"));

  let failed = false;
  try {
    log(`Packing ${PACKAGES.length} packages -> ${tarballDir}`);
    for (const name of PACKAGES) {
      await run("pnpm", ["--filter", name, "pack", "--pack-destination", tarballDir], {
        cwd: repoRoot
      });
    }

    const tarballs = PACKAGES.map((name) => {
      const bare = name.replace("@", "").replace("/", "-");
      return path.join(tarballDir, `${bare}-*.tgz`);
    });

    log(`Installing tarballs into scratch project ${installDir}`);
    await writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "cg-smoke", private: true, version: "0.0.0" }, null, 2)}\n`
    );
    await runShell(`npm install --no-save ${tarballs.join(" ")}`, { cwd: installDir });

    const cgBin = path.join(installDir, "node_modules", ".bin", "cg");
    log(`Running smoke scenarios against ${cgBin}`);

    await cg(cgBin, workspaceDir, ["init", "--title", "smoke"]);
    await cg(cgBin, workspaceDir, ["case", "new", "--id", "c", "--title", "C"]);
    await cg(cgBin, workspaceDir, [
      "node",
      "add",
      "--case",
      "c",
      "--id",
      "task_a",
      "--kind",
      "task",
      "--title",
      "Task"
    ]);

    // sink-markdown plugin surface
    await cg(cgBin, workspaceDir, ["sync", "push", "--sink", "markdown", "--case", "c", "--apply"]);

    // importer-markdown plugin surface (an invalid patch is an acceptable signal — the plugin
    // process spawned and responded; the bug we guard against here crashes before that point).
    const importFixture = path.join(workspaceDir, "import.md");
    await writeFile(
      importFixture,
      ["# case", "", "- [ ] task_a <!-- node: task_a -->", ""].join("\n")
    );
    await cg(
      cgBin,
      workspaceDir,
      ["import", "markdown", "--case", "c", "--file", importFixture],
      { allowNonZero: true, requireErrorMatches: null }
    );

    log("Install smoke OK");
  } catch (error) {
    failed = true;
    log(`Install smoke FAILED: ${String(error?.message ?? error)}`);
  } finally {
    if (!keepArtifacts) {
      await rm(tarballDir, { recursive: true, force: true });
      await rm(installDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    } else {
      log(`Kept artifacts: tarballs=${tarballDir} install=${installDir} workspace=${workspaceDir}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

async function cg(cgBin, workspaceDir, args, options = {}) {
  const finalArgs = ["--workspace", workspaceDir, ...args];
  const code = await run(cgBin, finalArgs, { cwd: workspaceDir, capture: true });
  if (code === 0) return;
  if (options.allowNonZero) {
    log(`(non-zero exit ${code} allowed for: cg ${args.join(" ")})`);
    return;
  }
  throw new Error(`cg ${args.join(" ")} exited ${code}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: process.env
    });
    const out = [];
    const err = [];
    if (options.capture) {
      child.stdout?.on("data", (chunk) => out.push(String(chunk)));
      child.stderr?.on("data", (chunk) => err.push(String(chunk)));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && options.capture) {
        process.stderr.write(out.join(""));
        process.stderr.write(err.join(""));
      }
      resolve(code ?? 1);
    });
  });
}

function runShell(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd ?? process.cwd(),
      stdio: "inherit",
      shell: true,
      env: process.env
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}`));
      else resolve();
    });
  });
}

function log(message) {
  process.stdout.write(`[install-smoke] ${message}\n`);
}

main().catch((error) => {
  log(`Fatal: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
