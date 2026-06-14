"use strict";

const watchdogPlanningDocTemplates = {
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
`
};

module.exports = {
  watchdogPlanningDocTemplates
};
