#!/usr/bin/env node

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
    return;
  }
  console.warn(warning.stack ?? warning.message);
});

const { runCli } = await import("./app.js");
const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
