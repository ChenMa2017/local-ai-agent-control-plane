"use strict";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const shellScriptTemplates = {
  collectStatus: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
cd "$PROJECT_ROOT"

mkdir -p agent/status
OUT="agent/status/current.md"

preview_file() {
  local file="$1"
  local missing="$2"
  local limit="\${WATCHDOG_PREVIEW_BYTES:-12000}"
  if [[ ! "$limit" =~ ^[0-9]+$ ]] || [ "$limit" -lt 1000 ]; then
    limit=12000
  fi
  if [ ! -f "$file" ]; then
    echo "$missing"
    return
  fi
  local bytes
  bytes="$(wc -c < "$file" | tr -d ' ')"
  echo "Path: $file"
  echo "Bytes: $bytes"
  echo "Preview bytes: $limit"
  echo '\`\`\`'
  head -c "$limit" "$file" || true
  if [ "$bytes" -gt "$limit" ]; then
    echo
    echo "[truncated: $((bytes - limit)) bytes omitted]"
  fi
  echo
  echo '\`\`\`'
}

count_files() {
  local dir="$1"
  if [ -d "$dir" ]; then
    find "$dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' '
  else
    printf '0\\n'
  fi
}

write_queue_status() {
  local out="agent/status/QUEUE_STATUS.md"
  mkdir -p agent/status
  {
    echo "# Queue Status"
    echo
    echo "Updated: $(date -Is)"
    echo
    echo "## Summary"
    echo
    echo "- agent/queue/queued: $(count_files agent/queue/queued)"
    echo "- agent/queue/running: $(count_files agent/queue/running)"
    echo "- agent/queue/done: $(count_files agent/queue/done)"
    echo "- agent/queue/failed: $(count_files agent/queue/failed)"
    echo "- gpu_queue: $(count_files gpu_queue)"
    echo "- gpu_running: $(count_files gpu_running)"
    echo "- gpu_done: $(count_files gpu_done)"
    echo "- gpu_failed: $(count_files gpu_failed)"
    echo "- cpu_queue: $(count_files cpu_queue)"
    echo "- cpu_running: $(count_files cpu_running)"
    echo "- cpu_done: $(count_files cpu_done)"
    echo "- cpu_failed: $(count_files cpu_failed)"
    echo
    echo "## Recent Queue Files"
    echo
    for dir in agent/queue/queued agent/queue/running agent/queue/done agent/queue/failed gpu_queue gpu_running gpu_done gpu_failed cpu_queue cpu_running cpu_done cpu_failed; do
      if [ -d "$dir" ]; then
        find "$dir" -maxdepth 1 -type f -printf "%T@ %p %s\\n" 2>/dev/null | sort -nr | head -5 | while read -r _ path size; do
          echo "- $path (\${size:-unknown} bytes)"
        done
      fi
    done
    echo
    echo "## Log Summary"
    echo
    echo "- Tail included: no"
  } > "$out"
}

write_queue_status

{
  echo "# Current Project Snapshot"
  echo
  echo "Generated at: $(date -Is)"
  echo "Host: $(hostname)"
  echo "User: $(whoami)"
  echo "Project root: $PROJECT_ROOT"
  echo

  echo "## Watchdog runtime controls"
  echo
  echo "- Run count: \${WATCHDOG_RUN_COUNT:-unknown}"
  echo "- Compact every runs: \${WATCHDOG_COMPACT_EVERY_RUNS:-6}"
  echo "- Compaction due this cycle: \${WATCHDOG_COMPACTION_DUE:-0}"
  echo "- Watchdog role: \${WATCHDOG_ROLE:-runner}"
  echo "- Phase offset minutes: \${WATCHDOG_PHASE_OFFSET_MINUTES:-10}"
  echo "- Supervisor mode: \${WATCHDOG_SUPERVISOR_MODE:-runner}"
  echo "- Runner completed count: \${WATCHDOG_RUNNER_COMPLETED_COUNT:-\${WATCHDOG_RUNNER_RUN_COUNT:-unknown}}"
  echo "- Runner started count: \${WATCHDOG_RUNNER_STARTED_COUNT:-unknown}"
  echo "- Runner failure drift: \${WATCHDOG_RUNNER_FAILURE_DRIFT:-unknown}"
  echo "- Supervisor audit every runner runs: \${WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS:-4}"
  echo "- Supervisor light follow-up: \${WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP:-1}"
  echo "- Raw log tails included: \${WATCHDOG_INCLUDE_LOG_TAILS:-0}"
  if [ -f agent/control/PAUSE ]; then
    echo "- Pause: active"
    echo "- Pause file: agent/control/PAUSE"
  else
    echo "- Pause: inactive"
  fi
  echo "- XDG_CACHE_HOME: \${XDG_CACHE_HOME:-unset}"
  echo

  echo "## Git"
  echo
  echo "HEAD:"
  git rev-parse HEAD 2>/dev/null || echo "Not a git repository"
  echo
  echo "Status:"
  git status --short 2>/dev/null || echo "Not a git repository"
  echo

  echo "## GPU snapshot"
  echo
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits || true
  else
    echo "nvidia-smi not found"
  fi
  echo

  echo "## Relevant processes"
  echo
  ps -eo pid,ppid,user,etime,pcpu,pmem,args \\
    | grep -E 'python|torchrun|accelerate|deepspeed|train|eval' \\
    | grep -v grep \\
    | head -80 || true
  echo

  echo "## Plan"
  echo
  cat agent/PLAN.md 2>/dev/null || true
  echo

  echo "## Safety"
  echo
  cat agent/SAFETY.md 2>/dev/null || true
  echo

  echo "## TODO"
  echo
  cat agent/TODO.md 2>/dev/null || true
  echo

  echo "## Daily handoff"
  echo
  cat agent/DAILY_HANDOFF.md 2>/dev/null || echo "No daily handoff yet."
  echo

  echo "## Previous state"
  echo
  cat agent/STATE.md 2>/dev/null || true
  echo

  echo "## Machine state"
  echo
  preview_file agent/STATE.json "No STATE.json yet."
  echo

  echo "## Progress state"
  echo
  preview_file agent/PROGRESS_STATE.json "No PROGRESS_STATE.json yet."
  echo

  echo "## Runtime state"
  echo
  cat agent/RUNTIME_STATE.md 2>/dev/null || echo "No runtime state yet."
  echo

  echo "## Cooperation protocol"
  echo
  preview_file agent/WATCHDOG_PROTOCOL.md "No watchdog cooperation protocol yet."
  echo

  echo "## Canonical current state"
  echo
  preview_file agent/CURRENT_STATE.md "No CURRENT_STATE.md yet."
  echo

  echo "## Canonical run state"
  echo
  preview_file agent/RUN_STATE.json "No RUN_STATE.json yet."
  echo

  echo "## Next action"
  echo
  preview_file agent/NEXT_ACTION.md "No NEXT_ACTION.md yet."
  echo

  echo "## Blockers"
  echo
  preview_file agent/BLOCKERS.md "No BLOCKERS.md yet."
  echo

  echo "## Review pending"
  echo
  preview_file agent/REVIEW_PENDING.md "No REVIEW_PENDING.md yet."
  echo

  echo "## Anti-snowball"
  echo
  preview_file agent/ANTI_SNOWBALL.md "No ANTI_SNOWBALL.md yet."
  echo

  echo "## Experiment ledger"
  echo
  preview_file agent/EXPERIMENT_LEDGER.md "No EXPERIMENT_LEDGER.md yet."
  echo

  echo "## Queue status"
  echo
  preview_file agent/status/QUEUE_STATUS.md "No queue status yet."
  echo

  echo "## Supervisor mode"
  echo
  preview_file agent/status/SUPERVISOR_MODE.json "No supervisor mode state yet."
  echo

  echo "## Research ledger"
  echo
  preview_file research/RESEARCH_LEDGER.md "No research ledger yet."
  echo

  echo "## Watchdog skill router"
  echo
  preview_file agent/SKILL_ROUTER.md "No skill router found."
  echo

  echo "## Deterministic skill route"
  echo
  preview_file agent/status/SKILL_ROUTE.json "No deterministic skill route found."
  echo

  echo "## Runtime validation"
  echo
  preview_file agent/status/RUNTIME_VALIDATION.json "No runtime validation report found."
  echo

  echo "## Previous proposed state"
  echo
  preview_file agent/STATE.proposed.md "No previous proposed state."
  echo

  echo "## Latest watchdog report"
  echo
  preview_file agent/reports/latest.md "No latest watchdog report yet."
  echo

  echo "## Previous morning brief"
  echo
  preview_file agent/MORNING_BRIEF.md "No previous morning brief yet."
  echo

  echo "## Recent experiment logs"
  echo

  log_roots=()
  for dir in runs logs outputs; do
    if [ -d "$dir" ]; then
      log_roots+=("$dir")
    fi
  done

  if [ "\${#log_roots[@]}" -eq 0 ]; then
    echo "No runs/, logs/, or outputs/ directories found."
  else
    find "\${log_roots[@]}" -type f \\( -name "*.log" -o -name "*.txt" -o -name "*.json" -o -name "*.jsonl" \\) 2>/dev/null \\
      -printf "%T@ %p\\n" \\
      | sort -nr \\
      | head -10 \\
      | while read -r _ path; do
          echo
          size="$(wc -c < "$path" 2>/dev/null | tr -d ' ' || echo unknown)"
          mtime="$(date -r "$path" -Is 2>/dev/null || echo unknown)"
          echo "### $path"
          echo
          echo "- Bytes: $size"
          echo "- Modified: $mtime"
          echo "- Tail included: \${WATCHDOG_INCLUDE_LOG_TAILS:-0}"
          if [ "\${WATCHDOG_INCLUDE_LOG_TAILS:-0}" = "1" ]; then
            echo
            echo '\`\`\`'
            tail -n 80 "$path" || true
            echo '\`\`\`'
          fi
        done || true
  fi
} > "$OUT"
`,

  makePrompt: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
cd "$PROJECT_ROOT"

cat agent/prompts/wakeup.md
echo
echo "---- BEGIN CURRENT SNAPSHOT ----"
cat agent/status/current.md
echo
echo "---- END CURRENT SNAPSHOT ----"
`,

  runWatchdog: (root) => `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${shellQuote(root)}
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

CODEX_BIN="\${CODEX_BIN:-codex}"
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

export PATH="\${WATCHDOG_LOCAL_BIN:-$HOME/.local/bin}:$PATH"
export CODEX_HOME
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

if [ "$CODEX_SANDBOX_MODE" = "workspace-write" ] && ! workspace_write_allowed; then
  echo "warning: workspace-write requested but agent/workspace_write_policy.json is missing or invalid; using read-only" >&2
  CODEX_SANDBOX_MODE="read-only"
fi
if [ "$CODEX_SANDBOX_MODE" != "read-only" ] && [ "$CODEX_SANDBOX_MODE" != "workspace-write" ]; then
  echo "warning: invalid CODEX_SANDBOX_MODE=$CODEX_SANDBOX_MODE; using read-only" >&2
  CODEX_SANDBOX_MODE="read-only"
fi
WATCHDOG_INTERVAL_MINUTES="$(sanitize_minutes WATCHDOG_INTERVAL_MINUTES "$WATCHDOG_INTERVAL_MINUTES" 5 30)"
WATCHDOG_TIMEOUT_MINUTES="$(sanitize_minutes WATCHDOG_TIMEOUT_MINUTES "$WATCHDOG_TIMEOUT_MINUTES" 1 25)"
WATCHDOG_COMPACT_EVERY_RUNS="$(sanitize_minutes WATCHDOG_COMPACT_EVERY_RUNS "$WATCHDOG_COMPACT_EVERY_RUNS" 0 6)"
WATCHDOG_PHASE_OFFSET_MINUTES="$(sanitize_minutes WATCHDOG_PHASE_OFFSET_MINUTES "$WATCHDOG_PHASE_OFFSET_MINUTES" 0 10)"
WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS="$(sanitize_minutes WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS "$WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS" 1 24)"
case "$WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP" in 1|true|yes|on) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="1" ;; *) WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP="0" ;; esac
case "$WATCHDOG_ROLE" in runner|supervisor) ;; *) WATCHDOG_ROLE="runner" ;; esac
export CODEX_BIN CODEX_HOME CODEX_SANDBOX_MODE WATCHDOG_INTERVAL_MINUTES WATCHDOG_TIMEOUT_MINUTES WATCHDOG_COMPACT_EVERY_RUNS WATCHDOG_ROLE WATCHDOG_PHASE_OFFSET_MINUTES WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS WATCHDOG_SERVICE_PREFIX

mkdir -p agent/reports agent/logs agent/status agent/pending/review_required "$CODEX_HOME"

LOCK_FILE="agent/.watchdog.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another watchdog run is active; exiting."
  exit 0
fi

RUN_COUNT_FILE="agent/status/run_count"
if [ -f "$RUN_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUN_COUNT_FILE"; then
  WATCHDOG_RUN_COUNT="$(cat "$RUN_COUNT_FILE")"
else
  WATCHDOG_RUN_COUNT="0"
fi
WATCHDOG_RUN_COUNT="$((WATCHDOG_RUN_COUNT + 1))"
printf '%s\\n' "$WATCHDOG_RUN_COUNT" > "$RUN_COUNT_FILE"
WATCHDOG_COMPACTION_DUE="0"
if [ "$WATCHDOG_COMPACT_EVERY_RUNS" -gt 0 ] && [ "$((WATCHDOG_RUN_COUNT % WATCHDOG_COMPACT_EVERY_RUNS))" -eq 0 ]; then
  WATCHDOG_COMPACTION_DUE="1"
fi

RUNNER_COUNT_FILE="agent/status/runner_run_count"
RUNNER_COMPLETED_COUNT_FILE="agent/status/runner_completed_count"
if [ "$WATCHDOG_ROLE" = "runner" ]; then
  if [ -f "$RUNNER_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUNNER_COUNT_FILE"; then
    WATCHDOG_RUNNER_RUN_COUNT="$(cat "$RUNNER_COUNT_FILE")"
  else
    WATCHDOG_RUNNER_RUN_COUNT="0"
  fi
  WATCHDOG_RUNNER_RUN_COUNT="$((WATCHDOG_RUNNER_RUN_COUNT + 1))"
  WATCHDOG_RUNNER_STARTED_COUNT="$WATCHDOG_RUNNER_RUN_COUNT"
  WATCHDOG_RUNNER_COMPLETED_COUNT=""
  WATCHDOG_RUNNER_FAILURE_DRIFT="0"
  printf '%s\\n' "$WATCHDOG_RUNNER_RUN_COUNT" > "$RUNNER_COUNT_FILE"
  WATCHDOG_SUPERVISOR_MODE="runner"
  SUPERVISOR_MODE_TMP="agent/status/SUPERVISOR_MODE.json.tmp"
  cat > "$SUPERVISOR_MODE_TMP" <<JSON
{
  "schema_version": 1,
  "updated_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "role": "runner",
  "mode": "runner",
  "runner_run_count": $WATCHDOG_RUNNER_RUN_COUNT,
  "reason": "runner wakeup increments the runner cycle counter"
}
JSON
  mv "$SUPERVISOR_MODE_TMP" agent/status/SUPERVISOR_MODE.json
else
  WATCHDOG_RUNNER_RUN_COUNT="0"
  WATCHDOG_RUNNER_COMPLETED_COUNT="0"
  WATCHDOG_RUNNER_STARTED_COUNT="0"
  if [ -f "$RUNNER_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUNNER_COUNT_FILE"; then
    WATCHDOG_RUNNER_STARTED_COUNT="$(cat "$RUNNER_COUNT_FILE")"
  fi
  if [ -f "$RUNNER_COMPLETED_COUNT_FILE" ] && grep -Eq '^[0-9]+$' "$RUNNER_COMPLETED_COUNT_FILE"; then
    WATCHDOG_RUNNER_COMPLETED_COUNT="$(cat "$RUNNER_COMPLETED_COUNT_FILE")"
  fi
  WATCHDOG_RUNNER_RUN_COUNT="$WATCHDOG_RUNNER_COMPLETED_COUNT"
  if [ "$WATCHDOG_RUNNER_STARTED_COUNT" -ge "$WATCHDOG_RUNNER_COMPLETED_COUNT" ]; then
    WATCHDOG_RUNNER_FAILURE_DRIFT="$((WATCHDOG_RUNNER_STARTED_COUNT - WATCHDOG_RUNNER_COMPLETED_COUNT))"
  else
    WATCHDOG_RUNNER_FAILURE_DRIFT="0"
  fi
  export WATCHDOG_RUNNER_RUN_COUNT WATCHDOG_RUNNER_COMPLETED_COUNT WATCHDOG_RUNNER_STARTED_COUNT WATCHDOG_RUNNER_FAILURE_DRIFT
  WATCHDOG_SUPERVISOR_MODE="$(python3 - <<'PY'
import json
import os
import hashlib
from datetime import datetime, timezone
from pathlib import Path

def int_env(name, fallback):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except Exception:
        return fallback
    return value if value >= 0 else fallback

def load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return {}

def text(path):
    try:
        return Path(path).read_text(errors="ignore")
    except Exception:
        return ""

TRUE_VALUES = {"1", "true", "yes", "on", "required"}
REVIEW_STATES = {"pending_send", "review_required_no_bundle"}
BLOCKER_TYPES = {"permission", "reviewer", "allowlist", "stale_state"}

def field_value(raw_text, key):
    key = key.lower()
    for line in raw_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("-"):
            stripped = stripped[1:].strip()
        if ":" not in stripped:
            continue
        left, right = stripped.split(":", 1)
        if left.strip().lower() == key:
            return right.strip().lower()
    return ""

def is_true(value):
    return str(value or "").strip().lower() in TRUE_VALUES

def normalize_marker_text(raw_text):
    lines = []
    for line in raw_text.splitlines():
        lowered = line.lower()
        if "updated:" in lowered or "timestamp" in lowered or "run id" in lowered or "run_id" in lowered:
            continue
        if lowered.strip().startswith("#"):
            continue
        lines.append(" ".join(lowered.split()))
    return "\\n".join(lines)

def atomic_write_json(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\\n")
    tmp.replace(target)

def append_event(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\\n")

runner_completed_count = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
runner_started_count = int_env("WATCHDOG_RUNNER_STARTED_COUNT", runner_completed_count)
runner_failure_drift = max(0, runner_started_count - runner_completed_count)
audit_every = max(1, int_env("WATCHDOG_SUPERVISOR_AUDIT_EVERY_RUNNER_RUNS", 4))
light_enabled = os.environ.get("WATCHDOG_SUPERVISOR_LIGHT_FOLLOWUP", "1") in {"1", "true", "yes", "on"}
state_path = Path("agent/status/supervisor_state.json")
state = load_json(state_path)
last_seen = int(state.get("last_seen_runner_completed_count") or state.get("last_seen_runner_run_count") or 0)
last_light = int(state.get("last_light_runner_completed_count") or 0)
last_audit = int(state.get("last_audit_runner_completed_count") or state.get("last_audit_runner_run_count") or 0)
run_state = load_json("agent/RUN_STATE.json")
review_text = text("agent/REVIEW_PENDING.md")
blockers_text = text("agent/BLOCKERS.md")
blocker = str(run_state.get("blocker_type") or "").lower()

review_state = field_value(review_text, "state")
review_requires = is_true(field_value(review_text, "requires_human_review"))
review_pending_send = is_true(field_value(review_text, "pending_send"))
review_marker = review_state in REVIEW_STATES or review_requires or review_pending_send
run_state_marker = blocker in {"permission", "reviewer", "stale_state"}
blocker_type = field_value(blockers_text, "blocker type")
blockers_required = is_true(field_value(blockers_text, "required"))
blockers_marker = blocker_type in BLOCKER_TYPES or blockers_required
marker_pending = review_marker or run_state_marker or blockers_marker
marker_basis = "\\n".join([blocker, normalize_marker_text(review_text)[:2000], normalize_marker_text(blockers_text)[:2000]])
marker_fingerprint = hashlib.sha256(marker_basis.encode("utf-8", errors="ignore")).hexdigest()[:16] if marker_pending else ""
last_actioned_marker_fingerprint = str(state.get("last_actioned_marker_fingerprint") or state.get("last_marker_fingerprint") or "")
marker_changed = marker_pending and marker_fingerprint != last_actioned_marker_fingerprint
new_runner_cycle = runner_completed_count > last_seen
audit_due = runner_completed_count > 0 and (runner_completed_count - last_audit) >= audit_every
drift_audit_due = runner_failure_drift >= 3

if drift_audit_due:
    mode = "audit"
    reason = f"runtime audit due: runner started/completed drift is {runner_failure_drift}"
elif audit_due:
    mode = "audit"
    reason = f"heavy audit due after {runner_completed_count - last_audit} completed runner cycle(s)"
elif light_enabled and (new_runner_cycle or marker_changed):
    mode = "light"
    if new_runner_cycle:
        reason = "light follow-up after a newly completed runner cycle"
    else:
        reason = "light follow-up for changed reviewer/blocker marker"
else:
    mode = "standby"
    if marker_pending:
        reason = "reviewer/blocker marker already seen; no new completed runner cycle and heavy audit cadence not due"
    else:
        reason = "no new completed runner cycle and heavy audit cadence not due"

updated_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
decision_id = f"sup_{updated_utc.replace('-', '').replace(':', '').replace('T', '_').replace('Z', '')}_{runner_completed_count}_{mode}"
payload = {
    "schema_version": 2,
    "updated_utc": updated_utc,
    "role": "supervisor",
    "mode": mode,
    "runner_run_count": runner_completed_count,
    "runner_completed_count": runner_completed_count,
    "runner_started_count": runner_started_count,
    "runner_failure_drift": runner_failure_drift,
    "last_seen_runner_run_count": last_seen,
    "last_seen_runner_completed_count": last_seen,
    "last_light_runner_completed_count": last_light,
    "last_audit_runner_run_count": last_audit,
    "last_audit_runner_completed_count": last_audit,
    "audit_every_runner_runs": audit_every,
    "light_followup_enabled": light_enabled,
    "marker_pending": marker_pending,
    "marker_sources": {
        "REVIEW_PENDING.md": review_marker,
        "BLOCKERS.md": blockers_marker,
        "RUN_STATE.blocker_type": blocker if run_state_marker else "",
    },
    "marker_fingerprint": marker_fingerprint,
    "last_marker_fingerprint": last_actioned_marker_fingerprint,
    "last_actioned_marker_fingerprint": last_actioned_marker_fingerprint,
    "decision": {
        "decision_id": decision_id,
        "mode": mode,
        "status": "selected",
        "selected_at": updated_utc,
        "target_runner_completed_count": runner_completed_count,
        "reason": reason,
    },
    "reason": reason,
}
atomic_write_json(state_path, payload)
atomic_write_json("agent/status/SUPERVISOR_MODE.json", payload)
append_event("agent/status/SUPERVISOR_MODE.events.jsonl", {
    "event": "selected",
    "decision_id": decision_id,
    "timestamp": updated_utc,
    "mode": mode,
    "reason": reason,
    "runner_started_count": runner_started_count,
    "runner_completed_count": runner_completed_count,
    "runner_failure_drift": runner_failure_drift,
    "marker_pending": marker_pending,
    "marker_fingerprint": marker_fingerprint,
})
print(mode)
PY
)"
fi
export WATCHDOG_RUN_COUNT WATCHDOG_COMPACTION_DUE WATCHDOG_RUNNER_RUN_COUNT WATCHDOG_RUNNER_COMPLETED_COUNT WATCHDOG_RUNNER_STARTED_COUNT WATCHDOG_RUNNER_FAILURE_DRIFT WATCHDOG_SUPERVISOR_MODE

TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
JSON_OUT="agent/reports/\${TS}.json"
MD_OUT="agent/reports/\${TS}.md"
JSONL_OUT="agent/reports/\${TS}.events.jsonl"
STDERR_OUT="agent/reports/\${TS}.stderr.log"
RENDER_STDERR_OUT="agent/reports/\${TS}.render.stderr.log"
COLLECT_STDOUT_OUT="agent/reports/\${TS}.collect.stdout.log"
COLLECT_STDERR_OUT="agent/reports/\${TS}.collect.stderr.log"
PROMPT_OUT="agent/reports/\${TS}.prompt.md"
PROMPT_STDERR_OUT="agent/reports/\${TS}.prompt.stderr.log"
VALIDATE_STDOUT_OUT="agent/reports/\${TS}.validate.stdout.log"
VALIDATE_STDERR_OUT="agent/reports/\${TS}.validate.stderr.log"
ROUTE_STDOUT_OUT="agent/reports/\${TS}.route.stdout.log"
ROUTE_STDERR_OUT="agent/reports/\${TS}.route.stderr.log"

supervisor_reconciliation_changed() {
  python3 - <<'SUPRECONCILEPY'
import json
from pathlib import Path

path = Path("agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json")
try:
    payload = json.loads(path.read_text())
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if payload.get("changed") is True else 1)
SUPRECONCILEPY
}

write_supervisor_reconciliation_report() {
  TS="$TS" JSON_OUT="$JSON_OUT" MD_OUT="$MD_OUT" JSONL_OUT="$JSONL_OUT" python3 - <<'SUPRECONCILEREPORT'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

def read_json(path, fallback=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return fallback

def int_env(name, fallback):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except Exception:
        return fallback
    return value if value >= 0 else fallback

def atomic_write_json(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\\n")
    tmp.replace(target)

def append_jsonl(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\\n")

def utc_from_ts(ts):
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

ts = os.environ.get("TS", "")
updated = utc_from_ts(ts)
payload = read_json("agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json", {}) or {}
results = payload.get("results") if isinstance(payload.get("results"), list) else []
safety = payload.get("safety_boundary") if isinstance(payload.get("safety_boundary"), list) else []
json_out = Path(os.environ["JSON_OUT"])
md_out = Path(os.environ["MD_OUT"])
jsonl_out = Path(os.environ["JSONL_OUT"])

report = {
    "timestamp_utc": updated,
    "kind": "supervisor_stale_state_reconciliation",
    "overall_status": "completed" if payload.get("changed") is True else "uncertain",
    "primary_skill": "watchdog-handoff-writer",
    "work_cycle_summary": "Deterministic supervisor stale-state reconciliation completed before Codex reasoning.",
    "reconciliation": payload,
}
json_out.write_text(json.dumps(report, indent=2) + "\\n")

lines = [
    "# Supervisor Stale-State Reconciliation",
    "",
    f"Timestamp: {updated}",
    "",
    "Deterministic reconciliation helper reported changed=true; Codex reasoning was not launched for this wakeup.",
    "",
    "## Results",
    "",
]
if results:
    for item in results:
        if isinstance(item, dict):
            stage = item.get("stage") or item.get("target") or "unknown"
            changed = item.get("changed")
            note = item.get("status_note") or item.get("note") or ""
            lines.append(f"- {stage}: changed={changed}; note={note}")
else:
    lines.append("- changed=true")
lines.extend(["", "## Safety Boundary", ""])
if safety:
    lines.extend(f"- {item}" for item in safety)
else:
    lines.extend([
        "- No code edits approved.",
        "- No CPU/GPU execution approved.",
        "- No queue/training approved.",
        "- No dataset/checkpoint mutation approved.",
        "- No external send approved.",
        "- No model promotion claim approved.",
    ])
lines.extend(["", "## Source", "", "- agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json", ""])
md_out.write_text("\\n".join(lines))

append_jsonl(jsonl_out, {
    "event": "supervisor_stale_state_reconciliation",
    "timestamp": updated,
    "changed": payload.get("changed") is True,
})

state_path = Path("agent/status/supervisor_state.json")
state = read_json(state_path, {}) or {}
decision = dict(state.get("decision") or {})
mode = decision.get("mode") or state.get("mode") or os.environ.get("WATCHDOG_SUPERVISOR_MODE", "standby")
target_count = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
try:
    target_count = int(decision.get("target_runner_completed_count", target_count))
except Exception:
    pass
decision["mode"] = mode
decision["target_runner_completed_count"] = target_count
decision["status"] = "completed"
decision["completed_at"] = updated
decision["completion_reason"] = "supervisor_stale_state_reconciliation"
state["schema_version"] = 2
state["updated_utc"] = updated
state["role"] = "supervisor"
state["mode"] = mode
state["runner_completed_count"] = int_env("WATCHDOG_RUNNER_COMPLETED_COUNT", int_env("WATCHDOG_RUNNER_RUN_COUNT", 0))
state["runner_started_count"] = int_env("WATCHDOG_RUNNER_STARTED_COUNT", state["runner_completed_count"])
state["runner_failure_drift"] = int_env("WATCHDOG_RUNNER_FAILURE_DRIFT", max(0, state["runner_started_count"] - state["runner_completed_count"]))
state["last_seen_runner_completed_count"] = max(int(state.get("last_seen_runner_completed_count") or state.get("last_seen_runner_run_count") or 0), target_count)
state["last_seen_runner_run_count"] = state["last_seen_runner_completed_count"]
if mode == "light":
    state["last_light_runner_completed_count"] = max(int(state.get("last_light_runner_completed_count") or 0), target_count)
if mode == "audit":
    state["last_audit_runner_completed_count"] = max(int(state.get("last_audit_runner_completed_count") or state.get("last_audit_runner_run_count") or 0), target_count)
    state["last_audit_runner_run_count"] = state["last_audit_runner_completed_count"]
if mode in {"light", "audit"} and state.get("marker_pending") and state.get("marker_fingerprint"):
    state["last_actioned_marker_fingerprint"] = state.get("marker_fingerprint", "")
    state["last_marker_fingerprint"] = state.get("marker_fingerprint", "")
state["decision"] = decision
atomic_write_json(state_path, state)
atomic_write_json("agent/status/SUPERVISOR_MODE.json", state)
append_jsonl("agent/status/SUPERVISOR_MODE.events.jsonl", {
    "event": "completed",
    "decision_id": decision.get("decision_id", ""),
    "timestamp": updated,
    "mode": mode,
    "runner_completed_count": target_count,
    "completion_reason": "supervisor_stale_state_reconciliation",
})
SUPRECONCILEREPORT
}

if [ -f agent/control/PAUSE ]; then
  {
    echo "# Codex Watchdog Paused"
    echo
    echo "Timestamp: $TS"
    echo
    echo "The guard is paused because agent/control/PAUSE exists. No Codex reasoning cycle was started."
    echo
    echo "## Pause file"
    echo '\`\`\`'
    cat agent/control/PAUSE || true
    echo '\`\`\`'
    echo
    echo "To resume, remove agent/control/PAUSE or run:"
    echo
    echo '\`\`\`bash'
    echo "./agent/bin/watchdog resume"
    echo '\`\`\`'
  } > "$MD_OUT"
  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  echo "[$(date -Is)] watchdog is paused; report written to $MD_OUT"
  exit 0
fi

if [ "$WATCHDOG_ROLE" = "supervisor" ] && [ -f agent/bin/supervisor_reconcile_stale_state.py ]; then
  mkdir -p agent/status
  echo "[$(date -Is)] running supervisor stale-state reconciliation helper"
  cat > agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.json <<'JSON'
{
  "schema_version": 1,
  "kind": "supervisor_stale_state_reconciliation",
  "changed": false,
  "reset_before_helper": true
}
JSON
  if ! python3 agent/bin/supervisor_reconcile_stale_state.py > agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.stdout.log 2> agent/status/SUPERVISOR_STALE_STATE_RECONCILIATION.stderr.log; then
    echo "warning: supervisor stale-state reconciliation helper failed; continuing to normal watchdog route" >&2
  elif supervisor_reconciliation_changed; then
    write_supervisor_reconciliation_report
    ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
    echo "[$(date -Is)] supervisor reconciliation changed state; report written to $MD_OUT"
    exit 0
  fi
fi

echo "[$(date -Is)] routing watchdog skill"
if ! python3 agent/bin/route_skill.py > "$ROUTE_STDOUT_OUT" 2> "$ROUTE_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Skill Route Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "route_skill.py failed before Codex reasoning started."
    echo
    echo "## stdout"
    echo '\`\`\`'
    tail -n 200 "$ROUTE_STDOUT_OUT" || true
    echo '\`\`\`'
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$ROUTE_STDERR_OUT" || true
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi

echo "[$(date -Is)] validating runtime"
if ! python3 agent/bin/validate_runtime.py > "$VALIDATE_STDOUT_OUT" 2> "$VALIDATE_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Runtime Validation Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "validate_runtime.py failed before Codex reasoning started."
    echo
    echo "## stdout"
    echo '\`\`\`'
    tail -n 200 "$VALIDATE_STDOUT_OUT" || true
    echo '\`\`\`'
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$VALIDATE_STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## Validation JSON"
    echo
    echo "See agent/status/RUNTIME_VALIDATION.json"
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi

echo "[$(date -Is)] collecting status"
if ! ./agent/bin/collect_status.sh > "$COLLECT_STDOUT_OUT" 2> "$COLLECT_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Collect Status Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "collect_status.sh failed before Codex reasoning started."
    echo
    echo "## stdout"
    echo '\`\`\`'
    tail -n 200 "$COLLECT_STDOUT_OUT" || true
    echo '\`\`\`'
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$COLLECT_STDERR_OUT" || true
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi

set +e
./agent/bin/make_prompt.sh > "$PROMPT_OUT" 2> "$PROMPT_STDERR_OUT"
PROMPT_STATUS="$?"
set -e

if [ "$PROMPT_STATUS" -ne 0 ]; then
  {
    echo "# Codex Watchdog Prompt Build Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "make_prompt.sh failed before Codex reasoning started."
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$PROMPT_STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## partial prompt preview"
    echo '\`\`\`markdown'
    head -c 4000 "$PROMPT_OUT" 2>/dev/null || true
    echo
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit "$PROMPT_STATUS"
fi

echo "[$(date -Is)] running Codex reasoning"

set +e
timeout "\${WATCHDOG_TIMEOUT_MINUTES}m" \\
  "$CODEX_BIN" --ask-for-approval never exec \\
    --cd "$PROJECT_ROOT" \\
    --skip-git-repo-check \\
    --sandbox "$CODEX_SANDBOX_MODE" \\
    --output-schema "agent/schemas/watch_decision.schema.json" \\
    --output-last-message "$JSON_OUT" \\
    --json \\
    - \\
  < "$PROMPT_OUT" \\
  > "$JSONL_OUT" \\
  2> "$STDERR_OUT"
CODEX_STATUS="$?"
set -e

if [ "$CODEX_STATUS" -ne 0 ]; then
  echo "[$(date -Is)] codex exec failed with status $CODEX_STATUS; building offline fallback report"
  export WATCHDOG_CODEX_STATUS="$CODEX_STATUS"
  export WATCHDOG_CODEX_FAILED_FALLBACK="1"
  if python3 agent/bin/build_fallback_report.py "$JSON_OUT" "$STDERR_OUT" \\
    && python3 agent/bin/render_report.py "$JSON_OUT" > "$MD_OUT" 2> "$RENDER_STDERR_OUT"; then
    ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
    echo "[$(date -Is)] fallback report written to $MD_OUT"
    exit 0
  fi

  {
    echo "# Codex Watchdog Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "Codex exited with status: $CODEX_STATUS, and fallback rendering also failed."
    echo
    echo "## stderr"
    echo '\`\`\`'
    tail -n 200 "$STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## fallback render stderr"
    echo '\`\`\`'
    tail -n 200 "$RENDER_STDERR_OUT" || true
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit "$CODEX_STATUS"
fi

export WATCHDOG_CODEX_STATUS="$CODEX_STATUS"
export WATCHDOG_CODEX_FAILED_FALLBACK="0"
if ! python3 agent/bin/render_report.py "$JSON_OUT" > "$MD_OUT" 2> "$RENDER_STDERR_OUT"; then
  {
    echo "# Codex Watchdog Render Failure"
    echo
    echo "Timestamp: $TS"
    echo
    echo "Codex finished, but render_report.py failed."
    echo
    echo "## Render stderr"
    echo '\`\`\`'
    tail -n 200 "$RENDER_STDERR_OUT" || true
    echo '\`\`\`'
    echo
    echo "## JSON output path"
    echo
    echo "$JSON_OUT"
    echo
    echo "## JSON preview"
    echo '\`\`\`json'
    head -c 4000 "$JSON_OUT" 2>/dev/null || true
    echo
    echo '\`\`\`'
  } > "$MD_OUT"

  ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md
  exit 1
fi
ln -sfn "$(basename "$MD_OUT")" agent/reports/latest.md

echo "[$(date -Is)] report written to $MD_OUT"
`,

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
`,
};
module.exports = {
  shellScriptTemplates
};
