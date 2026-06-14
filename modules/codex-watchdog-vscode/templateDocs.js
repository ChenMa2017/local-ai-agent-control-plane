"use strict";
const docTemplates = {
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
`,

  taskRequest: () => `# Task Request

This file is for daily Codex mode before the watchdog starts.

## User Request

Describe in plain language what the watchdog should do while unattended.

Examples:

- Watch these logs and summarize whether the experiment is still improving.
- Read these Markdown notes and extract TODO/FIXME/QUESTION items into a report.
- Monitor an evaluation output folder and prepare a morning comparison against a baseline.

## Codex Instantiation Instructions

When the user gives a plain-language task, instantiate this project before starting the guard:

1. Rewrite \`agent/PLAN.md\` with the approved objective, allowed scope, and review-required decisions.
2. Rewrite \`agent/TODO.md\` with concrete watchdog tasks and evidence paths.
3. Rewrite \`agent/STATE.md\` with durable known facts, active inputs, and current blockers.
4. Rewrite \`agent/SAFETY.md\` with hard no-go rules for this specific project.
5. Rewrite \`agent/DAILY_HANDOFF.md\` with tonight's objective, approved scope, active items, known risks, and morning questions.
6. Create any harmless seed files needed for the task only if the user explicitly asked for a demo or test scenario.
7. Do not start the guard until these files describe the concrete task rather than generic placeholders.

## Ready Check

Before starting watchdog mode, these should be true:

- \`agent/PLAN.md\` names a concrete objective.
- \`agent/TODO.md\` names concrete tasks and paths to inspect.
- \`agent/STATE.md\` contains the current known state.
- \`agent/SAFETY.md\` says what must not be touched.
- \`agent/DAILY_HANDOFF.md\` answers what the watcher should do tonight.
`,

  agents: () => `# Project Agent Rules

## Role

You are an overnight research assistant for this project. Inspect the current project state, reason about progress, and prepare safe next-step reports.

## Hard Safety Rules

You must not:

- kill, suspend, restart, or reprioritize running training jobs;
- delete files or directories;
- modify dataset files;
- start a new training job unless an explicit approved job request exists;
- use GPUs outside the allowlist described in agent/SAFETY.md;
- change environment variables that affect active jobs;
- run destructive git commands;
- push, pull, merge, rebase, reset, or checkout branches without approval.

## Allowed By Default

You may:

- read project files;
- inspect logs and experiment outputs;
- summarize metrics;
- compare current status against agent/PLAN.md and agent/TODO.md;
- write reports through the automation output mechanism;
- propose safe next actions;
- mark uncertainty explicitly.

## Watchdog Takeover

If the user asks you in plain language to start, take over, wake, guard, or stand watch for this project, do not ask them to operate the VSCode extension manually. Read README.codex-watchdog.md and agent/CODEX_TAKEOVER.md, then use the project-local scripts:

- agent/bin/watchdog_guard.sh start
- agent/bin/watchdog_guard.sh status
- agent/bin/watchdog_guard.sh stop

Start the guard only after checking the selected project root, Codex login status, and the safety files. Report the timer unit, next run status, and latest report path.

## Decision Principle

When in doubt, do not execute. Write a clear reason and create a review-required recommendation.
`,

  plan: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Overnight Plan

## Objective

Continue monitoring the current training/evaluation pipeline and prepare safe next steps.

## Current Approved Work

1. Monitor the experiments named in agent/TODO.md.
2. Parse relevant logs under runs/, logs/, outputs/, and experiment-specific directories.
3. Detect whether active training completed normally.
4. If training completed, summarize final metrics.
5. If evaluation outputs already exist, compare them against the baseline named in agent/TODO.md.
6. Do not launch new training.
7. Do not stop or alter running jobs.

## Review-Required Decisions

- Starting a new training run.
- Changing hyperparameters.
- Moving or deleting checkpoints.
- Reassigning GPUs.
- Modifying training code.
- Changing dataset preprocessing.
`,

  state: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Agent State

Last updated: unknown

## Active Experiments

- None recorded yet. Fill this section with the experiment IDs, output paths, host, expected logs, and known status before relying on unattended decisions.

## Completed Tasks

- None recorded yet.

## Blocked / Review Required

- New training, code changes, checkpoint deletion, process control, and GPU reassignment require human review.

## Next Safe Task

Read the current snapshot, compare it with agent/PLAN.md and agent/TODO.md, and write a report.
`,

  queueStatus: () => `# Queue Status

Updated: never

## Running

No running jobs recorded.

## Queued

No queued jobs recorded.

## Done / Failed Since Last Wakeup

No completed or failed jobs recorded.

## Log Summary

- Tail included: no
`,

  researchLedger: () => `# Research Ledger

Only durable, evidence-backed facts belong here. Do not paste raw logs or transient reports.

## Research Question

- Not defined yet.

## Operational Definitions

- Not defined yet.

## Confirmed Facts

- None yet.

## Current Hypotheses

- None yet.

## Next Decisions

- None yet.
`,

  ledgerNotes: () => `# Ledger Notes

Use this file for proposed ledger fragments or uncertain observations. Do not overwrite RESEARCH_LEDGER.md unless producing a complete document that starts with "# Research Ledger".
`,

  watchdogProtocol: () => `# Watchdog Cooperation Protocol

This generated protocol keeps runner watchdogs and supervisor watchdogs compatible.

## Roles

- \`runner\`: execute one bounded project-local work cycle, monitor/queue/evaluate project jobs, and update canonical handoff files.
- \`supervisor\`: run less frequently, inspect runner handoff files, classify blockers, compact repeated history, and coordinate reviewer-pending requests.

Both roles use the same Codex runtime and generated scripts. The supervisor is not a privileged fourth runner.

## Canonical Route And Handoff Files

Canonical route truth now starts with:

- \`agent/ROUTE_CANONICAL.json\`: route_id, route_epoch, owner_mode, active step, and downstream gates.
- \`agent/TASK_BOX.json\`: machine-readable bounded assignment, allowed actions, allowed write paths, queue policy, and concrete tasks.

Derived/project-local watchdog files should be reconciled against the canonical route/task box when they drift:

Each wakeup should leave these files coherent:

- \`agent/CURRENT_STATE.md\`: current facts only.
- \`agent/RUN_STATE.json\`: machine-readable role/status/blocker/next-action summary.
- \`agent/NEXT_ACTION.md\`: exactly one next safe action.
- \`agent/BLOCKERS.md\`: blockers grouped as env, queue, permission, reviewer, model, data, stale_state, or none.
- \`agent/REVIEW_PENDING.md\`: reviewer bundle state, sanitization state, send state, and response state.
- \`agent/ANTI_SNOWBALL.md\`: stopped routes, stale facts to avoid repeating, and compaction notes.
- \`agent/EXPERIMENT_LEDGER.md\`: durable experimental hypotheses, model/loss/data protocol, provenance, results, and conclusions.
- \`agent/EVIDENCE_LEDGER.jsonl\`: durable machine-readable evidence objects for later agents.

## Supervisor Modes

- \`light\`: triggered after a new completed runner cycle or a changed reviewer/blocker marker. Repair only safe report-only/bookkeeping issues such as stale pending_send markers, stale handoff files, permission notes, blocker classification, and next-action clarification.
- \`audit\`: triggered every configured runner-cycle cadence. Run light marker hygiene first, then one heavier audit for leakage, anti-snowballing, stale state, environment drift, queue hygiene, and repeated blocker repair.
- \`standby\`: no new runner cycle and no audit due. Write a short heartbeat and stop.

The runtime writes the chosen mode to \`agent/status/SUPERVISOR_MODE.json\` and \`agent/RUN_STATE.json\`. Do not override it inside the prompt; report a runtime blocker if it appears wrong.

## Runner Rules

- Runner is not just an observer. Runner is the default executor for bounded planned work and the default repairer for low-risk local blockers.
- If \`requires_review=false\`, treat the project as fully autonomous for bounded local work inside the task box and route contract.
- Prefer \`agent/TASK_BOX.json\` first, then \`agent/STATE.json\`, then markdown files.
- If \`agent/ROUTE_CANONICAL.json\` disagrees with derived state files, repair the derived files locally instead of waiting for a supervisor essay.
- Queue draft authoring, local profile/package authoring, local workspace copy preparation, stale state cleanup, and bounded CPU eval are autonomy-preserving actions; do them when the task box and safety policy allow them.
- Sandbox-local GPU visibility failures are advisory only. Do not conclude that the host has no GPU unless queue/host evidence agrees.
- Direct GPU shell execution remains forbidden; convert it into a queue path or queue draft.

## Supervisor Rules

- Prefer canonical handoff files over old reports.
- If a runner is active, do not wait on or interrupt it.
- Fix only stale state, stale pause markers, stale queue metadata, reviewer-pending bookkeeping, and anti-snowball summaries.
- You may resolve runner report-only/bookkeeping blockers when the evidence is explicit and no shared-state side effect is being approved.
- You may approve only the capability classes explicitly allowed by \`agent/supervisor_capabilities.json\`; public defaults allow report-only, state reconcile, stale-marker cleanup, local workspace copy work, local profile/package authorship, local queue-draft authorship, and bounded CPU eval.
- You must not approve disabled capability classes such as GPU probes, training canaries, queue enqueue, promotion, external reviewer sending, data/checkpoint mutation, package installation, service mutation, or new high-risk allowlist permissions. Write a review-required handoff instead.
- If \`queue_enqueue\` is enabled, it only permits writing a bounded taskbox/request into the monitored queue; it never permits the runner to execute GPU commands directly or bypass the queue runner.
- If a deterministic project-local reconciliation helper has already repaired stale state, trust its compact report and do not launch a second broad reasoning pass for the same wakeup.
- Passive waiting is a supervisor failure when a blocker is stale/repeated, the evidence is local, and the repair is bookkeeping/report-only or an explicitly supervisor-approved bounded non-mutating task.
- For stale_state, stale_route_text, missing_profile, queue-draft authorship, and sandbox-visibility-only blockers, repair locally when the change stays inside the project-local watchdog boundary.
- For environment or external reviewer blockers, write the exact needed action and evidence path.
- For model/data/loss decisions, prepare a concise reviewer or Deep Research evidence bundle; do not invent a new model line.
`,

  currentState: () => `# Current State

Updated: never

## Role

- Unknown. Generated watchdogs should set this from WATCHDOG_ROLE.

## Current Facts

- No current facts recorded yet.

## Latest Evidence

- None yet.
`,

  nextAction: () => `# Next Action

Updated: never

## One Next Safe Action

- None recorded yet.

## Stop Condition

- Stop after one bounded action and update canonical handoff files.
`,

  blockers: () => `# Blockers

Updated: never

Use blocker types: env, queue, permission, reviewer, model, data, stale_state, none.

## Active Blockers

- none: no blocker recorded yet.
`,

  reviewPending: () => `# Review Pending

Updated: never

## Reviewer Bundle State

- drafted: no
- sanitized: no
- pending_send: no
- sent: no
- blocked_by_env_policy: no
- response_received: no
- triaged: no

## Notes

- External reviewer sending may require environment-level approval. If blocked, write the exact bundle path and reason here instead of repeating it in every report.
`,

  antiSnowball: () => `# Anti-Snowball Notes

Updated: never

## Current Facts To Preserve

- None yet.

## Stopped Or Deprecated Routes

- None yet.

## Do Not Repeat

- Do not copy long historical reports into new reports. Reference paths instead.
`,

  experimentLedger: () => `# Experiment Ledger

Record durable experimental evidence for later Code Reviewer Agent / ChatGPT Deep Research use.

## Template

### Experiment ID

- Hypothesis:
- Model forward / structure:
- Loss / objective:
- Data protocol:
- Evaluation protocol:
- Provenance:
- Main metrics:
- Possible cheating paths:
- Failure classification:
- Conclusion:
- Next minimal diagnostic:
`,

  runtimeState: () => `# Runtime State

Last updated: never

This file is low-risk watcher memory. The scheduled watcher may refresh it after each run. Keep durable, human-approved project truth in agent/STATE.md.
`,

  dailyHandoff: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Daily Handoff

Last prepared: unknown

This file is written by the human operator or daily Codex mode before leaving the project unattended. The scheduled watchdog reads it but should not rewrite it.

## Tonight's Objective

- Replace this line with the concrete objective for the unattended period.

## Approved Scope

- Read project files, logs, metrics, and experiment outputs.
- Write reports, runtime state, morning brief, and review-required proposals under agent/.

## Active Experiments To Watch

- None recorded yet.

## Known Risks / Do Not Touch

- Do not launch new training.
- Do not stop or alter running jobs.
- Do not modify code, datasets, checkpoints, or git state.

## Morning Questions

- What finished?
- What is still running?
- What needs human review?
`,

  morningBrief: () => `# Morning Brief

No scheduled watchdog run has generated a morning brief yet.
`,

  safety: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Safety Policy

## Execution Mode

Default watcher mode: read-only reasoning.

## GPU Policy

- The watcher itself must run with CUDA_VISIBLE_DEVICES="".
- It must not allocate GPU memory.
- It must not run Python scripts that import torch with CUDA enabled.
- It must not launch training.
- It may inspect nvidia-smi output collected by agent/bin/collect_status.sh.

## Forbidden Commands

Never run or propose automatic execution of:

- rm, unlink, shred
- kill, pkill, killall
- git reset, git clean, git checkout, git switch, git pull, git push, git merge, git rebase
- sbatch, torchrun, accelerate launch, deepspeed, python train.py
- chmod/chown on project data or checkpoint directories

## Allowed Automatic Actions

In Level 1:

- read files;
- summarize logs;
- write report;
- write proposed state update.

In Level 2 only, after explicit implementation of a policy gate:

- run whitelisted postprocessing scripts with fixed arguments;
- run metric summarization scripts that do not use GPU;
- create review request files under agent/pending/.
`,

  todo: () => `<!-- CODEX_WATCHDOG_TEMPLATE_FILE: remove this marker after task instantiation -->

# Watcher TODO

Use statuses: pending, running, done, blocked, review_required.

| Status | Task | Evidence / Path |
| --- | --- | --- |
| pending | Replace this row with the first approved monitoring task. | agent/PLAN.md |
`,

  wakeup: () => `You are the scheduled Codex watcher for this research project.

You are being awakened by a timer. Treat this as a fresh handoff. Do not assume hidden chat context. Use only:

- agent/PLAN.md
- agent/STATE.md
- agent/STATE.json
- agent/TASK_BOX.json
- agent/ROUTE_CANONICAL.json
- agent/SECONDARY_SKILLS.json when present
- agent/PROGRESS_STATE.json
- agent/SAFETY.md
- agent/TODO.md
- agent/DAILY_HANDOFF.md
- agent/WATCHDOG_PROTOCOL.md
- agent/CURRENT_STATE.md
- agent/RUN_STATE.json
- agent/NEXT_ACTION.md
- agent/BLOCKERS.md
- agent/REVIEW_PENDING.md
- agent/ANTI_SNOWBALL.md
- agent/EXPERIMENT_LEDGER.md
- agent/EVIDENCE_LEDGER.jsonl
- agent/RUNTIME_STATE.md
- agent/MORNING_BRIEF.md
- agent/SKILL_ROUTER.md
- agent/status/SKILL_ROUTE.json
- agent/status/QUEUE_STATUS.md
- research/RESEARCH_LEDGER.md
- agent/skills/<selected-skill>/SKILL.md when needed
- agent/status/current.md
- relevant project files and logs if available in read-only mode

Mode boundary:

- Daily mode owns the intent and long-horizon policy in agent/PLAN.md, agent/TODO.md, agent/STATE.md, agent/SAFETY.md, and agent/DAILY_HANDOFF.md.
- Watchdog mode owns agent/CURRENT_STATE.md, agent/RUN_STATE.json, agent/NEXT_ACTION.md, agent/BLOCKERS.md, agent/REVIEW_PENDING.md, agent/ANTI_SNOWBALL.md, agent/EXPERIMENT_LEDGER.md, agent/RUNTIME_STATE.md, agent/MORNING_BRIEF.md, agent/status/, agent/reports/, agent/logs/, and agent/pending/.
- agent/TASK_BOX.json and agent/ROUTE_CANONICAL.json are the machine-readable route contract. When they drift from derived watchdog files, prefer reconciling the derived files instead of freezing.
- Project-local autonomous artifacts may also be written under agent/task_profiles/, workspace/, and runs/ when TASK_BOX/SAFETY explicitly allow that bounded action.
- Do not rewrite daily-mode files. Propose changes through state_update_markdown or review-required pending records.

Runner / supervisor cooperation:

- Read WATCHDOG_ROLE from the snapshot. If it is \`runner\`, perform one bounded project-local cycle and update the canonical handoff files through your structured output.
- If it is \`supervisor\`, also read WATCHDOG_SUPERVISOR_MODE from the snapshot:
  - \`light\`: perform a lightweight follow-up after a runner cycle. Repair only safe reviewer-pending markers, stale handoff markers, permission/allowlist notes, or blocker bookkeeping. Do not deep-audit the project.
  - \`audit\`: perform a heavier read-only health audit for leakage, anti-snowball, stale state, environment drift, queue hygiene, and repeated blocker repair. Do not become a runner.
  - \`standby\`: write a short heartbeat and stop.
- Supervisor mode is chosen deterministically by the runtime from runner cycle counts and marker files; do not silently change it. If the selected mode looks wrong, report it as a runtime blocker.
- If it is \`supervisor\`, do not launch training, change model code, delete files, interrupt active runner work, or bypass external-service approval.
- Prefer agent/TASK_BOX.json and agent/ROUTE_CANONICAL.json first, then agent/CURRENT_STATE.md, agent/RUN_STATE.json, agent/NEXT_ACTION.md, agent/BLOCKERS.md, and agent/REVIEW_PENDING.md over old reports when deciding what is currently true.
- Blockers must be classified as env, queue, permission, reviewer, model, data, stale_state, or none.

Runtime curation:

- agent/status/current.md contains watchdog runtime controls, including run count and whether this is a scheduled compaction cycle.
- If "Compaction due this cycle" is 1, apply watchdog-report-curator rules while finalizing. The deterministic route may still select a higher-priority primary skill such as job-queue or gate-evaluator. If no higher-priority work exists, route_skill.py may select watchdog-report-curator as the primary skill.
- During compaction, do not summarize every historical report. Preserve audit history by referencing paths, not by copying old text.
- Raw log tails are intentionally omitted from the core snapshot by default. Open a specific referenced log only when it is necessary for the current bounded action.

Watchdog skills layer:

- Start by reading agent/status/SKILL_ROUTE.json, which is produced deterministically by agent/bin/route_skill.py before Codex starts.
- Select exactly one primary_skill for this wakeup, and it must match agent/status/SKILL_ROUTE.json. If the deterministic route appears wrong, explain that as a blocker; do not silently choose a different primary skill.
- Read the selected skill's agent/skills/<primary_skill>/SKILL.md when the route is not obvious from the snapshot.
- If agent/status/SKILL_ROUTE.json lists secondary_skills, read those support-skill paths after the primary skill. Use them to tighten evidence discipline, comparability checks, reviewer packaging, or project-specific reasoning hygiene only; do not let them override the primary skill or broaden authority.
- If the action writes shared state, enqueues controlled work, executes risky commands, archives, or changes mechanism configuration, watchdog-permission-guardian must pass first. Local state reconcile, local queue-draft authorship, local profile authorship, local workspace copy preparation, stale-marker cleanup, and bounded CPU eval do not need to stop for review when they remain inside the project-local watchdog boundary and match TASK_BOX/SAFETY.
- Do not chain multiple operational skills in one wakeup. Run one bounded action and stop.

Your job:

1. Actively perform this work cycle. Do not merely restate or archive the prompt.
2. Use safe read-only inspection commands when the snapshot is insufficient, such as pwd, ls, find, rg, sed, tail, git status, and project-specific metric readers that do not write files or use GPUs.
3. Reconstruct the current project state.
4. Decide what has completed, what is still running, and what is blocked.
5. Compare the current state against the approved plan.
6. Choose the next safe action.
7. In autonomous mode, do not stop just because a stale marker exists. Continue with one bounded local action when TASK_BOX/ROUTE_CANONICAL say requires_review=false and the work stays inside the allowed local boundary.
8. A workspace-write coding probe is allowed only when all of these are true: agent/workspace_write_policy.json exists, is valid JSON, sets enabled to true, lists exact relative writable paths and exact allowed commands; agent/SAFETY.md documents the same probe; agent/PLAN.md, agent/TODO.md, or agent/TASK_BOX.json requests the probe; and the project is an isolated demo or explicitly approved workspace. If any condition is missing, create a review-required proposal instead of writing files.
9. If an explicit workspace-write coding probe is active, edit only the allowlisted paths, run only the allowlisted commands, and summarize every command and file change in the final structured output.
10. If the next action is safe and allowed by agent/SAFETY.md, perform it when it is read-only inspection, report generation through the final structured output, project-local state reconcile, local queue/profile/taskbox authoring, bounded CPU eval, or an explicitly allowlisted workspace-write coding probe. For actions that write shared files, enqueue controlled GPU work, send externally, or promote results, create a review-required proposal instead of executing them.
11. Produce a concise but useful phase report.
12. Produce a proposed update to agent/STATE.md.
13. Produce a compact runtime state update for agent/RUNTIME_STATE.md. Keep it shorter than the proposed state and focused on last wakeup time, active experiments, latest observed metrics, blockers, and the next safe watch task.
14. Produce a concise morning brief for daily mode to read when the human returns.
15. If a durable research ledger update is necessary, output a complete ledger_update_markdown that starts with "# Research Ledger"; otherwise leave it empty. Do not output fragments as ledger replacements.
16. If blocked work needs human approval, output a concise proposal_markdown with purpose, command/profile if any, expected outputs, safety boundary, and stop condition.
17. Classify the report_type as progress, blocked, heartbeat, error, or recommend_pause.
18. Track no_progress_cycles conservatively: increment only when there is no new evidence, no blocker change, and no completed action; reset to 0 when meaningful progress occurs.
19. If no_progress_cycles is high or the same blocker repeats, set recommend_pause=true and explain the human decision needed.
20. Mark only truly dangerous or shared-side-effect decisions as requires_human_review. Do not escalate purely local unblockers into human review.
21. If this wakeup identifies an exact successor route, exact successor task, or exact next queue/profile object, emit it structurally instead of leaving the next step broad.
22. Use successor_task_draft for the next runnable task, task_profile_draft for exact local profile/package content, queue_request_draft for exact queue draft content, and route_canonical_update when the canonical route itself changed.
23. Separate queue draft from queue enqueue. A local queue draft may be prepared autonomously; queue enqueue should only be emitted as automatically executable when the queue contract is exact and TASK_BOX queue_policy sets allow_conditional_enqueue=true.
24. If the current TASK_BOX contract is missing topic alignment, claim scope, fair comparability, or value-of-information details, repair it structurally through task_box_update instead of only mentioning the gap in prose.
25. For bounded research or queue tasks, prefer adding or refining project_question, decision_relevance, claim_scope, forbidden_conclusions, diagnosis_target, fair_comparability, and value_of_information before asking humans for help.
26. If a decision-bearing result changes the route but no explicit successor task was written yet, set route_canonical_update.successor_contract_required=true and either emit successor_task_draft yourself or emit task_box_update that makes the next exact object unambiguous.
27. Always report which routed secondary skills you actually consulted through secondary_skills_consulted. If none were routed, return an empty array.

Hard restrictions:

- Do not kill, suspend, restart, or interfere with running training.
- Do not delete files.
- Do not launch new training.
- Do not execute GPUs directly from the sandbox shell. GPU queue/host evidence may still exist; treat sandbox visibility failures as advisory unless host-side evidence confirms a real outage.
- Do not modify code unless an explicit workspace-write coding probe is enabled by agent/workspace_write_policy.json and documented in agent/SAFETY.md with the exact file paths and allowed commands. Otherwise, do not modify code.
- Do not make git changes.
- Do not use network.
- Do not install packages.
- If evidence is insufficient, say so.
- Prefer a conservative report over speculative action.

The final output must follow the JSON schema.
`,
};
module.exports = {
  docTemplates
};
