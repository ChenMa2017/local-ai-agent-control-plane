#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ROOT="$(ci_repo_root)"
PYTHON_BIN="$(discord_adapter_python_bin "$ROOT")"

cd "$ROOT/modules/discord-adapter"
"$PYTHON_BIN" -m py_compile \
  bot.py \
  agent_host_client.py \
  tests/test_agent_host_client.py \
  tests/test_agent_host_e2e.py
