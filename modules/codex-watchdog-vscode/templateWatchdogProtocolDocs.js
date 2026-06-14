"use strict";

const watchdogProtocolDocTemplates = {
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
`
};

module.exports = {
  watchdogProtocolDocTemplates
};
