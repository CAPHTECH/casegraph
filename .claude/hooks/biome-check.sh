#!/usr/bin/env bash
set -u

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
payload="$(cat -)"

file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"
if [[ -z "$file_path" || ! -f "$file_path" ]]; then
  exit 0
fi

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc) ;;
  *) exit 0 ;;
esac

cd "$project_dir" || exit 0

output="$(pnpm --silent exec biome check --write --files-ignore-unknown=true "$file_path" 2>&1)"
status=$?

if [[ $status -eq 0 ]]; then
  exit 0
fi

# Biome exits non-zero when a path is excluded by biome.json `includes`.
# Treat "No files were processed" as success so intentionally-scoped paths
# (e.g. casegraph-plugin/, docs/) do not raise spurious hook errors.
if printf '%s' "$output" | grep -q "No files were processed"; then
  exit 0
fi

printf '%s\n' "$output" >&2
exit 2
