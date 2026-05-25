#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN="$(find "$HOME/.vscode-server/bin" -path '*/node' -type f -executable 2>/dev/null | head -1)"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "Could not find node. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
"$NODE_BIN" scripts/package-local.js
