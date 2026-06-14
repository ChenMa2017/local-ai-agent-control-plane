"use strict";

const { shellQuote } = require("./templateShellUtils");

const shellWatchdogCliTemplate = (root) => `#!/usr/bin/env bash
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
`;

module.exports = {
  shellWatchdogCliTemplate
};
