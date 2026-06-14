"use strict";

const bootstrapProjectDocTemplates = {
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
`
};

module.exports = {
  bootstrapProjectDocTemplates
};
