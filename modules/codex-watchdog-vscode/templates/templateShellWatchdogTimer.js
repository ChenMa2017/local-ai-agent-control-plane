"use strict";

const { shellQuote } = require("./templateShellUtils");

const shellWatchdogTimerTemplate = (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
ACTION="\${1:-status}"

ENV_CODEX_BIN="\${CODEX_BIN-}"
ENV_CODEX_HOME="\${CODEX_HOME-}"
ENV_CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE-}"
ENV_WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES-}"
ENV_WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES-}"
ENV_WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS-}"
ENV_WATCHDOG_ROLE="\${WATCHDOG_ROLE-}"
ENV_WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES-}"
ENV_WATCHDOG_INITIAL_DELAY_MINUTES="\${WATCHDOG_INITIAL_DELAY_MINUTES-}"
ENV_WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX-}"

if [ -f "$PROJECT_ROOT/agent/watchdog.env" ]; then
  set -a
  . "$PROJECT_ROOT/agent/watchdog.env"
  set +a
fi

[ -n "$ENV_CODEX_BIN" ] && CODEX_BIN="$ENV_CODEX_BIN"
[ -n "$ENV_CODEX_HOME" ] && CODEX_HOME="$ENV_CODEX_HOME"
[ -n "$ENV_CODEX_SANDBOX_MODE" ] && CODEX_SANDBOX_MODE="$ENV_CODEX_SANDBOX_MODE"
[ -n "$ENV_WATCHDOG_INTERVAL_MINUTES" ] && WATCHDOG_INTERVAL_MINUTES="$ENV_WATCHDOG_INTERVAL_MINUTES"
[ -n "$ENV_WATCHDOG_TIMEOUT_MINUTES" ] && WATCHDOG_TIMEOUT_MINUTES="$ENV_WATCHDOG_TIMEOUT_MINUTES"
[ -n "$ENV_WATCHDOG_COMPACT_EVERY_RUNS" ] && WATCHDOG_COMPACT_EVERY_RUNS="$ENV_WATCHDOG_COMPACT_EVERY_RUNS"
[ -n "$ENV_WATCHDOG_ROLE" ] && WATCHDOG_ROLE="$ENV_WATCHDOG_ROLE"
[ -n "$ENV_WATCHDOG_PHASE_OFFSET_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_PHASE_OFFSET_MINUTES"
[ -z "\${WATCHDOG_PHASE_OFFSET_MINUTES:-}" ] && [ -n "$ENV_WATCHDOG_INITIAL_DELAY_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_INITIAL_DELAY_MINUTES"
[ -n "$ENV_WATCHDOG_SERVICE_PREFIX" ] && WATCHDOG_SERVICE_PREFIX="$ENV_WATCHDOG_SERVICE_PREFIX"

WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX:-codex-watchdog}"
WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES:-30}"
WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES:-25}"
WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
WATCHDOG_ROLE="\${WATCHDOG_ROLE:-runner}"
WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
CODEX_BIN="\${CODEX_BIN:-codex}"
CODEX_HOME="\${CODEX_HOME:-$HOME/.codex-watcher}"
CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE:-read-only}"
UNIT_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

slugify() {
  local value="\${1:-project}"
  local slug
  slug="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  if [ -z "$slug" ]; then
    slug="project"
  fi
  printf '%s' "$slug"
}

project_hash() {
  if command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | sha1sum | awk '{print substr($1, 1, 8)}'
  else
    printf '%s' "$PROJECT_ROOT" | shasum | awk '{print substr($1, 1, 8)}'
  fi
}

systemd_value() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/%/%%/g; s/ /\\\\x20/g'
}

sanitize_minutes() {
  local name="$1"
  local value="$2"
  local min="$3"
  local fallback="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt "$min" ]; then
    echo "warning: ignoring invalid $name=$value; using $fallback" >&2
    printf '%s\\n' "$fallback"
    return
  fi
  printf '%s\\n' "$value"
}

workspace_write_allowed() {
  (
    cd "$PROJECT_ROOT"
    python3 - <<'PY'
import json
from pathlib import Path
p = Path("agent/workspace_write_policy.json")
if not p.exists():
    raise SystemExit(1)
try:
    data = json.loads(p.read_text())
except Exception:
    raise SystemExit(1)
if data.get("enabled") is not True:
    raise SystemExit(1)
writable = data.get("writable_paths")
commands = data.get("allowed_commands")
if not isinstance(writable, list) or not writable or not isinstance(commands, list) or not commands:
    raise SystemExit(1)
for item in writable:
    if not isinstance(item, str) or not item.strip() or item.startswith("/") or ".." in item.replace("\\\\", "/").split("/"):
        raise SystemExit(1)
for item in commands:
    if not isinstance(item, str) or not item.strip():
        raise SystemExit(1)
PY
  )
}

validate_service_prefix() {
  if [[ ! "$WATCHDOG_SERVICE_PREFIX" =~ ^[A-Za-z0-9_.@-]+$ ]] || [[ "$WATCHDOG_SERVICE_PREFIX" == *..* ]]; then
    echo "Invalid WATCHDOG_SERVICE_PREFIX: $WATCHDOG_SERVICE_PREFIX" >&2
    echo "Use only A-Z, a-z, 0-9, _, ., @, and -, without '..'." >&2
    exit 4
  fi
}

