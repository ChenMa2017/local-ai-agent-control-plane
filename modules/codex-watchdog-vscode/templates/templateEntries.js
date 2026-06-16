"use strict";

function bootstrapScaffoldEntries(templates) {
  return [
    ["README.codex-watchdog.md", templates.watchdogReadme()],
    ["AGENTS.md", templates.agents()],
    ["agent/CODEX_TAKEOVER.md", templates.codexTakeover()],
    ["agent/WATCHDOG_PROTOCOL.md", templates.watchdogProtocol()],
    ["agent/TASK_REQUEST.md", templates.taskRequest()],
    ["agent/PLAN.md", templates.plan()],
    ["agent/STATE.md", templates.state()],
    ["agent/STATE.json", templates.stateJson()],
    ["agent/TASK_BOX.json", templates.taskBoxJson()],
    ["agent/ROUTE_CANONICAL.json", templates.routeCanonicalJson()],
    ["agent/PROGRESS_STATE.json", templates.progressStateJson()],
    ["agent/CURRENT_STATE.md", templates.currentState()],
    ["agent/RUN_STATE.json", templates.runStateJson()],
    ["agent/NEXT_ACTION.md", templates.nextAction()],
    ["agent/BLOCKERS.md", templates.blockers()],
    ["agent/REVIEW_PENDING.md", templates.reviewPending()],
    ["agent/ANTI_SNOWBALL.md", templates.antiSnowball()],
    ["agent/EXPERIMENT_LEDGER.md", templates.experimentLedger()],
    ["agent/RUNTIME_STATE.md", templates.runtimeState()],
    ["agent/DAILY_HANDOFF.md", templates.dailyHandoff()],
    ["agent/MORNING_BRIEF.md", templates.morningBrief()],
    ["agent/SAFETY.md", templates.safety()],
    ["agent/TODO.md", templates.todo()],
    ["agent/workspace_write_policy.example.json", templates.workspaceWritePolicyExample()],
    ["agent/SECONDARY_SKILLS.example.json", templates.secondarySkillsExample()],
    ["agent/status/QUEUE_STATUS.md", templates.queueStatus()],
    ["agent/EVIDENCE_LEDGER.jsonl", templates.evidenceLedgerJsonl()],
    ["project_index/document_index.jsonl", templates.projectIndexDocumentIndex()],
    ["project_index/experiment_index.jsonl", templates.projectIndexExperimentIndex()],
    ["project_index/current_conclusions.json", templates.projectIndexCurrentConclusions()],
    ["project_index/golden_queries.json", templates.projectIndexGoldenQueries()],
    ["research/RESEARCH_PROGRAM.json", templates.researchProgram()],
    ["research/schema/research_program.schema.json", templates.researchProgramSchema()],
    ["research/RESEARCH_LEDGER.md", templates.researchLedger()],
    ["research/LEDGER_NOTES.md", templates.ledgerNotes()]
  ];
}

function collaborationHandoffEntries(templates) {
  return [
    ["agent/CURRENT_STATE.md", templates.currentState()],
    ["agent/RUN_STATE.json", templates.runStateJson()],
    ["agent/TASK_BOX.json", templates.taskBoxJson()],
    ["agent/ROUTE_CANONICAL.json", templates.routeCanonicalJson()],
    ["agent/NEXT_ACTION.md", templates.nextAction()],
    ["agent/BLOCKERS.md", templates.blockers()],
    ["agent/REVIEW_PENDING.md", templates.reviewPending()],
    ["agent/ANTI_SNOWBALL.md", templates.antiSnowball()],
    ["agent/EXPERIMENT_LEDGER.md", templates.experimentLedger()],
    ["agent/EVIDENCE_LEDGER.jsonl", templates.evidenceLedgerJsonl()]
  ];
}

function dailyHandoffEntries(templates) {
  return [
    ["agent/DAILY_HANDOFF.md", templates.dailyHandoff()],
    ["agent/MORNING_BRIEF.md", templates.morningBrief()]
  ];
}

function generatedSkillEntries(templates) {
  return [
    ["agent/SKILL_ROUTER.md", templates.skillRouter(), 0o644],
    ["agent/skills/watchdog-orchestrator/SKILL.md", templates.skillOrchestrator(), 0o644],
    ["agent/skills/watchdog-job-queue/SKILL.md", templates.skillJobQueue(), 0o644],
    ["agent/skills/watchdog-gate-evaluator/SKILL.md", templates.skillGateEvaluator(), 0o644],
    ["agent/skills/watchdog-report-curator/SKILL.md", templates.skillReportCurator(), 0o644],
    ["agent/skills/watchdog-permission-guardian/SKILL.md", templates.skillPermissionGuardian(), 0o644],
    ["agent/skills/watchdog-handoff-writer/SKILL.md", templates.skillHandoffWriter(), 0o644],
    ["agent/skills/watchdog-cleanup-auditor/SKILL.md", templates.skillCleanupAuditor(), 0o644],
    ["agent/skills/project-secondary-example/SKILL.example.md", templates.projectSecondarySkillExample(), 0o644]
  ];
}

