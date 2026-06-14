"use strict";

const { shellQuote } = require("./templateShellUtils");

const shellCollectStatusTemplate = (root) => `#!/usr/bin/env bash
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
`;

module.exports = {
  shellCollectStatusTemplate
};
