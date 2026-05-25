#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
APP_ROOT="$REPO_ROOT"
SECRETS_FILE="${HOME}/.config/agent-host/secrets.env"

if [ -f "$SECRETS_FILE" ]; then
  if grep -Eq '^[[:space:]]*export[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=' "$SECRETS_FILE"; then
    echo "FAIL $SECRETS_FILE uses shell 'export KEY=value' syntax." >&2
    echo "systemd EnvironmentFile requires plain 'KEY=value' lines." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
fi

echo "== Agent Host config =="
python3 "$ROOT_DIR/bridge.py" --config "$ROOT_DIR/config.json" --check-config

echo
echo "== Agent Host health =="
python3 - <<'PY'
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=5) as response:
    data = json.loads(response.read().decode())
    print(data)
    if data.get("ok") is not True:
        raise SystemExit(1)
PY

if [ -n "${AGENT_HOST_TOKEN:-}" ]; then
  echo
  echo "== Agent Host capabilities/workspaces =="
  python3 - <<'PY'
import json
import os
import urllib.request

token = os.environ["AGENT_HOST_TOKEN"]
for path in ("/codex/capabilities", "/codex/workspaces"):
    request = urllib.request.Request(
        f"http://127.0.0.1:8787{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        data = json.loads(response.read().decode())
        print(path, "ok=", data.get("ok"))
        text = json.dumps(data, ensure_ascii=False)
        home = os.path.expanduser("~")
        if home in text:
            raise SystemExit(f"{path} leaked a home path")
PY
else
  echo
  echo "SKIP Agent Host authenticated checks: AGENT_HOST_TOKEN is not set."
fi

echo
echo "== Discord adapter config =="
if [ -x "$APP_ROOT/modules/discord-adapter/.venv/bin/python" ]; then
  "$APP_ROOT/modules/discord-adapter/.venv/bin/python" \
    "$APP_ROOT/modules/discord-adapter/bot.py" \
    --config "$APP_ROOT/modules/discord-adapter/config.json" \
    --check-config
else
  python3 "$APP_ROOT/modules/discord-adapter/bot.py" \
    --config "$APP_ROOT/modules/discord-adapter/config.json" \
    --check-config
fi

echo
echo "== Service status =="
systemctl --user is-active agent-host-web.service || true
systemctl --user is-active discord-agent-adapter.service || true

echo
echo "== Codex Bridge cleanup dry-run =="
cleanup_args=(cleanup --dry-run --older-than-days 30 --keep-last 200)
if [ -f "$APP_ROOT/modules/codex-bridge/.codex-bridge/web-adapter.config.json" ]; then
  cleanup_args+=(--config "$APP_ROOT/modules/codex-bridge/.codex-bridge/web-adapter.config.json")
fi
node "$APP_ROOT/modules/codex-bridge/scripts/codex-bridge.js" "${cleanup_args[@]}"