function generatedWatcherEntries(root, templates, watchdogEnv) {
  return [
    ["agent/watchdog.env", watchdogEnv, 0o644],
    ["README.codex-watchdog.md", templates.watchdogReadme(), 0o644],
    ["agent/CODEX_TAKEOVER.md", templates.codexTakeover(), 0o644],
    ["agent/WATCHDOG_PROTOCOL.md", templates.watchdogProtocol(), 0o644],
    ["agent/prompts/wakeup.md", templates.wakeup(), 0o644],
    ["agent/schemas/watch_decision.schema.json", templates.schema(), 0o644],
    ["agent/schemas/bootstrap_conversation_turn.schema.json", templates.bootstrapConversationTurnSchema(), 0o644],
    ["agent/schemas/bootstrap_instantiation.schema.json", templates.bootstrapInstantiationSchema(), 0o644],
    ["agent/schemas/state.schema.json", templates.stateSchema(), 0o644],
    ["agent/schemas/task_box.schema.json", templates.taskBoxSchema(), 0o644],
    ["agent/schemas/route_canonical.schema.json", templates.routeCanonicalSchema(), 0o644],
    ["agent/schemas/secondary_skills.schema.json", templates.secondarySkillsSchema(), 0o644],
    ["agent/schemas/job.schema.json", templates.jobSchema(), 0o644],
    ["agent/schemas/gate.schema.json", templates.gateSchema(), 0o644],
    ["project_index/README.md", templates.projectIndexReadme(), 0o644],
    ["project_index/schema/README.md", templates.projectIndexSchemaReadme(), 0o644],
    ["project_index/schema/enums.json", templates.projectIndexEnums(), 0o644],
    ["project_index/schema/document_index.schema.json", templates.projectIndexDocumentSchema(), 0o644],
    ["project_index/schema/experiment_index.schema.json", templates.projectIndexExperimentSchema(), 0o644],
    ["project_index/schema/current_conclusions.schema.json", templates.projectIndexCurrentConclusionsSchema(), 0o644],
    ["agent/TASK_BOX.json", templates.taskBoxJson(), 0o644],
    ["agent/ROUTE_CANONICAL.json", templates.routeCanonicalJson(), 0o644],
    ["agent/EVIDENCE_LEDGER.jsonl", templates.evidenceLedgerJsonl(), 0o644],
    ["agent/SECONDARY_SKILLS.example.json", templates.secondarySkillsExample(), 0o644],
    ["agent/bin/collect_status.sh", templates.collectStatus(root), 0o755],
    ["agent/bin/make_prompt.sh", templates.makePrompt(root), 0o755],
    ["agent/bin/run_watchdog.sh", templates.runWatchdog(root), 0o755],
    ["agent/bin/watchdog", templates.watchdogCli(root), 0o755],
    ["agent/bin/watchdog_timer.sh", templates.watchdogTimer(root), 0o755],
    ["agent/bin/watchdog_guard.sh", templates.watchdogGuard(root), 0o755],
    ["agent/bin/render_report.py", templates.renderReport(), 0o755],
    ["agent/bin/route_skill.py", templates.routeSkill(), 0o755],
    ["agent/bin/validate_runtime.py", templates.validateRuntime(), 0o755],
    ["agent/bin/validate_watchdog_index.py", templates.validateWatchdogIndex(), 0o755],
    ["agent/bin/watchdog_doc_search.py", templates.watchdogDocSearch(), 0o755],
    ...generatedSkillEntries(templates)
  ];
}

function demoProjectSeedEntries(templates) {
  return [
    ["README.md", templates.demoReadme()],
    ["logs/train.log", templates.demoTrainLog()]
  ];
}

function demoProjectOverlayEntries(templates) {
  return [
    ["agent/DAILY_HANDOFF.md", templates.demoDailyHandoff()],
    ["agent/PLAN.md", templates.demoPlan()],
    ["agent/TODO.md", templates.demoTodo()],
    ["agent/STATE.md", templates.demoState()],
    ["agent/SAFETY.md", templates.demoSafety()]
  ];
}

module.exports = {
  bootstrapScaffoldEntries,
  collaborationHandoffEntries,
  dailyHandoffEntries,
  generatedSkillEntries,
  generatedWatcherEntries,
  demoProjectSeedEntries,
  demoProjectOverlayEntries
};
