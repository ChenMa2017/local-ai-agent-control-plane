"use strict";

const watchdogDocTemplates = {
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
`
};

module.exports = {
  watchdogDocTemplates
};
