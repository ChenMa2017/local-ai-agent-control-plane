"use strict";

const bootstrapGuideDocTemplates = {
  watchdogReadme: () => `# Codex Watchdog Project Guide

This folder has been selected as a Codex Watchdog project root.

Codex Watchdog is a scheduled handoff system. Daily Codex mode and the human operator prepare explicit project state under \`agent/\`. Watchdog mode wakes on a timer, runs \`codex exec\`, reads the handoff files and collected status, reasons about the next safe step, and writes reports back under \`agent/\`.

## What This Folder Contains

\`\`\`text
agent/
  TASK_REQUEST.md          natural-language task request for daily Codex
  WATCHDOG_PROTOCOL.md     runner/supervisor cooperation contract
  PLAN.md                  approved plan for unattended work
  TODO.md                  current task queue
  STATE.md                 human-approved durable state
  DAILY_HANDOFF.md         evening handoff from daily mode
  SAFETY.md                hard safety rules and allowed scope
  SECONDARY_SKILLS.example.json optional template for project-local support skills
  CURRENT_STATE.md         current canonical facts for the next actor
  RUN_STATE.json           machine-readable wakeup status
  NEXT_ACTION.md           one next safe action, not a history dump
  status/GATE_STATUS.json  operator-facing gate summary for blocked reasons and unblock steps
  status/GATE_STATUS.md    human-readable gate summary
  BLOCKERS.md              classified blockers and owner
  REVIEW_PENDING.md        reviewer bundle/send state
  ANTI_SNOWBALL.md         stopped routes and context compaction notes
  EXPERIMENT_LEDGER.md     concise hypothesis/model/loss/data/result ledger
  RUNTIME_STATE.md         compact memory refreshed by watchdog mode
  MORNING_BRIEF.md         summary for daily mode when the user returns
  STATE.proposed.md        candidate state update for human review
  watchdog.env             generated validated runtime configuration
  workspace_write_policy.example.json documentation for optional write probes
  SKILL_ROUTER.md          deterministic primary-skill routing contract
  skills/                  narrow watchdog skill manuals
  status/SKILL_ROUTE.json  deterministic primary skill plus optional secondary support skills
  status/RUNTIME_VALIDATION.json runtime validation report
  status/current.md        deterministic status snapshot
  reports/latest.md        symlink to the latest watchdog report
  pending/review_required/ decisions requiring human review
  bin/                     generated collector/runner scripts
\`\`\`

## How A Wakeup Works

1. \`agent/bin/route_skill.py\` writes or refreshes \`agent/status/SKILL_ROUTE.json\`, the deterministic primary skill for this wakeup plus any optional routed secondary support skills.
2. \`agent/bin/validate_runtime.py\` checks compact runtime JSON, route JSON, queue job JSON, gate JSON, and generated schemas before Codex starts.
3. \`agent/bin/collect_status.sh\` gathers deterministic facts: git status, GPU/process snapshot, handoff files, compact runtime state, bounded report previews, recent log paths/sizes, skill router, deterministic route, and runtime curation controls.
4. \`agent/bin/make_prompt.sh\` combines the wakeup prompt with \`agent/status/current.md\`.
5. \`agent/bin/run_watchdog.sh\` calls \`codex exec\` with the configured sandbox and schema.
6. The wakeup must report the same primary watchdog skill as \`agent/status/SKILL_ROUTE.json\`. If the route also attached secondary skills, the wakeup must acknowledge them through \`secondary_skills_consulted\`.
7. \`agent/bin/render_report.py\` rejects mismatched \`primary_skill\` or \`secondary_skills_consulted\` values and writes:
   - \`agent/reports/<timestamp>.json\`
   - \`agent/reports/<timestamp>.md\`
   - \`agent/reports/latest.md\`
   - \`agent/RUNTIME_STATE.md\`
   - \`agent/MORNING_BRIEF.md\`
   - \`agent/STATE.proposed.md\`
   - \`agent/CURRENT_STATE.md\`
   - \`agent/RUN_STATE.json\`
   - \`agent/NEXT_ACTION.md\`
   - \`agent/status/GATE_STATUS.json\`
   - \`agent/status/GATE_STATUS.md\`
   - \`agent/BLOCKERS.md\`
   - \`agent/REVIEW_PENDING.md\`

## Runner / Supervisor Cooperation

Set \`codexWatchdog.role\` to \`runner\` for project-local worker watchdogs and \`supervisor\` for low-frequency audit watchdogs. They use the same runtime and scripts; only the responsibility boundary changes.

Runner watchdogs should execute one bounded project-local cycle and update the canonical handoff files. Supervisor watchdogs should read runner canonical handoff files, classify stale/blocking states, prepare reviewer-pending work, and prevent redundant information snowballing. A supervisor must not become a fourth runner: it should not launch training, change model code, delete files, or bypass external-service approval.

Project-local secondary skills are an optional specialization layer. They are selected deterministically after the primary route is known, and they may refine reasoning discipline, comparability checks, reviewer packaging, or evidence hygiene. They must not replace the primary skill or expand queue/write/execution authority.

Use \`codexWatchdog.phaseOffsetMinutes\` to stagger timers. For example, runners can use offsets 0/10/20 minutes and the supervisor can use 30 minutes, while all runners repeat every 45 minutes and the supervisor repeats every 180 minutes.

## Initial Setup For Daily Codex Mode

Before starting a timer, instantiate the task from the user's plain-language request. Start with \`agent/TASK_REQUEST.md\`, then fill or review these files:

1. \`agent/PLAN.md\`: the approved objective and scope.
2. \`agent/TODO.md\`: concrete tasks, each with status.
3. \`agent/STATE.md\`: durable facts the watcher may rely on.
4. \`agent/SAFETY.md\`: forbidden actions, allowed write paths, GPU rules, and review requirements.
5. \`agent/DAILY_HANDOFF.md\`: what the watcher should focus on tonight.

Only after those files describe the concrete task, let the project-local guard check login, run one manual cycle, and start the timer only after that cycle succeeds:

\`\`\`bash
\# If login is not ready, this prints the login command and stops.
./agent/bin/watchdog start
\`\`\`

OpenAI login is the only manual authorization step. If the guard reports that login is not ready, run:

\`\`\`bash
./agent/bin/watchdog login
./agent/bin/watchdog status
\`\`\`

To stop the timer:

\`\`\`bash
./agent/bin/watchdog stop
\`\`\`

You can also start or stop it from the VSCode command \`Codex Watchdog: Start Guard\` or from the control panel. The extension prepares this folder and then blocks until the watchdog \`CODEX_HOME\` is logged in.

## Plain-Language Codex Takeover

If the user says something like "把这个需求实例化成 watchdog 任务", "准备看护员任务", or "instantiate this watchdog project", Codex should read \`agent/TASK_REQUEST.md\` and fill \`PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF\` first.

If the user says something like "启动看护员", "接管 watchdog", "start the guard", or "stand watch for this project", Codex should first verify that the task has been instantiated, then read \`agent/CODEX_TAKEOVER.md\` and use:

\`\`\`bash
./agent/bin/watchdog --help
./agent/bin/watchdog start
\`\`\`

That command checks the local layout and Codex login, runs one immediate wakeup, installs the repeating timer only if the immediate run succeeds, and prints the resulting timer status.

## Project-Local Startup Commands

If Codex only knows this folder path, these are the entry points:

\`\`\`bash
cd /path/to/this/project

# Show the complete project-local CLI manual.
./agent/bin/watchdog --help

# Complete the only manual authorization step if status says login is not ready.
./agent/bin/watchdog login
./agent/bin/watchdog status

# One immediate wakeup with login/layout checks. Good for testing.
./agent/bin/watchdog run-once

# Recompute deterministic route or validate runtime files without calling Codex.
./agent/bin/watchdog route
./agent/bin/watchdog validate

# Show compact queue state without raw log tails.
./agent/bin/watchdog queue

# Let Codex take over and start a standing guard.
./agent/bin/watchdog start

# Install and start the repeating systemd user timer.
./agent/bin/watchdog timer-install

# Check whether the timer is active and when it will run next.
./agent/bin/watchdog status

# Stop the repeating timer.
./agent/bin/watchdog stop
\`\`\`

Optional environment overrides:

\`\`\`bash
CODEX_BIN=/path/to/codex \\
CODEX_HOME=$HOME/.codex-watcher \\
CODEX_SANDBOX_MODE=read-only \\
WATCHDOG_INTERVAL_MINUTES=30 \\
WATCHDOG_TIMEOUT_MINUTES=25 \\
WATCHDOG_COMPACT_EVERY_RUNS=6 \\
./agent/bin/watchdog start
\`\`\`

## Runtime Curation

The guard keeps a project-local run counter in \`agent/status/run_count\`. Every \`WATCHDOG_COMPACT_EVERY_RUNS\` runs, the next wakeup is marked as a scheduled curation cycle in \`agent/status/current.md\`. During that cycle, Codex should use watchdog-report-curator behavior: keep \`RUNTIME_STATE.md\`, \`MORNING_BRIEF.md\`, and the phase report short; remove repeated history; reference old reports by path instead of copying them.

Set \`WATCHDOG_COMPACT_EVERY_RUNS=0\` to disable scheduled curation. Raw log tails are omitted from the core snapshot by default; set \`WATCHDOG_INCLUDE_LOG_TAILS=1\` only for short debugging sessions.

## Safety Boundary

Default watchdog mode is read-only reasoning plus reports. It should not kill jobs, delete files, launch unapproved training, change git state, or use unauthorized GPUs. Dangerous or uncertain next steps must be written as review-required proposals under \`agent/pending/\`.

Workspace-write coding probes are allowed only when \`agent/workspace_write_policy.json\` exists, is valid, sets \`enabled: true\`, and lists exact relative writable paths and exact allowed commands. \`agent/SAFETY.md\` should document the same probe for model guidance. If the JSON policy is missing or invalid, the generated scripts force \`workspace-write\` back to \`read-only\`.

## Daily Mode Handoff

When the user returns, daily Codex mode should read:

- \`agent/MORNING_BRIEF.md\`
- \`agent/reports/latest.md\`
- \`agent/RUNTIME_STATE.md\`
- \`agent/STATE.proposed.md\`

Daily mode should decide whether to accept, edit, or reject \`agent/STATE.proposed.md\`. Do not silently replace \`agent/STATE.md\` without human approval.
`,

  codexTakeover: () => `# Codex Takeover Protocol

This file tells daily Codex mode how to take over Codex Watchdog without reading the VSCode extension source.

## Plain-Language Trigger

If the user says any of the following, treat it as a request to instantiate the project first, not to start the timer immediately:

- "把这个需求实例化成 watchdog 任务"
- "准备看护员任务"
- "根据我的需求填好 watchdog"
- "instantiate this watchdog project"

For instantiation, read \`agent/TASK_REQUEST.md\` and rewrite \`agent/PLAN.md\`, \`agent/TODO.md\`, \`agent/STATE.md\`, \`agent/SAFETY.md\`, and \`agent/DAILY_HANDOFF.md\` so they describe the concrete task.

If the user says any of the following after task instantiation, treat it as a request to operate the project-local watchdog:

- "启动看护员"
- "接管 watchdog"
- "让 Codex 坚守岗位"
- "start the guard"
- "stand watch"
- "start watchdog for this project"

## Required First Reads

Before running commands, read:

1. \`README.codex-watchdog.md\`
2. \`agent/TASK_REQUEST.md\`
3. \`agent/SAFETY.md\`
4. \`agent/DAILY_HANDOFF.md\`
5. \`agent/PLAN.md\`
6. \`agent/TODO.md\`

## Preferred Command

Use the guard helper:

\`\`\`bash
./agent/bin/watchdog --help
./agent/bin/watchdog start
# or directly:
./agent/bin/watchdog_guard.sh start
\`\`\`

This command:

1. Verifies the project-local watchdog layout.
2. Resolves the Codex binary.
3. Checks \`CODEX_HOME\` login status.
4. Runs one immediate wakeup with \`agent/bin/run_watchdog.sh\`.
5. Starts the repeating systemd user timer only if the immediate wakeup succeeds.
6. Prints the timer unit and current timer status.

If login is not ready, do not try to bypass it. Tell the user to complete:

\`\`\`bash
./agent/bin/watchdog login
\`\`\`

Then rerun:

\`\`\`bash
./agent/bin/watchdog start
\`\`\`

## Other Commands

\`\`\`bash
./agent/bin/watchdog --help
./agent/bin/watchdog check
./agent/bin/watchdog run-once
./agent/bin/watchdog status
./agent/bin/watchdog queue
./agent/bin/watchdog route
./agent/bin/watchdog validate
./agent/bin/watchdog stop
./agent/bin/watchdog latest

# Direct helper aliases:
./agent/bin/watchdog_guard.sh check
./agent/bin/watchdog_guard.sh run-once
./agent/bin/watchdog_guard.sh status
./agent/bin/watchdog_guard.sh stop
./agent/bin/watchdog_guard.sh latest
\`\`\`

## Reporting Back To The User

After operating the guard, report:

- project root;
- Codex binary used;
- \`CODEX_HOME\`;
- whether login is ready;
- timer service and timer unit;
- active/enabled status;
- latest report path;
- whether human review is required.

If login is not ready, do not pretend the guard is active. Run or suggest:

\`\`\`bash
./agent/bin/watchdog login
\`\`\`

If safety evidence is insufficient, stop and explain what file needs to be filled before unattended operation.
`
};

module.exports = {
  bootstrapGuideDocTemplates
};
