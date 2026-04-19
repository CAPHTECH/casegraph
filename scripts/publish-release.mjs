#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const RELEASE_PACKAGES = [
  "@caphtech/casegraph-kernel",
  "@caphtech/casegraph-core",
  "@caphtech/casegraph-importer-markdown",
  "@caphtech/casegraph-sink-markdown",
  "@caphtech/casegraph-worker-shell",
  "@caphtech/casegraph-worker-code-agent",
  "@caphtech/casegraph-worker-local-llm",
  "@caphtech/casegraph-cli"
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startIndex =
    options.from === undefined ? 0 : RELEASE_PACKAGES.findIndex((name) => name === options.from);
  if (startIndex === -1) {
    throw new Error(
      `Unknown package for --from: ${options.from}\nKnown packages:\n${RELEASE_PACKAGES.join("\n")}`
    );
  }

  const packages = RELEASE_PACKAGES.slice(startIndex);
  let otp = options.otp ?? process.env.NPM_CONFIG_OTP ?? process.env.npm_config_otp;
  if (!options.dryRun && !otp) {
    otp = await promptForOtp();
  }

  if (!options.dryRun && !otp) {
    throw new Error("OTP is required. Pass --otp <code> or set NPM_CONFIG_OTP.");
  }

  if (!options.skipSmoke) {
    console.log("\n==> Running pre-publish install smoke (pnpm test:install-smoke)");
    const smokeCode = await runCommand("pnpm", ["test:install-smoke"]);
    if (smokeCode !== 0) {
      throw new Error(
        "Install smoke failed. Fix the regression, or pass --skip-smoke to bypass (not recommended)."
      );
    }
  } else {
    console.log("\n==> Skipping install smoke (--skip-smoke)");
  }

  console.log(
    [
      `Release mode: ${options.dryRun ? "dry-run" : "publish"}`,
      `Packages: ${packages.join(", ")}`,
      options.tag ? `Tag: ${options.tag}` : null
    ]
      .filter(Boolean)
      .join("\n")
  );

  for (const packageName of packages) {
    const args = [
      "--filter",
      packageName,
      "publish",
      "--access",
      "public",
      "--no-git-checks"
    ];

    if (options.dryRun) {
      args.push("--dry-run");
    }

    if (options.tag) {
      args.push("--tag", options.tag);
    }

    if (otp) {
      args.push("--otp", otp);
    }

    console.log(`\n==> ${options.dryRun ? "Dry-run publish" : "Publishing"} ${packageName}`);

    const code = await runCommand("pnpm", args);
    if (code !== 0) {
      const resume = [
        "pnpm publish:release --",
        `--from ${packageName}`,
        options.tag ? `--tag ${options.tag}` : null,
        options.dryRun ? "--dry-run" : "--otp <new-otp>"
      ]
        .filter(Boolean)
        .join(" ");
      throw new Error(`Publish failed for ${packageName}. Resume with:\n${resume}`);
    }
  }

  console.log(`\nRelease ${options.dryRun ? "dry-run " : ""}completed.`);
}

function parseArgs(argv) {
  const options = {
    otp: undefined,
    dryRun: false,
    from: undefined,
    tag: undefined,
    skipSmoke: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--otp") {
      options.otp = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--otp=")) {
      options.otp = arg.slice("--otp=".length);
      continue;
    }

    if (arg === "--from") {
      options.from = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
      continue;
    }

    if (arg === "--tag") {
      options.tag = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
      continue;
    }

    if (arg === "--skip-smoke") {
      options.skipSmoke = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function promptForOtp() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const otp = await readline.question("npm OTP: ");
    return otp.trim() || undefined;
  } finally {
    readline.close();
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function printHelp() {
  console.log(`Usage: node scripts/publish-release.mjs [options]

Options:
  --otp <code>          npm one-time password for publish
  --dry-run             run pnpm publish --dry-run for every package
  --from <package>      resume from a specific package name
  --tag <tag>           npm dist-tag to publish under
  --skip-smoke          skip the pre-publish install smoke (not recommended)
  -h, --help            show this help

Examples:
  pnpm publish:release -- --otp 123456
  pnpm publish:release -- --from @caphtech/casegraph-worker-shell --otp 654321
  pnpm publish:release:dry-run
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
