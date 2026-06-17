#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== control-plane safety tools =="
(cd "$ROOT" && python3 -m py_compile scripts/control_plane.py tests/test_control_plane.py && python3 -m unittest tests/test_control_plane.py)

echo
echo "== codex-bridge =="
(cd "$ROOT/modules/codex-bridge" && node --check scripts/codex-bridge.js && npm test)

echo
echo "== agent-host =="
(cd "$ROOT/modules/agent-host" && python3 -m py_compile bridge.py post_run_artifacts.py tests/test_bridge.py && python3 -m unittest tests/test_bridge.py)

echo
echo "== discord-adapter =="
if [[ -x "$ROOT/modules/discord-adapter/.venv/bin/python" ]]; then
  PY="$ROOT/modules/discord-adapter/.venv/bin/python"
else
  PY="python3"
fi
(cd "$ROOT/modules/discord-adapter" && "$PY" -m py_compile bot.py agent_host_client.py tests/test_agent_host_client.py && "$PY" -m unittest discover -s tests)

echo
echo "== host-ops =="
(cd "$ROOT/modules/host-ops" && python3 -m py_compile host_ops.py tests/test_host_ops.py && python3 -m unittest discover -s tests)

echo
echo "== codex-watchdog-vscode =="
(cd "$ROOT/modules/codex-watchdog-vscode" && node --check extension.js && node tests/generated-template.test.js)

echo
echo "All checks passed."