validate_unit_name() {
  local name="$1"
  if [[ "$name" == */* ]] || [[ "$name" == *\\\\* ]] || [[ "$name" == *..* ]] || ! [[ "$name" =~ ^[A-Za-z0-9_.@-]+\\.(service|timer)$ ]]; then
    echo "Unsafe generated systemd unit name: $name" >&2
    exit 4
  fi
}

timer_units() {
  local slug hash
  validate_service_prefix
  slug="$(slugify "$(basename "$PROJECT_ROOT")")"
  hash="$(project_hash)"
  SERVICE="\${WATCHDOG_SERVICE_PREFIX}-\${slug}-\${hash}.service"
  TIMER="\${WATCHDOG_SERVICE_PREFIX}-\${slug}-\${hash}.timer"
  validate_unit_name "$SERVICE"
  validate_unit_name "$TIMER"
}

write_units() {
  WATCHDOG_INTERVAL_MINUTES="$(sanitize_minutes WATCHDOG_INTERVAL_MINUTES "$WATCHDOG_INTERVAL_MINUTES" 5 30)"
  WATCHDOG_TIMEOUT_MINUTES="$(sanitize_minutes WATCHDOG_TIMEOUT_MINUTES "$WATCHDOG_TIMEOUT_MINUTES" 1 25)"
  WATCHDOG_COMPACT_EVERY_RUNS="$(sanitize_minutes WATCHDOG_COMPACT_EVERY_RUNS "$WATCHDOG_COMPACT_EVERY_RUNS" 0 6)"
  WATCHDOG_PHASE_OFFSET_MINUTES="$(sanitize_minutes WATCHDOG_PHASE_OFFSET_MINUTES "$WATCHDOG_PHASE_OFFSET_MINUTES" 0 10)"
  WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$(sanitize_minutes WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS "$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" 1 4)"
  case "$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" in 1|true|yes|on) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="1" ;; *) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="0" ;; esac
  case "$WATCHDOG_ROLE" in runner|supervisor) ;; *) WATCHDOG_ROLE="runner" ;; esac
  if [ "$CODEX_SANDBOX_MODE" = "workspace-write" ] && ! workspace_write_allowed; then
    echo "warning: workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only" >&2
    CODEX_SANDBOX_MODE="read-only"
  fi
  if [ "$CODEX_SANDBOX_MODE" != "read-only" ] && [ "$CODEX_SANDBOX_MODE" != "workspace-write" ]; then
    echo "warning: invalid CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE; using read-only" >&2
    CODEX_SANDBOX_MODE="read-only"
  fi
  timer_units
  mkdir -p "$UNIT_DIR" "$CODEX_HOME"

  cat > "$UNIT_DIR/$SERVICE" <<SERVICE_EOF
[Unit]
Description=Codex project watcher for $(basename "$PROJECT_ROOT")

[Service]
Type=oneshot
WorkingDirectory=$(systemd_value "$PROJECT_ROOT")
ExecStart=/usr/bin/env bash $(systemd_value "$PROJECT_ROOT/agent/bin/run_watchdog.sh")
Environment=CODEX_BIN=$(systemd_value "$CODEX_BIN")
Environment=CODEX_HOME=$(systemd_value "$CODEX_HOME")
Environment=CODEX_SANDBOX_MODE=$(systemd_value "$CODEX_SANDBOX_MODE")
Environment=WATCHDOG_TIMEOUT_MINUTES=$WATCHDOG_TIMEOUT_MINUTES
Environment=WATCHDOG_COMPACT_EVERY_RUNS=$WATCHDOG_COMPACT_EVERY_RUNS
Environment=WATCHDOG_ROLE=$(systemd_value "$WATCHDOG_ROLE")
Environment=WATCHDOG_PHASE_OFFSET_MINUTES=$WATCHDOG_PHASE_OFFSET_MINUTES
Environment=WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP
Environment=WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS
Environment=CUDA_VISIBLE_DEVICES=
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
TimeoutStartSec=\${WATCHDOG_TIMEOUT_MINUTES}min
SERVICE_EOF

  cat > "$UNIT_DIR/$TIMER" <<TIMER_EOF
[Unit]
Description=Run Codex project watcher every $WATCHDOG_INTERVAL_MINUTES minutes for $(basename "$PROJECT_ROOT")

[Timer]
OnActiveSec=\${WATCHDOG_PHASE_OFFSET_MINUTES}min
OnUnitActiveSec=\${WATCHDOG_INTERVAL_MINUTES}min
AccuracySec=1min
Unit=$SERVICE

[Install]
WantedBy=timers.target
TIMER_EOF
}

show_units() {
  timer_units
  echo "PROJECT_ROOT=$PROJECT_ROOT"
  echo "SERVICE=$SERVICE"
  echo "TIMER=$TIMER"
}

show_status() {
  timer_units
  show_units
  echo
  echo "active:  $(systemctl --user is-active "$TIMER" 2>/dev/null || true)"
  echo "enabled: $(systemctl --user is-enabled "$TIMER" 2>/dev/null || true)"
  echo
  systemctl --user list-timers "$TIMER" --no-pager 2>/dev/null || true
}

case "$ACTION" in
  install|start)
    write_units
    systemctl --user daemon-reload
    systemctl --user enable --now "$TIMER"
    show_status
    ;;
  stop)
    timer_units
    systemctl --user disable --now "$TIMER" || true
    show_status
    ;;
  status)
    show_status
    ;;
  units)
    show_units
    ;;
  *)
    echo "Usage: $0 {install|start|stop|status|units}" >&2
    exit 2
    ;;
esac
`;

module.exports = {
  shellWatchdogTimerTemplate
};
