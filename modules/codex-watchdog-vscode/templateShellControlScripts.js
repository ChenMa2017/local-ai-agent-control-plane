"use strict";

const { shellQuote } = require("./templateShellUtils");

const shellControlScriptTemplates = {
  watchdogGuard: (root) => `#!/usr/bin/env bash
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
ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP-}"
ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS-}"
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
[ -n "$ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" ] && WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="$ENV_WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP"
[ -n "$ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" ] && WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$ENV_WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"
[ -z "\${WATCHDOG_PHASE_OFFSET_MINUTES:-}" ] && [ -n "$ENV_WATCHDOG_INITIAL_DELAY_MINUTES" ] && WATCHDOG_PHASE_OFFSET_MINUTES="$ENV_WATCHDOG_INITIAL_DELAY_MINUTES"
[ -n "$ENV_WATCHDOG_SERVICE_PREFIX" ] && WATCHDOG_SERVICE_PREFIX="$ENV_WATCHDOG_SERVICE_PREFIX"

CODEX_HOME="\${CODEX_HOME:-$HOME/.codex-watcher}"
CODEX_SANDBOX_MODE="\${CODEX_SANDBOX_MODE:-read-only}"
WATCHDOG_INTERVAL_MINUTES="\${WATCHDOG_INTERVAL_MINUTES:-30}"
WATCHDOG_TIMEOUT_MINUTES="\${WATCHDOG_TIMEOUT_MINUTES:-25}"
WATCHDOG_COMPACT_EVERY_RUNS="\${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
WATCHDOG_ROLE="\${WATCHDOG_ROLE:-runner}"
WATCHDOG_PHASE_OFFSET_MINUTES="\${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="\${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="\${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
WATCHDOG_SERVICE_PREFIX="\${WATCHDOG_SERVICE_PREFIX:-codex-watchdog}"

export CUDA_VISIBLE_DEVICES=""

cd "$PROJECT_ROOT"

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
}

resolve_codex_bin() {
  if [ -n "\${CODEX_BIN:-}" ]; then
    printf '%s\\n' "$CODEX_BIN"
    return
  fi

  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return
  fi

  local found
  found="$(ls -1 "$HOME"/.vscode-server/extensions/openai.chatgpt-*/bin/linux-*/codex 2>/dev/null | sort | tail -n 1 || true)"
  if [ -n "$found" ]; then
    printf '%s\\n' "$found"
    return
  fi

  printf '%s\\n' "codex"
}

CODEX_BIN="$(resolve_codex_bin)"
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
export CODEX_BIN CODEX_HOME CODEX_SANDBOX_MODE WATCHDOG_INTERVAL_MINUTES WATCHDOG_TIMEOUT_MINUTES WATCHDOG_COMPACT_EVERY_RUNS WATCHDOG_ROLE WATCHDOG_PHASE_OFFSET_MINUTES WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS WATCHDOG_SERVICE_PREFIX

print_header() {
  echo "Codex Watchdog Guard"
  echo "PROJECT_ROOT=$PROJECT_ROOT"
  echo "CODEX_BIN=$CODEX_BIN"
  echo "CODEX_HOME=$CODEX_HOME"
  echo "CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE"
  echo "WATCHDOG_COMPACT_EVERY_RUNS=$WATCHDOG_COMPACT_EVERY_RUNS"
  echo "WATCHDOG_ROLE=$WATCHDOG_ROLE"
  echo "WATCHDOG_PHASE_OFFSET_MINUTES=$WATCHDOG_PHASE_OFFSET_MINUTES"
  echo "WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP=$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP"
  echo "WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS=$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS"
  echo
}

check_layout() {
  local missing=0
  local file
  for file in \\
    "README.codex-watchdog.md" \\
    "agent/CODEX_TAKEOVER.md" \\
    "agent/PLAN.md" \\
    "agent/TODO.md" \\
    "agent/STATE.md" \\
	    "agent/SAFETY.md" \\
	    "agent/DAILY_HANDOFF.md" \\
	    "agent/watchdog.env" \\
	    "agent/bin/run_watchdog.sh" \\
    "agent/bin/watchdog_timer.sh"; do
    if [ ! -e "$file" ]; then
      echo "missing: $file"
      missing=1
    fi
  done
  return "$missing"
}

login_status() {
  mkdir -p "$CODEX_HOME"
  CODEX_HOME="$CODEX_HOME" "$CODEX_BIN" login status 2>&1 || true
}

login_ready() {
  login_status | grep -Eiq 'logged[[:space:]]+in|authenticated'
}

require_login() {
  echo "Checking Codex login status..."
  local status
  status="$(login_status)"
  echo "$status"
  echo

  if printf '%s\\n' "$status" | grep -Eiq 'logged[[:space:]]+in|authenticated'; then
    return 0
  fi

	  echo "Codex login is not ready for guard mode." >&2
	  echo "Run: ./agent/bin/watchdog login" >&2
	  echo "Then rerun: ./agent/bin/watchdog start" >&2
  return 3
}

latest_report() {
  echo
  if [ -e "agent/reports/latest.md" ]; then
    local latest
    latest="$(readlink -f agent/reports/latest.md 2>/dev/null || printf '%s' "agent/reports/latest.md")"
    echo "LATEST_REPORT=$latest"
    echo
    sed -n '1,40p' agent/reports/latest.md || true
  else
    echo "LATEST_REPORT=none"
  fi
}

pause_guard() {
  mkdir -p agent/control
  {
    echo "Paused at: $(date -Is)"
    echo "Reason: paused from project-local watchdog CLI"
  } > agent/control/PAUSE
  echo "PAUSED=agent/control/PAUSE"
}

resume_guard() {
  rm -f agent/control/PAUSE
  echo "RESUMED"
}

show_queue() {
  if [ -f agent/status/QUEUE_STATUS.md ]; then
    sed -n '1,160p' agent/status/QUEUE_STATUS.md || true
  else
    echo "No queue status yet. Run ./agent/bin/watchdog run-once or wait for the next timer cycle."
  fi
}

route_skill() {
  python3 agent/bin/route_skill.py
}

validate_generated_manifest() {
  python3 - <<'PY'
import hashlib
import json
import sys
from pathlib import Path

manifest_path = Path("agent/status/generated_manifest.json")
if not manifest_path.exists():
    print("generated manifest missing: agent/status/generated_manifest.json", file=sys.stderr)
    sys.exit(1)

try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"generated manifest invalid: {exc}", file=sys.stderr)
    sys.exit(1)

template_hashes = manifest.get("template_hashes")
if not isinstance(template_hashes, dict) or not template_hashes:
    print("generated manifest invalid: template_hashes must be a nonempty object", file=sys.stderr)
    sys.exit(1)

errors = []
for rel, expected in sorted(template_hashes.items()):
    if not isinstance(rel, str) or not isinstance(expected, str):
        errors.append(f"invalid manifest entry: {rel!r}")
        continue
    if not expected.startswith("sha256:"):
        errors.append(f"invalid hash format for {rel}")
        continue
    file_path = Path(rel)
    if file_path.is_absolute() or ".." in file_path.parts:
        errors.append(f"unsafe generated path in manifest: {rel}")
        continue
    if not file_path.exists():
        errors.append(f"generated file missing: {rel}")
        continue
    actual = "sha256:" + hashlib.sha256(file_path.read_bytes()).hexdigest()
    if actual != expected:
        errors.append(f"generated file drift: {rel}")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    print("Run: Codex Watchdog: Refresh Generated Watcher Files", file=sys.stderr)
    sys.exit(1)

version = manifest.get("control_plane_version", "unknown")
print(f"generated manifest ok: {len(template_hashes)} files, version={version}")
PY
}

validate_runtime() {
  python3 agent/bin/validate_runtime.py
  validate_generated_manifest
}

run_once() {
  print_header
  check_layout
  require_login
  ./agent/bin/run_watchdog.sh
  latest_report
}

start_guard() {
  print_header
  check_layout
  require_login
  echo "Running one immediate watchdog cycle before installing the timer..."
  ./agent/bin/run_watchdog.sh
  echo
  echo "Immediate cycle succeeded. Installing repeating timer..."
  ./agent/bin/watchdog_timer.sh install
  latest_report
}

status_guard() {
  print_header
  check_layout || true
  if [ -f agent/control/PAUSE ]; then
    echo "Control: paused"
    sed -n '1,20p' agent/control/PAUSE || true
  else
    echo "Control: live"
  fi
  echo
  echo "Login status:"
  login_status
  echo
  ./agent/bin/watchdog_timer.sh status
  echo
  show_queue
  latest_report
}

case "$ACTION" in
  start|takeover|stand-guard|guard)
    start_guard
    ;;
  run-once|once)
    run_once
    ;;
  check|status)
    status_guard
    ;;
  latest)
    latest_report
    ;;
  pause)
    pause_guard
    ;;
  resume)
    resume_guard
    ;;
  queue|show-queue)
    show_queue
    ;;
  route|show-route)
    route_skill
    ;;
  validate|doctor-runtime)
    validate_runtime
    ;;
  stop)
    ./agent/bin/watchdog_timer.sh stop
    ;;
  login)
    mkdir -p "$CODEX_HOME"
    CODEX_HOME="$CODEX_HOME" "$CODEX_BIN" login
    ;;
  *)
    echo "Usage: $0 {start|takeover|stand-guard|guard|run-once|check|status|latest|queue|route|validate|pause|resume|stop|login}" >&2
    exit 2
    ;;
esac
`,

  watchdogCli: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
ACTION="\${1:---help}"
shift || true

cd "$PROJECT_ROOT"

show_help() {
  cat <<'HELP_EOF'
Codex Watchdog project-local CLI

Usage:
  ./agent/bin/watchdog --help
  ./agent/bin/watchdog start
  ./agent/bin/watchdog status
  ./agent/bin/watchdog stop
  ./agent/bin/watchdog pause
  ./agent/bin/watchdog resume
  ./agent/bin/watchdog queue
  ./agent/bin/watchdog route
  ./agent/bin/watchdog validate
  ./agent/bin/watchdog run-once
  ./agent/bin/watchdog latest
	  ./agent/bin/watchdog login
  ./agent/bin/watchdog timer-install
  ./agent/bin/watchdog timer-status
  ./agent/bin/watchdog timer-units

Plain-language intent:
  If the user says "启动看护员", "接管 watchdog", "stand watch",
  "start the guard", or similar, run:

    ./agent/bin/watchdog start

What start does:
  1. Checks the project-local watchdog layout.
  2. Checks Codex login for CODEX_HOME, defaulting to ~/.codex-watcher.
  3. Runs one immediate wakeup.
  4. Starts the repeating systemd user timer only if the wakeup succeeds.
  5. Prints latest report and timer status.

Login rule:
  OpenAI login is the only manual authorization step. If login is missing,
  run "./agent/bin/watchdog login" and complete the browser/device login,
  then rerun "./agent/bin/watchdog start". Do not bypass login for normal use.

Important files:
  README.codex-watchdog.md       human/Codex overview
  agent/CODEX_TAKEOVER.md        instructions for daily Codex mode
  agent/SAFETY.md                hard safety rules and write allowlist
  agent/DAILY_HANDOFF.md         evening handoff
  agent/control/PAUSE            pause flag; if present, wakeups do not call Codex
  agent/status/SKILL_ROUTE.json  deterministic route chosen before Codex starts
  agent/status/QUEUE_STATUS.md   compact queue dashboard with no raw log tails
  agent/reports/latest.md        newest watchdog report
  agent/MORNING_BRIEF.md         morning handoff

Environment overrides:
  CODEX_BIN=/path/to/codex
  CODEX_HOME=$HOME/.codex-watcher
  CODEX_SANDBOX_MODE=read-only|workspace-write
  WATCHDOG_INTERVAL_MINUTES=30
  WATCHDOG_TIMEOUT_MINUTES=25
  WATCHDOG_COMPACT_EVERY_RUNS=6

Examples:
  ./agent/bin/watchdog status
  ./agent/bin/watchdog queue
  ./agent/bin/watchdog route
  ./agent/bin/watchdog validate
  ./agent/bin/watchdog login
  ./agent/bin/watchdog run-once
  ./agent/bin/watchdog pause
  ./agent/bin/watchdog resume
  CODEX_SANDBOX_MODE=workspace-write ./agent/bin/watchdog start
  ./agent/bin/watchdog stop

Safety:
  Default mode is read-only reasoning plus reports. workspace-write is forced
  back to read-only unless agent/workspace_write_policy.json exists, is valid,
  sets enabled=true, and lists exact relative writable paths and commands.
  Keep the same probe documented in agent/SAFETY.md for model guidance.
HELP_EOF
}

case "$ACTION" in
  -h|--help|help)
    show_help
    ;;
  start|takeover|guard|stand-guard)
    ./agent/bin/watchdog_guard.sh start "$@"
    ;;
  status|check|doctor)
    ./agent/bin/watchdog_guard.sh status "$@"
    ;;
  run-once|once)
    ./agent/bin/watchdog_guard.sh run-once "$@"
    ;;
  latest|report)
    ./agent/bin/watchdog_guard.sh latest "$@"
    ;;
  pause)
    ./agent/bin/watchdog_guard.sh pause "$@"
    ;;
  resume)
    ./agent/bin/watchdog_guard.sh resume "$@"
    ;;
  queue|show-queue)
    ./agent/bin/watchdog_guard.sh queue "$@"
    ;;
  route|show-route)
    ./agent/bin/watchdog_guard.sh route "$@"
    ;;
  validate|doctor-runtime)
    ./agent/bin/watchdog_guard.sh validate "$@"
    ;;
  stop)
    ./agent/bin/watchdog_guard.sh stop "$@"
    ;;
  login)
    ./agent/bin/watchdog_guard.sh login "$@"
    ;;
  timer-install|timer-start)
    ./agent/bin/watchdog_timer.sh install "$@"
    ;;
  timer-status)
    ./agent/bin/watchdog_timer.sh status "$@"
    ;;
  timer-stop)
    ./agent/bin/watchdog_timer.sh stop "$@"
    ;;
  timer-units|units)
    ./agent/bin/watchdog_timer.sh units "$@"
    ;;
  *)
    echo "Unknown watchdog command: $ACTION" >&2
    echo >&2
    show_help >&2
    exit 2
    ;;
esac
`,

  watchdogTimer: (root) => `#!/usr/bin/env bash
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
`
};

module.exports = {
  shellControlScriptTemplates
};
