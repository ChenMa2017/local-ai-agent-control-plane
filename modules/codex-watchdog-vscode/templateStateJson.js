"use strict";
const stateJsonTemplates = {
  stateJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    mode: "observer",
    requires_review: false,
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    active_task_id: null,
    route_task_id: null,
    active_branch: null,
    tasks: [],
    latest_completed_job: null,
    latest_gate_result: null,
    allowed_next_action: "report_only",
    blocked_actions: [],
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap",
    important_paths: [
      "agent/PLAN.md",
      "agent/TODO.md",
      "agent/STATE.md",
      "agent/SAFETY.md"
    ]
  }, null, 2) + "\n",

  progressStateJson: () => JSON.stringify({
    last_progress_at: null,
    no_progress_cycles: 0,
    last_report_type: "heartbeat",
    current_blocker: "",
    recommend_pause: false,
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    active_task_id: null,
    route_task_id: null,
    task_box_id: "bootstrap-taskbox",
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap"
  }, null, 2) + "\n",

  taskBoxJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    owner: "Codex",
    task_box_id: "bootstrap-taskbox",
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap",
    successor_contract_required: false,
    active_task_id: null,
    route_task_id: null,
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    active_target: "Define the first concrete watchdog mission before unattended runs.",
    project_question: "What bounded watchdog setup or research question is this task box directly helping answer?",
    decision_relevance: "This task box should reduce one concrete uncertainty that changes the next route decision.",
    uncertainty_reduced_if_success: "A successful bounded cycle should make the next route decision narrower and more concrete.",
    uncertainty_reduced_if_failure: "A failed bounded cycle should still clarify whether the current route should continue, pause, or switch.",
    claim_scope: "bootstrap_setup",
    forbidden_conclusions: [
      "Do not treat setup-only work as a project-level research conclusion.",
      "Do not promote local draft preparation into a shared-source or final quality claim."
    ],
    diagnosis_target: "watchdog bootstrap readiness",
    fair_comparability: {
      same_family_or_not: "not_applicable",
      same_budget_or_not: "not_applicable",
      same_training_contract_or_not: "not_applicable",
      same_eval_contract_or_not: "not_applicable"
    },
    value_of_information: {
      expected_information_gain: "high",
      decision_change_if_positive: "The watchdog project can move from setup into one bounded autonomous cycle.",
      decision_change_if_negative: "The watchdog project should remain in draft/setup mode until the missing contract is repaired.",
      cheaper_alternative_exists: false
    },
    gate_policy: {
      topic_alignment_check: true,
      claim_scope_gate: true,
      fair_comparability_gate: true,
      value_of_information_gate: true,
      successor_contract_gate: true,
      causal_path_verification: "advisory",
      enforcement: "repair_locally"
    },
    requires_review: false,
    allowed_actions: [
      "report_only",
      "local_workspace_copy",
      "bounded_cpu_eval",
      "state_reconcile",
      "stale_marker_cleanup",
      "local_profile_authoring",
      "local_queue_draft_authoring"
    ],
    blocked_actions: [
      "direct_gpu_execution",
      "shared_source_edit",
      "dataset_mutation",
      "checkpoint_mutation",
      "promotion_apply",
      "external_send"
    ],
    success_gates: [
      "one bounded watchdog cycle completes with compact state updates",
      "shared files outside allowed local/state paths are untouched"
    ],
    stop_conditions: [
      "finish one bounded step and refresh compact watchdog state",
      "if the next step would change shared facts or external state, switch to review-required"
    ],
    allowed_write_paths: [
      "agent/status/",
      "agent/reports/",
      "agent/logs/",
      "agent/pending/",
      "agent/task_profiles/",
      "workspace/",
      "runs/"
    ],
    allowed_commands: [],
    queue_policy: {
      gpu: "queue_only",
      max_new_jobs_per_wakeup: 1,
      allow_conditional_enqueue: false
    },
    review_required_when: [
      "shared-source edit or promotion",
      "dataset/checkpoint mutation",
      "external send",
      "direct GPU shell execution"
    ],
    morning_brief_questions: [
      "What did watchdog complete autonomously?",
      "What still needs human approval?"
    ],
    tasks: []
  }, null, 2) + "\n",

  routeCanonicalJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    macro_goal: "Bootstrap a bounded watchdog project before unattended execution.",
    active_ladder: ["bootstrap"],
    current_allowed_step: "bootstrap",
    blocked_downstream_steps: [],
    current_budget_contract: "one bounded wakeup per cycle",
    main_provider_contract: "local Codex watchdog",
    promotion_gates: [
      "human review for shared-source promotion",
      "human review for external send"
    ],
    owner_mode: "fully_autonomous",
    successor_contract_required: false,
    requires_review: false,
    active_task_id: null,
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false
  }, null, 2) + "\n",

  evidenceLedgerJsonl: () => "",

  runStateJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: null,
    role: "runner",
    supervisor_mode: "runner",
    route_id: "bootstrap-route",
    route_epoch: "bootstrap-000",
    task_box_id: "bootstrap-taskbox",
    runner_run_count: null,
    runner_started_count: null,
    supervisor_audit_every_runner_runs: null,
    status: "unknown",
    primary_skill: null,
    report_type: null,
    progress_changed: false,
    active_task_id: null,
    blocker_type: "none",
    requires_human_review: false,
    exact_next_task_id: null,
    exact_profile_path: null,
    exact_queue_draft_path: null,
    exact_next_object_path: null,
    required_successor_exactness: "task_only",
    successor_materialization_status: "missing",
    experiment_gate_status: "not_required",
    experiment_decision_gate_required: false,
    experiment_decision_gate_blocking: false,
    owner_mode: "fully_autonomous",
    current_allowed_step: "bootstrap",
    next_action: {
      kind: "none",
      description: "",
      can_execute_automatically: false,
      reason: ""
    },
    evidence: []
  }, null, 2) + "\n",

  workspaceWritePolicyExample: () => JSON.stringify({
    enabled: false,
    writable_paths: [
      "agent/tmp/",
      "outputs/probes/"
    ],
    allowed_commands: [
      "python3 tools/example_probe.py"
    ]
  }, null, 2) + "\n",

  secondarySkillsExample: () => JSON.stringify({
    schema_version: 1,
    skills: [
      {
        skill_id: "project-research-support",
        enabled: true,
        path: "agent/skills/project-secondary-example/SKILL.example.md",
        selectors: {
          primary_skills: ["watchdog-orchestrator", "watchdog-gate-evaluator"],
          roles: ["runner"],
          supervisor_modes: [],
          task_capabilities: ["report_only", "bounded_cpu_eval"]
        },
        notes: "Example project-local support skill: refine evidence hygiene, comparability checks, or reviewer packaging without changing runtime authority."
      }
    ]
  }, null, 2) + "\n",
};
module.exports = {
  stateJsonTemplates
};
