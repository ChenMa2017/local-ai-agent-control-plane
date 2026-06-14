"use strict";

const { shellQuote } = require("./templateShellUtils");

const shellRunWatchdogTemplate = (root) => `#!/usr/bin/env bash
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
`;

module.exports = {
  shellRunWatchdogTemplate
};
