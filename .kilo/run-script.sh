#!/bin/sh
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is not installed or not on PATH" >&2
  echo "Install: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# Prefer the invoking context: WORKTREE_PATH (Agent Manager) → CWD (manual) → script's own repo
DIR="${WORKTREE_PATH:-$PWD}"
TS="$DIR/.kilo/run-script.ts"

if [ ! -f "$TS" ]; then
  # Fallback to the main repo's copy
  TS="${REPO_PATH:-$(dirname "$(readlink -f "$0")")/..}/.kilo/run-script.ts"
fi

exec bun "$TS" "$@"