"use strict";

const sharedEnums = {
  doc_type: [
    "official_conclusion",
    "formal_report",
    "requirement",
    "execution_plan",
    "experiment_card",
    "primary_result",
    "smoke_result",
    "bounded_experiment",
    "daily_log",
    "meeting_minutes",
    "auxiliary_diagnostic",
    "debug_note",
    "in_progress",
    "legacy_note",
    "unknown"
  ],
  status: [
    "active",
    "draft",
    "superseded",
    "deprecated",
    "archived",
    "invalidated"
  ],
  evidence_scope: [
    "primary_only",
    "mixed",
    "auxiliary_only",
    "none"
  ],
  conclusion_status: [
    "confirmed",
    "tentative",
    "auxiliary_only",
    "invalidated"
  ],
  search_decision: [
    "safe_to_answer",
    "insufficient_primary_evidence",
    "only_auxiliary_found",
    "stale_conclusion",
    "conflicting_evidence",
    "no_index_hit",
    "index_error"
  ],
  checksum_scope: ["raw_file_bytes"]
};

const watchdogEvidenceSchemaTemplates = {
  projectIndexEnums: () => `${JSON.stringify(sharedEnums, null, 2)}\n`,

  projectIndexDocumentSchema: () => `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "document_index.jsonl line schema",
    type: "object",
    required: [
      "doc_id",
      "path",
      "title",
      "doc_type",
      "status",
      "evidence_scope",
      "evidence_scope_note",
      "project_area",
      "summary",
      "tags",
      "supersedes",
      "superseded_by",
      "created_at",
      "updated_at",
      "checksum",
      "checksum_scope",
      "indexed_at"
    ],
    properties: {
      doc_id: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      doc_type: { type: "string", enum: sharedEnums.doc_type },
      status: { type: "string", enum: sharedEnums.status },
      evidence_scope: { type: "string", enum: sharedEnums.evidence_scope },
      evidence_scope_note: { type: "string" },
      project_area: { type: "string" },
      summary: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      supersedes: { type: "array", items: { type: "string" } },
      superseded_by: { type: "array", items: { type: "string" } },
      created_at: { type: ["string", "null"] },
      updated_at: { type: ["string", "null"] },
      checksum: { type: ["string", "null"] },
      checksum_scope: { type: "string", enum: sharedEnums.checksum_scope },
      indexed_at: { type: ["string", "null"] }
    },
    additionalProperties: false
  }, null, 2)}\n`,

  projectIndexExperimentSchema: () => `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "experiment_index.jsonl line schema",
    type: "object",
    required: [
      "experiment_id",
      "experiment_type",
      "status",
      "evidence_scope",
      "name",
      "purpose",
      "model",
      "baseline_model",
      "train_data",
      "test_data",
      "eval_protocol",
      "with_definition",
      "without_definition",
      "primary_metrics",
      "primary_metric_name",
      "best_epoch",
      "primary_eval_path",
      "config_path",
      "code_commit",
      "run_id",
      "official_conclusion_doc"
    ],
    properties: {
      experiment_id: { type: "string", minLength: 1 },
      experiment_type: { type: "string", minLength: 1 },
      status: { type: "string", enum: sharedEnums.status },
      evidence_scope: { type: "string", enum: sharedEnums.evidence_scope },
      name: { type: "string", minLength: 1 },
      purpose: { type: "string" },
      model: { type: ["string", "null"] },
      baseline_model: { type: ["string", "null"] },
      train_data: { type: ["string", "null"] },
      test_data: { type: ["string", "null"] },
      eval_protocol: { type: ["string", "null"] },
      with_definition: { type: ["string", "null"] },
      without_definition: { type: ["string", "null"] },
      primary_metrics: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "value", "higher_is_better"],
          properties: {
            name: { type: "string", minLength: 1 },
            value: { type: ["number", "null"] },
            higher_is_better: { type: "boolean" },
            notes: { type: ["string", "null"] }
          },
          additionalProperties: false
        }
      },
      primary_metric_name: { type: ["string", "null"] },
      best_epoch: { type: ["integer", "null"] },
      primary_eval_path: { type: ["string", "null"] },
      config_path: { type: ["string", "null"] },
      code_commit: { type: ["string", "null"] },
      run_id: { type: ["string", "null"] },
      official_conclusion_doc: { type: ["string", "null"] }
    },
    additionalProperties: false
  }, null, 2)}\n`,

  projectIndexCurrentConclusionsSchema: () => `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "current_conclusions.json schema",
    type: "object",
    required: ["schema_version", "updated_at", "items"],
    properties: {
      schema_version: { type: "string", const: "current_conclusions.v0.1" },
      updated_at: { type: ["string", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          required: [
            "topic_id",
            "topic",
            "conclusion_status",
            "claim",
            "evidence_scope",
            "supporting_docs",
            "supporting_experiments",
            "last_reviewed_at",
            "stale_after_days",
            "stale_severity",
            "owner",
            "invalidated_by",
            "risk_flags"
          ],
          properties: {
            topic_id: { type: "string", minLength: 1 },
            topic: { type: "string", minLength: 1 },
            conclusion_status: { type: "string", enum: sharedEnums.conclusion_status },
            claim: { type: "string", minLength: 1 },
            evidence_scope: { type: "string", enum: sharedEnums.evidence_scope },
            supporting_docs: { type: "array", items: { type: "string" } },
            supporting_experiments: { type: "array", items: { type: "string" } },
            last_reviewed_at: { type: ["string", "null"] },
            stale_after_days: { type: ["integer", "null"], minimum: 0 },
            stale_severity: { type: ["string", "null"] },
            owner: { type: ["string", "null"] },
            invalidated_by: { type: ["string", "null"] },
            risk_flags: { type: "array", items: { type: "string" } }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }, null, 2)}\n`,

  researchProgramSchema: () => `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "research/RESEARCH_PROGRAM.json schema",
    type: "object",
    required: [
      "schema_version",
      "program_id",
      "created_at",
      "updated_at",
      "owner",
      "domain",
      "research_goal",
      "metrics",
      "data_policy",
      "baseline_policy",
      "autonomy_policy",
      "resource_budget",
      "evidence_policy",
      "conclusion_policy",
      "stop_conditions",
      "system_state"
    ],
    properties: {
      schema_version: { type: "string", const: "research_program.v0.1" },
      program_id: { type: "string", minLength: 1 },
      created_at: { type: ["string", "null"] },
      updated_at: { type: ["string", "null"] },
      owner: {
        type: "object",
        required: ["human_owner", "supervisor_role", "default_runner_role"],
        properties: {
          human_owner: { type: "string", minLength: 1 },
          supervisor_role: { type: "string", minLength: 1 },
          default_runner_role: { type: "string", minLength: 1 }
        },
        additionalProperties: false
      },
      domain: {
        type: "object",
        required: [
          "name",
          "primary_question",
          "allowed_project_areas",
          "forbidden_project_areas",
          "out_of_scope_requests"
        ],
        properties: {
          name: { type: "string", minLength: 1 },
          primary_question: { type: "string", minLength: 1 },
          allowed_project_areas: { type: "array", items: { type: "string", minLength: 1 } },
          forbidden_project_areas: { type: "array", items: { type: "string", minLength: 1 } },
          out_of_scope_requests: { type: "array", items: { type: "string", minLength: 1 } }
        },
        additionalProperties: false
      },
      research_goal: {
        type: "object",
        required: ["primary_goal", "decision_target", "non_goals", "deliverables"],
        properties: {
          primary_goal: { type: "string", minLength: 1 },
          decision_target: { type: "string", minLength: 1 },
          non_goals: { type: "array", items: { type: "string", minLength: 1 } },
          deliverables: { type: "array", items: { type: "string", minLength: 1 } }
        },
        additionalProperties: false
      },
      metrics: {
        type: "object",
        required: ["primary", "guardrail"],
        properties: {
          primary: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["name", "higher_is_better", "required_for_claim"],
              properties: {
                name: { type: "string", minLength: 1 },
                higher_is_better: { type: "boolean" },
                required_for_claim: { type: "boolean" }
              },
              additionalProperties: false
            }
          },
          guardrail: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "higher_is_better", "required_for_claim"],
              properties: {
                name: { type: "string", minLength: 1 },
                higher_is_better: { type: "boolean" },
                required_for_claim: { type: "boolean" }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      },
      data_policy: {
        type: "object",
        required: [
          "allowed_datasets",
          "restricted_datasets",
          "evaluation_split_policy",
          "pii_policy"
        ],
        properties: {
          allowed_datasets: { type: "array", items: { type: "string", minLength: 1 } },
          restricted_datasets: { type: "array", items: { type: "string", minLength: 1 } },
          evaluation_split_policy: { type: "string", minLength: 1 },
          pii_policy: { type: "string", minLength: 1 }
        },
        additionalProperties: false
      },
      baseline_policy: {
        type: "object",
        required: ["required", "baseline_entities", "comparison_rule"],
        properties: {
          required: { type: "boolean" },
          baseline_entities: { type: "array", items: { type: "string", minLength: 1 } },
          comparison_rule: { type: "string", minLength: 1 }
        },
        additionalProperties: false
      },
      autonomy_policy: {
        type: "object",
        required: ["mode", "allowed_task_types", "forbidden_task_types", "human_review_triggers"],
        properties: {
          mode: { type: "string", minLength: 1 },
          allowed_task_types: { type: "array", items: { type: "string", minLength: 1 } },
          forbidden_task_types: { type: "array", items: { type: "string", minLength: 1 } },
          human_review_triggers: { type: "array", items: { type: "string", minLength: 1 } }
        },
        additionalProperties: false
      },
      resource_budget: {
        type: "object",
        required: [
          "max_parallel_experiments",
          "max_runtime_hours_per_experiment",
          "max_token_budget_per_cycle",
          "requires_budget_check_before_new_run"
        ],
        properties: {
          max_parallel_experiments: { type: "integer", minimum: 1 },
          max_runtime_hours_per_experiment: { type: ["number", "null"], minimum: 0 },
          max_token_budget_per_cycle: { type: ["integer", "null"], minimum: 0 },
          requires_budget_check_before_new_run: { type: "boolean" }
        },
        additionalProperties: false
      },
      evidence_policy: {
        type: "object",
        required: [
          "require_primary_evidence_for_confirmed_claims",
          "allow_auxiliary_notes",
          "require_index_entry_for_cited_files",
          "require_current_conclusions_update_for_new_claims"
        ],
        properties: {
          require_primary_evidence_for_confirmed_claims: { type: "boolean" },
          allow_auxiliary_notes: { type: "boolean" },
          require_index_entry_for_cited_files: { type: "boolean" },
          require_current_conclusions_update_for_new_claims: { type: "boolean" }
        },
        additionalProperties: false
      },
      conclusion_policy: {
        type: "object",
        required: [
          "allowed_conclusion_statuses",
          "require_staleness_tracking",
          "require_invalidation_path",
          "publish_only_after_review"
        ],
        properties: {
          allowed_conclusion_statuses: { type: "array", items: { type: "string", minLength: 1 } },
          require_staleness_tracking: { type: "boolean" },
          require_invalidation_path: { type: "boolean" },
          publish_only_after_review: { type: "boolean" }
        },
        additionalProperties: false
      },
      stop_conditions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      system_state: {
        type: "object",
        required: ["lifecycle", "current_focus", "next_review_at", "notes"],
        properties: {
          lifecycle: {
            type: "string",
            enum: ["bootstrap", "active", "paused", "blocked", "archived"]
          },
          current_focus: { type: ["string", "null"] },
          next_review_at: { type: ["string", "null"] },
          notes: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }, null, 2)}\n`
};

module.exports = {
  watchdogEvidenceSchemaTemplates
};
