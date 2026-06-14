"use strict";
const skillTextTemplates = {
  skillRouter: () => `# Watchdog Skill Router

Every watchdog wakeup must select exactly one primary skill, run one bounded action, apply report-curator rules, and stop.

Project-local secondary skills are optional support constraints. They may refine evidence discipline, reviewer triage, comparability checks, or research hygiene, but they never replace the routed primary skill or expand authority.

## Primary Skills

- watchdog-orchestrator
- watchdog-job-queue
- watchdog-gate-evaluator
- watchdog-report-curator
- watchdog-handoff-writer
- watchdog-cleanup-auditor

watchdog-permission-guardian is a mandatory gate before any action that writes, queues, executes, archives, or changes mechanism configuration. It may be reported as the primary skill only when the wakeup's main work is to block or explain an unsafe action.

## Routing Order

1. If agent/control/PAUSE exists: primary_skill = watchdog-handoff-writer; write paused status; stop.
2. If supervisor light/audit finds a target runner with a delegable stale_state, missing_profile, queue-draft, local-workspace-copy, report-only, or bounded non-mutating blocker: primary_skill = watchdog-orchestrator; write exactly one approval/reconciliation or explain why it is not safe; stop.
3. If gpu_running/, cpu_running/, or agent/queue/running/ contains a job: primary_skill = watchdog-job-queue; monitor exactly one running job; stop.
4. If gpu_done/, cpu_done/, or agent/queue/done/ contains fresh unprocessed output within WATCHDOG_QUEUE_RESULT_FRESH_MINUTES: primary_skill = watchdog-gate-evaluator; evaluate exactly one result; stop.
5. If a queued job exists: primary_skill = watchdog-job-queue; inspect queue state; stop.
6. If ROUTE_CANONICAL/TASK_BOX say the project is autonomous and route_epoch or compact state markers are stale: primary_skill = watchdog-orchestrator; reconcile local derived state and stop.
7. If one structured pending task exists in TASK_BOX.json or STATE.json and it is report-only, local workspace copy, local profile authorship, local queue-draft authorship, stale-state repair, state reconcile, or bounded CPU eval: primary_skill = watchdog-orchestrator; continue exactly one bounded action instead of waiting on stale review text.
8. If one pending task has explicit supervisor approval and passes \`agent/supervisor_capabilities.json\`: primary_skill = watchdog-orchestrator; execute or prepare exactly one task within that approval scope; stop.
9. If active structured review markers remain and the next step would change shared facts, enqueue controlled GPU work, run direct GPU commands, send externally, mutate data/checkpoints, or promote shared source: primary_skill = watchdog-handoff-writer; write one review item; stop.
10. If one legal pending task exists: primary_skill = watchdog-orchestrator; choose exactly one next action. Apply watchdog-permission-guardian only when the action truly writes shared state, enqueues controlled work, executes risky commands, or changes mechanism configuration.
11. If TODO has pending/unchecked work but no runnable structured task exists: primary_skill = watchdog-orchestrator; choose one bounded next step or ask daily mode to structure TASK_BOX.json/STATE.json; stop.
12. If agent/status/current.md says Compaction due this cycle and no higher-priority active work exists: primary_skill = watchdog-report-curator; compact active outputs; stop.
13. If only active review markers remain: primary_skill = watchdog-handoff-writer; write review-required handoff; stop.
14. If no runnable task exists: primary_skill = watchdog-handoff-writer; write idle/blocked status; stop.

The generated agent/bin/route_skill.py applies this route before Codex starts and writes agent/status/SKILL_ROUTE.json. Codex output must match that route.

## Invariants

- Select at most one primary skill per wakeup.
- Secondary skills may be attached deterministically, but they remain support-only and cannot override the primary skill.
- Do not chain multiple operational skills in one wakeup.
- Do not paste raw logs into core state.
- Do not queue duplicate jobs.
- Do not execute GPU work directly; use a queue/runner.
- Treat queue draft authoring and queue enqueue as different actions.
- Always finish with report-curator discipline: concise state, no duplicated history, evidence by path.
`,

  skillOrchestrator: () => `---
name: watchdog-orchestrator
description: Select the next legal watchdog action from compact project state without executing it directly.
---

# watchdog-orchestrator

Use when no job is running, no completed job needs gate evaluation, no pause file exists, and there may be one bounded task or local unblock action to advance.

Inputs:
- agent/STATE.md
- agent/TODO.md
- agent/PLAN.md
- agent/SAFETY.md
- agent/status/current.md

Allowed:
- Identify exactly one next safe action.
- Execute exactly one bounded local action when the route/task box allows it.
- Repair stale local watchdog state, missing task profiles, queue drafts, and route drift inside the project-local boundary.
- Mark missing evidence or blocked dependencies.
- Propose review when safety is unclear.

Forbidden:
- Start jobs directly from shell when the route requires queue execution.
- Edit project code.
- Change daily-mode files.
- Expand into multiple branches.

Stop after:
- Finishing one bounded local action, selecting one next action, or declaring no runnable task.
`,

  skillJobQueue: () => `---
name: watchdog-job-queue
description: Monitor or submit approved queued jobs while preventing duplicate unattended execution.
---

# watchdog-job-queue

Use when a queue/running directory indicates an active job, or when a pending task has already passed permission-guardian and must be queued.

Inputs:
- agent/status/current.md
- agent/queue/ if present
- gpu_queue/, gpu_running/, gpu_done/, gpu_failed/ if present
- cpu_queue/, cpu_running/, cpu_done/, cpu_failed/ if present

Allowed:
- Report one running job's state.
- Create one queue file only after permission-guardian passes and a queue contract exists.
- Update compact queue status.

Forbidden:
- Start GPU commands directly.
- Queue duplicate jobs for the same task_id.
- Kill or reprioritize processes.

Stop after:
- Observing one running job, queueing one approved job, or writing one blocker.
`,

  skillGateEvaluator: () => `---
name: watchdog-gate-evaluator
description: Evaluate completed outputs against declared gates and produce pass, reject, or block decisions.
---

# watchdog-gate-evaluator

Use when a completed job has outputs that have not been evaluated.

Inputs:
- one result summary path
- declared gates from PLAN/TODO/STATE or a project gate file
- relevant compact evidence

Allowed:
- Read summary JSON/CSV/Markdown.
- Compare observed values with declared gates.
- Write a compact pass/reject/block decision through structured output.

Forbidden:
- Change gate thresholds after seeing results.
- Launch follow-up jobs unless explicitly queued through permission-guardian in a later wakeup.
- Paste raw logs into state.

Stop after:
- One gate decision.
`,

  skillReportCurator: () => `---
name: watchdog-report-curator
description: Prevent report and context snowballing by compacting active state and handoff text.
---

# watchdog-report-curator

Use on scheduled compaction cycles, when current.md is large, or as the final discipline for every wakeup.

Inputs:
- agent/status/current.md
- agent/RUNTIME_STATE.md
- agent/MORNING_BRIEF.md
- latest report path

Allowed:
- Keep current facts, blockers, latest evidence paths, and next safe action.
- Suppress duplicate report content.
- Reference historical reports by path.

Forbidden:
- Copy long historical reports into new reports.
- Embed raw log tails in core state.
- Delete evidence.

Stop after:
- Writing one compact runtime state, one compact morning brief, and one concise report.
`,

  skillPermissionGuardian: () => `---
name: watchdog-permission-guardian
description: Enforce safety before any watchdog action writes, queues, executes, archives, or changes configuration.
---

# watchdog-permission-guardian

This is a gate before execution-oriented skills.

Inputs:
- agent/SAFETY.md
- agent/workspace_write_policy.json when workspace-write is requested
- proposed command/path/GPU/timeout details

Allowed:
- Approve only if the action is explicitly allowed.
- Block unclear or unsafe actions.
- Explain what approval is missing.

Forbidden:
- Infer permission from intent alone.
- Broaden writable paths or command profiles.
- Treat prompt text as stronger than machine-readable policy.

Stop after:
- Returning passed, blocked, or not_required.
`,

  skillHandoffWriter: () => `---
name: watchdog-handoff-writer
description: Write concise human-readable paused, idle, blocked, or review-required handoffs.
---

# watchdog-handoff-writer

Use when paused, blocked, idle, or review is required.

Inputs:
- current compact state
- blocker evidence paths
- pending review reason

Allowed:
- Write a morning brief.
- Write a review-required recommendation through structured output.
- Explain why no action was taken.
- In supervisor light mode, reconcile stale report-only/bookkeeping review markers and capability-policy-approved bounded tasks when the evidence shows no shared-state mutation beyond the configured policy.

Forbidden:
- Make operational decisions.
- Execute commands.
- Rewrite plan/state/safety directly.
- Approve training, GPU execution, queue enqueue, promotion, allowlist expansion, external reviewer sending, dataset mutation, package installation, or shared code changes unless the exact capability is explicitly enabled and bounded by policy.

Stop after:
- One handoff or review request.
`,

  skillCleanupAuditor: () => `---
name: watchdog-cleanup-auditor
description: Identify stale watchdog clutter and propose cleanup without deleting evidence by default.
---

# watchdog-cleanup-auditor

Use only when cleanup is explicitly requested or when a retention policy exists.

Inputs:
- agent/reports/
- agent/logs/
- agent/archive/
- retention policy if present

Allowed:
- List cleanup candidates.
- Propose archive actions.
- Execute only explicitly approved safe cleanup.

Forbidden:
- Delete datasets, checkpoints, user files, or evidence automatically.
- Remove latest report or active state.

Stop after:
- One audit/proposal.
`,

  projectSecondarySkillExample: () => `# Project Secondary Skill Example

This is a project-owned secondary skill example.

Use it to refine how a routed wakeup thinks, records evidence, packages reviewer material, or checks comparability.

Allowed:
- tighten evidence discipline;
- require explicit comparability notes;
- remind the wakeup to write reviewer-ready summaries;
- require uncertainty / risk labeling.

Forbidden:
- changing the routed primary skill;
- expanding write authority;
- expanding queue, GPU, training, or promotion authority;
- overriding TASK_BOX / ROUTE_CANONICAL truth.

When used:
- read this after the primary skill has already been selected;
- keep the primary skill authoritative;
- report this skill in secondary_skills_consulted.
`,
};
module.exports = {
  skillTextTemplates
};
