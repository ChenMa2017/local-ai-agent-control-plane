#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${BRIDGE_CONFIG:-$ROOT_DIR/config.json}"
PID_PATH="$ROOT_DIR/.bridge.pid"
LOG_DIR="$ROOT_DIR/logs"
LOG_PATH="$LOG_DIR/bridge.log"

DEFAULT_PROJECT_ROOT="/home/chenma/Documents/My_App_Dev/watchdog_demo_05_Grokking"

usage() {
  cat <<'EOF'
Usage:
  ./watchdog_bridge.sh init
  ./watchdog_bridge.sh start
  ./watchdog_bridge.sh foreground
  ./watchdog_bridge.sh stop
  ./watchdog_bridge.sh restart
  ./watchdog_bridge.sh status
  ./watchdog_bridge.sh logs
  ./watchdog_bridge.sh smoke

Optional env vars for init/start:
  MATTERMOST_TOKEN=...           Mattermost slash command token
  BRIDGE_HOST=127.0.0.1          Use 0.0.0.0 only if another machine must reach it
  BRIDGE_PORT=8787
  BRIDGE_ALLOWED_USER=chenma
  BRIDGE_PROJECT_NAME=grokking
  BRIDGE_PROJECT_ROOT=/path/to/watchdog/project
  CODEX_BRIDGE_ROOT=/home/chenma/Documents/My_App_Dev/codex-bridge
  CODEX_WEB_TOKEN=...        Browser/API bearer token for /codex/* and /whoami
  BRIDGE_CONFIG=/path/to/config.json

Examples:
  MATTERMOST_TOKEN=xxx ./watchdog_bridge.sh init
  ./watchdog_bridge.sh start
  ./watchdog_bridge.sh smoke
EOF
}

is_running() {
  if [ ! -f "$PID_PATH" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_PATH" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

write_config() {
  local token="${MATTERMOST_TOKEN:-replace-with-mattermost-slash-command-token}"
  local host="${BRIDGE_HOST:-127.0.0.1}"
  local port="${BRIDGE_PORT:-8787}"
  local user="${BRIDGE_ALLOWED_USER:-chenma}"
  local project_name="${BRIDGE_PROJECT_NAME:-grokking}"
  local project_root="${BRIDGE_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"
  local codex_bridge_root="${CODEX_BRIDGE_ROOT:-/home/chenma/Documents/My_App_Dev/codex-bridge}"
  local codex_web_token="${CODEX_WEB_TOKEN:-replace-with-codex-web-token}"

  python3 - "$CONFIG_PATH" "$token" "$host" "$port" "$user" "$project_name" "$project_root" "$codex_bridge_root" "$codex_web_token" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
token, host, port, user, project_name, project_root, codex_bridge_root, codex_web_token = sys.argv[2:]
data = {
    "host": host,
    "port": int(port),
    "mattermost_tokens": [token],
    "allowed_users": [user],
    "auth": {
        "tokens": {
            codex_web_token: {
                "user": user,
                "role": "admin",
            },
        },
    },
    "codex_bridge_root": codex_bridge_root,
    "codex_bridge_node_bin": "node",
    "projects": {
        project_name: project_root,
        "self": codex_bridge_root,
    },
}
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print(path)
PY
}

ensure_config() {
  if [ ! -f "$CONFIG_PATH" ]; then
    echo "Config not found; creating $CONFIG_PATH"
    write_config
  fi
}

check_config() {
  python3 "$ROOT_DIR/bridge.py" --config "$CONFIG_PATH" --check-config
}

warn_if_placeholder_token() {
  if grep -q "replace-with-mattermost-slash-command-token" "$CONFIG_PATH"; then
    cat >&2 <<EOF
WARNING: config still contains the placeholder Mattermost token.
Set MATTERMOST_TOKEN and run:
  MATTERMOST_TOKEN=xxx ./watchdog_bridge.sh init
or edit:
  $CONFIG_PATH
EOF
  fi
}

health_url() {
  python3 - "$CONFIG_PATH" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())
host = data.get("host", "127.0.0.1")
port = int(data.get("port", 8787))
client_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
print(f"http://{client_host}:{port}/health")
PY
}

post_url() {
  python3 - "$CONFIG_PATH" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())
host = data.get("host", "127.0.0.1")
port = int(data.get("port", 8787))
client_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
print(f"http://{client_host}:{port}/mattermost/watchdog")
PY
}

check_health() {
  local url
  url="$(health_url)"
  python3 - "$url" <<'PY'
import json
import sys
import urllib.request

url = sys.argv[1]
with urllib.request.urlopen(url, timeout=5) as resp:
    body = resp.read().decode()
    print(f"{resp.status} {body}")
    data = json.loads(body)
    if data.get("ok") is not True:
        raise SystemExit(1)
PY
}

start_bridge() {
  ensure_config
  check_config
  warn_if_placeholder_token

  if is_running; then
    echo "Bridge already running: pid $(cat "$PID_PATH")"
    echo "Health: $(health_url)"
    return 0
  fi

  mkdir -p "$LOG_DIR"
  nohup python3 "$ROOT_DIR/bridge.py" --config "$CONFIG_PATH" >"$LOG_PATH" 2>&1 &
  echo "$!" > "$PID_PATH"
  sleep 0.5

  if ! is_running; then
    echo "Bridge failed to start. Log:" >&2
    tail -n 80 "$LOG_PATH" >&2 || true
    return 1
  fi

  echo "Bridge started: pid $(cat "$PID_PATH")"
  echo "Health: $(health_url)"
  echo "Web UI: $(health_url | sed 's#/health$#/#')"
  echo "Mattermost Request URL: $(post_url)"
  echo "Log: $LOG_PATH"
  check_health
}

foreground_bridge() {
  ensure_config
  check_config
  warn_if_placeholder_token
  exec python3 "$ROOT_DIR/bridge.py" --config "$CONFIG_PATH"
}

stop_bridge() {
  if ! is_running; then
    rm -f "$PID_PATH"
    echo "Bridge is not running."
    return 0
  fi

  local pid
  pid="$(cat "$PID_PATH")"
  kill "$pid"
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_PATH"
      echo "Bridge stopped."
      return 0
    fi
    sleep 0.2
  done

  echo "Bridge did not exit promptly; pid $pid is still running." >&2
  return 1
}

status_bridge() {
  ensure_config
  check_config
  if is_running; then
    echo "Bridge: running"
    echo "PID: $(cat "$PID_PATH")"
    echo "Health: $(health_url)"
    echo "Web UI: $(health_url | sed 's#/health$#/#')"
    echo "Mattermost Request URL: $(post_url)"
    check_health || true
  else
    echo "Bridge: stopped"
  fi
}

smoke_test() {
  ensure_config
  local token user project url
  token="$(python3 - "$CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path
data=json.loads(Path(sys.argv[1]).read_text())
print((data.get("mattermost_tokens") or [""])[0])
PY
)"
  user="$(python3 - "$CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path
data=json.loads(Path(sys.argv[1]).read_text())
print((data.get("allowed_users") or ["chenma"])[0])
PY
)"
  project="$(python3 - "$CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path
data=json.loads(Path(sys.argv[1]).read_text())
projects=data.get("projects") or {}
print(next(iter(projects.keys())))
PY
)"
  url="$(post_url)"

  python3 - "$url" "$token" "$user" "$project" <<'PY'
import sys
import urllib.parse
import urllib.request

url, token, user, project = sys.argv[1:]
data = urllib.parse.urlencode({
    "token": token,
    "user_name": user,
    "user_id": "local-smoke-user",
    "channel_id": "local-smoke-channel",
    "channel_name": "local-smoke",
    "team_id": "local-smoke-team",
    "command": "/watchdog",
    "text": f"task {project} local smoke test: please acknowledge inbox delivery",
}).encode()
req = urllib.request.Request(
    url,
    data=data,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)
with urllib.request.urlopen(req, timeout=5) as resp:
    print(resp.status)
    print(resp.read().decode())
PY
}

cmd="${1:-help}"
case "$cmd" in
  init)
    write_config
    check_config
    warn_if_placeholder_token
    ;;
  start)
    start_bridge
    ;;
  foreground)
    foreground_bridge
    ;;
  stop)
    stop_bridge
    ;;
  restart)
    stop_bridge
    start_bridge
    ;;
  status)
    status_bridge
    ;;
  logs)
    mkdir -p "$LOG_DIR"
    touch "$LOG_PATH"
    tail -n 120 -f "$LOG_PATH"
    ;;
  smoke)
    smoke_test
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
