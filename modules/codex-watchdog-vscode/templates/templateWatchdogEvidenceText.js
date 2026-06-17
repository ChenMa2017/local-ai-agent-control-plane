"use strict";

const watchdogEvidenceTextTemplates = {
  projectIndexReadme: () => `# Project Evidence Index

This directory is the metadata-first evidence boundary for watchdog projects.

Use it to decide what the agent should read before it opens large source files or logs.

Read \`research/RESEARCH_PROGRAM.json\` before you expand work beyond simple retrieval. It defines the project's allowed scope, baseline policy, evidence policy, and review boundaries.

Files:

- \`schema/\`: machine-readable contracts and shared enums for the Phase 1 local evidence index
- \`document_index.jsonl\`: document identity, lifecycle, and evidence-scope metadata
- \`experiment_index.jsonl\`: experiment identity, protocol, and result-location metadata
- \`current_conclusions.json\`: current project conclusions that are safe to cite when still supported
- \`golden_queries.json\`: regression queries that protect retrieval behavior over time

Commands:

\`\`\`bash
python3 agent/bin/validate_watchdog_index.py --project-root .
python3 agent/bin/watchdog_doc_search.py --query "current conclusion" --json
\`\`\`

Update discipline:

1. When you add a new durable conclusion, update \`document_index.jsonl\` and \`current_conclusions.json\` in the same change.
2. When you add a new formal experiment result, update \`experiment_index.jsonl\` and any referenced documents in the same change.
3. When a conclusion or report becomes stale, superseded, deprecated, or invalidated, mark that status explicitly instead of leaving old files ambiguous.
4. Prefer metadata-first retrieval. Call \`watchdog_doc_search.py\` before reading many source files when the question asks for a current conclusion, a current best candidate, a comparison claim, or a formal experiment result.
5. When you want a durable \`current_conclusion_update\`, register the exact retrieval query in \`golden_queries.json\` with \`expected_decision: "safe_to_answer"\` so later wakeups can regression-check the same answer path.
`,

  projectIndexSchemaReadme: () => `# Project Evidence Index Schemas

These schemas define the Phase 1 machine-readable evidence contracts for watchdog projects.

Design goals:

1. Keep the index local and auditable.
2. Let the agent decide whether it is safe to answer before it scans large files.
3. Separate document identity, experiment identity, and current conclusions.
4. Make stale, superseded, deprecated, and invalidated states explicit.

Files:

- \`enums.json\`: shared enum values
- \`document_index.schema.json\`: per-line schema for \`document_index.jsonl\`
- \`experiment_index.schema.json\`: per-line schema for \`experiment_index.jsonl\`
- \`current_conclusions.schema.json\`: top-level schema for \`current_conclusions.json\`

Implementation note:

Phase 1 intentionally uses only local files plus Python standard-library tools. The validator enforces the contract directly and does not require a separate schema runtime dependency.

Related file:

- \`../../research/RESEARCH_PROGRAM.json\`: project-level research contract that constrains experiment scope and conclusion policy
`,

  projectIndexDocumentIndex: () => "",

  projectIndexExperimentIndex: () => "",

  projectIndexCurrentConclusions: () => `${JSON.stringify({
    schema_version: "current_conclusions.v0.1",
    updated_at: null,
    items: []
  }, null, 2)}\n`,

  projectIndexGoldenQueries: () => `${JSON.stringify({
    schema_version: "golden_queries.v0.1",
    queries: []
  }, null, 2)}\n`,

  researchProgram: () => `${JSON.stringify({
    schema_version: "research_program.v0.1",
    program_id: "replace_with_project_program_id",
    created_at: null,
    updated_at: null,
    owner: {
      human_owner: "replace_with_owner",
      supervisor_role: "project_owner",
      default_runner_role: "watchdog_agent"
    },
    domain: {
      name: "replace_with_domain_name",
      primary_question: "replace_with_primary_question",
      allowed_project_areas: [],
      forbidden_project_areas: [],
      out_of_scope_requests: []
    },
    research_goal: {
      primary_goal: "replace_with_primary_goal",
      decision_target: "replace_with_decision_target",
      non_goals: [],
      deliverables: []
    },
    metrics: {
      primary: [
        {
          name: "replace_with_metric_name",
          higher_is_better: true,
          required_for_claim: true
        }
      ],
      guardrail: []
    },
    data_policy: {
      allowed_datasets: [],
      restricted_datasets: [],
      evaluation_split_policy: "document_required",
      pii_policy: "no_unreviewed_pii"
    },
    baseline_policy: {
      required: true,
      baseline_entities: [],
      comparison_rule: "no_claim_without_comparable_baseline"
    },
    autonomy_policy: {
      mode: "domain_bounded",
      allowed_task_types: [
        "analysis",
        "experiment_design",
        "bounded_execution",
        "evidence_curation"
      ],
      forbidden_task_types: [
        "unbounded_web_research",
        "production_deployment",
        "destructive_data_mutation"
      ],
      human_review_triggers: [
        "new_dataset",
        "policy_change",
        "deployment_recommendation"
      ]
    },
    resource_budget: {
      max_parallel_experiments: 1,
      max_runtime_hours_per_experiment: null,
      max_token_budget_per_cycle: null,
      requires_budget_check_before_new_run: true
    },
    evidence_policy: {
      require_primary_evidence_for_confirmed_claims: true,
      allow_auxiliary_notes: true,
      require_index_entry_for_cited_files: true,
      require_current_conclusions_update_for_new_claims: true
    },
    conclusion_policy: {
      allowed_conclusion_statuses: [
        "confirmed",
        "tentative",
        "auxiliary_only",
        "invalidated"
      ],
      require_staleness_tracking: true,
      require_invalidation_path: true,
      publish_only_after_review: false
    },
    stop_conditions: [
      "goal_reached_with_primary_evidence",
      "blocked_on_missing_data",
      "blocked_on_human_decision",
      "budget_exhausted"
    ],
    system_state: {
      lifecycle: "bootstrap",
      current_focus: null,
      next_review_at: null,
      notes: []
    }
  }, null, 2)}\n`
};

module.exports = {
  watchdogEvidenceTextTemplates
};
