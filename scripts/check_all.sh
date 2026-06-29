#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_check() {
  local label="$1"
  local script_path="$2"

  echo "== $label =="
  bash "$script_path"
  echo
}

run_check "runtime baseline" "$ROOT/scripts/ci/check_runtime_baseline.sh"
run_check "control-plane safety tools" "$ROOT/scripts/ci/check_control_plane.sh"
run_check "codex-bridge" "$ROOT/scripts/ci/check_codex_bridge.sh"
run_check "agent-host" "$ROOT/scripts/ci/check_agent_host.sh"
run_check "discord-adapter py_compile" "$ROOT/scripts/ci/check_discord_adapter_py_compile.sh"
run_check "discord-adapter unittest" "$ROOT/scripts/ci/run_discord_adapter_unittests.sh"
run_check "host-ops" "$ROOT/scripts/ci/check_host_ops.sh"
run_check "codex-watchdog-vscode" "$ROOT/scripts/ci/check_codex_watchdog_vscode.sh"

echo "All checks passed."
