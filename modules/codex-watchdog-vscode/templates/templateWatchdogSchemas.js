"use strict";

const successorProvenanceSchema = {
  type: "object",
  properties: {
    artifact_role: { type: ["string", "null"] },
    source: { type: ["string", "null"] },
    repair_origin: { type: ["string", "null"] },
    generated_by: { type: ["string", "null"] },
    derived_from_report: {
      type: ["object", "null"],
      properties: {
        path: { type: ["string", "null"] },
        timestamp_utc: { type: ["string", "null"] },
        report_type: { type: ["string", "null"] }
      },
      additionalProperties: true
    },
    parent_route_id: { type: ["string", "null"] },
    parent_route_epoch: { type: ["string", "null"] },
    parent_task_box_id: { type: ["string", "null"] },
    generated_at_utc: { type: ["string", "null"] },
    model_authored: { type: "boolean" },
    route_repair_authored: { type: "boolean" },
    fallback_synthesized: { type: "boolean" }
  },
  additionalProperties: true
};

const successorProvenanceSummarySchema = {
  type: "object",
  properties: {
    successor_task_draft: successorProvenanceSchema,
    task_profile_draft: successorProvenanceSchema,
    queue_request_draft: successorProvenanceSchema
  },
  additionalProperties: true
};

const watchdogSchemaTemplates = {
  schema: () => JSON.stringify({
    type: "object",
    required: [
      "timestamp_utc",
      "overall_status",
      "supervisor_mode",
      "primary_skill",
      "secondary_skills_consulted",
      "skill_route_reason",
      "skill_stop_condition",
      "permission_guardian_result",
      "report_type",
      "progress_changed",
      "no_progress_cycles",
      "recommend_pause",
      "work_cycle_summary",
      "inspection_commands_run",
      "completed_items",
      "running_items",
      "blocked_items",
      "next_safe_action",
      "requires_human_review",
      "review_scope",
      "review_resolver",
      "human_review_reason",
      "forbidden_actions_not_taken",
      "evidence",
      "state_update_markdown",
      "runtime_state_markdown",
      "morning_brief_markdown",
      "ledger_update_markdown",
      "proposal_markdown",
      "report_markdown",
      "document_index_updates",
      "experiment_index_updates",
      "current_conclusion_evidence_search",
      "current_conclusion_update",
      "successor_task_draft",
      "task_profile_draft",
      "queue_request_draft",
      "route_canonical_update",
      "task_box_update"
    ],
    properties: {
      timestamp_utc: { type: "string" },
      overall_status: {
        type: "string",
        enum: ["healthy", "running", "completed", "blocked", "uncertain", "error"]
      },
      supervisor_mode: {
        type: "string",
        enum: ["runner", "light", "audit", "standby"]
      },
      primary_skill: {
        type: "string",
        enum: [
          "watchdog-orchestrator",
          "watchdog-job-queue",
          "watchdog-gate-evaluator",
          "watchdog-report-curator",
          "watchdog-permission-guardian",
          "watchdog-handoff-writer",
          "watchdog-cleanup-auditor"
        ]
      },
      secondary_skills_consulted: {
        type: "array",
        items: { type: "string" }
      },
      skill_route_reason: { type: "string" },
      skill_stop_condition: { type: "string" },
      permission_guardian_result: {
        type: "string",
        enum: ["not_required", "passed", "blocked", "error"]
      },
      report_type: {
        type: "string",
        enum: ["progress", "blocked", "heartbeat", "error", "recommend_pause"]
      },
      progress_changed: { type: "boolean" },
      no_progress_cycles: { type: "integer", minimum: 0 },
      recommend_pause: { type: "boolean" },
      work_cycle_summary: { type: "string" },
      inspection_commands_run: { type: "array", items: { type: "string" } },
      completed_items: { type: "array", items: { type: "string" } },
      running_items: { type: "array", items: { type: "string" } },
      blocked_items: { type: "array", items: { type: "string" } },
      next_safe_action: {
        type: "object",
        required: ["kind", "description", "can_execute_automatically", "reason"],
        properties: {
          kind: {
            type: "string",
            enum: ["none", "report_only", "propose_review", "safe_script_candidate"]
          },
          description: { type: "string" },
          can_execute_automatically: { type: "boolean" },
          reason: { type: "string" }
        },
        additionalProperties: false
      },
      requires_human_review: { type: "boolean" },
      review_scope: {
        type: "string",
        enum: ["none", "report_only", "bookkeeping", "external_review", "unsafe_operation"]
      },
      review_resolver: {
        type: "string",
        enum: ["none", "supervisor", "human", "external"]
      },
      human_review_reason: { type: "string" },
      forbidden_actions_not_taken: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      state_update_markdown: { type: "string" },
      runtime_state_markdown: { type: "string" },
      morning_brief_markdown: { type: "string" },
      ledger_update_markdown: { type: "string" },
      proposal_markdown: { type: "string" },
      report_markdown: { type: "string" },
      document_index_updates: {
        type: "array",
        items: {
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
            doc_id: { type: "string" },
            path: { type: "string" },
            title: { type: "string" },
            doc_type: {
              type: "string",
              enum: [
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
              ]
            },
            status: {
              type: "string",
              enum: ["active", "draft", "superseded", "deprecated", "archived", "invalidated"]
            },
            evidence_scope: {
              type: "string",
              enum: ["primary_only", "mixed", "auxiliary_only", "none"]
            },
            evidence_scope_note: { type: "string" },
            project_area: { type: "string" },
            summary: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            supersedes: { type: "array", items: { type: "string" } },
            superseded_by: { type: "array", items: { type: "string" } },
            created_at: { type: ["string", "null"] },
            updated_at: { type: ["string", "null"] },
            checksum: { type: ["string", "null"] },
            checksum_scope: { type: ["string", "null"], enum: ["raw_file_bytes", null] },
            indexed_at: { type: ["string", "null"] }
          },
          additionalProperties: false
        }
      },
      experiment_index_updates: {
        type: "array",
        items: {
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
            experiment_id: { type: "string" },
            experiment_type: { type: "string" },
            status: {
              type: "string",
              enum: ["active", "draft", "superseded", "deprecated", "archived", "invalidated"]
            },
            evidence_scope: {
              type: "string",
              enum: ["primary_only", "mixed", "auxiliary_only", "none"]
            },
            name: { type: "string" },
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
                  name: { type: "string" },
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
        }
      },
      current_conclusion_evidence_search: {
        type: ["object", "null"],
        required: ["query", "decision", "warnings", "read_plan_paths"],
        properties: {
          query: { type: "string" },
          decision: {
            type: "string",
            enum: [
              "safe_to_answer",
              "insufficient_primary_evidence",
              "only_auxiliary_found",
              "stale_conclusion",
              "conflicting_evidence",
              "no_index_hit",
              "index_error"
            ]
          },
          warnings: { type: "array", items: { type: "string" } },
          read_plan_paths: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      current_conclusion_update: {
        type: ["object", "null"],
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
          topic_id: { type: "string" },
          topic: { type: "string" },
          conclusion_status: { type: "string", enum: ["confirmed", "tentative", "auxiliary_only", "invalidated"] },
          claim: { type: "string" },
          evidence_scope: { type: "string", enum: ["primary_only", "mixed", "auxiliary_only", "none"] },
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
      },
      successor_task_draft: { type: ["object", "null"], additionalProperties: true },
      task_profile_draft: { type: ["object", "null"], additionalProperties: true },
      queue_request_draft: { type: ["object", "null"], additionalProperties: true },
      route_canonical_update: { type: ["object", "null"], additionalProperties: true },
      task_box_update: { type: ["object", "null"], additionalProperties: true }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  stateSchema: () => JSON.stringify({
    type: "object",
    required: ["schema_version", "mode", "requires_review", "tasks", "blocked_actions", "important_paths"],
    properties: {
      schema_version: { type: "integer" },
      updated_utc: { type: ["string", "null"] },
      mode: { type: "string", enum: ["observer", "project-local-worker", "gpu-queue-worker", "maintainer"] },
      requires_review: { type: "boolean" },
      active_task_id: { type: ["string", "null"] },
      route_task_id: { type: ["string", "null"] },
      active_branch: { type: ["string", "null"] },
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["task_id", "status", "allowed_runner"],
          properties: {
            task_id: { type: "string" },
            status: { type: "string", enum: ["pending", "queued", "running", "done", "failed", "rejected", "blocked"] },
            allowed_runner: { type: "string", enum: ["cpu", "gpu", "report_only"] },
            inputs: { type: "array", items: { type: "string" } },
            outputs: { type: "array", items: { type: "string" } },
            success_gates: { type: "array" },
            stop_conditions: { type: "array", items: { type: "string" } },
            next_allowed_tasks: { type: "array", items: { type: "string" } },
            requires_review_after: { type: "boolean" },
            provenance: successorProvenanceSchema
          },
          additionalProperties: true
        }
      },
      latest_completed_job: { type: ["string", "null"] },
      latest_gate_result: { type: ["object", "null"] },
      allowed_next_action: { type: "string" },
      blocked_actions: { type: "array", items: { type: "string" } },
      exact_next_task_id: { type: ["string", "null"] },
      exact_profile_path: { type: ["string", "null"] },
      exact_queue_draft_path: { type: ["string", "null"] },
      exact_next_object_path: { type: ["string", "null"] },
      required_successor_exactness: { type: "string" },
      successor_materialization_status: { type: "string" },
      experiment_gate_status: { type: "string" },
      experiment_decision_gate_required: { type: "boolean" },
      experiment_decision_gate_blocking: { type: "boolean" },
      successor_provenance: successorProvenanceSummarySchema,
      owner_mode: { type: ["string", "null"] },
      current_allowed_step: { type: ["string", "null"] },
      important_paths: { type: "array", items: { type: "string" } }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  taskBoxSchema: () => JSON.stringify({
    type: "object",
    required: [
      "schema_version",
      "task_box_id",
      "route_id",
      "route_epoch",
      "requires_review",
      "allowed_actions",
      "blocked_actions",
      "allowed_write_paths",
      "queue_policy",
      "tasks"
    ],
    properties: {
      schema_version: { type: "integer" },
      updated_utc: { type: ["string", "null"] },
      owner: { type: "string" },
      task_box_id: { type: "string" },
      route_id: { type: "string" },
      route_epoch: { type: "string" },
      owner_mode: { type: ["string", "null"] },
      current_allowed_step: { type: ["string", "null"] },
      successor_contract_required: { type: "boolean" },
      active_task_id: { type: ["string", "null"] },
      route_task_id: { type: ["string", "null"] },
      exact_next_task_id: { type: ["string", "null"] },
      exact_profile_path: { type: ["string", "null"] },
      exact_queue_draft_path: { type: ["string", "null"] },
      exact_next_object_path: { type: ["string", "null"] },
      required_successor_exactness: { type: "string" },
      successor_materialization_status: { type: "string" },
      experiment_gate_status: { type: "string" },
      experiment_decision_gate_required: { type: "boolean" },
      experiment_decision_gate_blocking: { type: "boolean" },
      successor_provenance: successorProvenanceSummarySchema,
      active_target: { type: "string" },
      project_question: { type: "string" },
      decision_relevance: { type: "string" },
      uncertainty_reduced_if_success: { type: "string" },
      uncertainty_reduced_if_failure: { type: "string" },
      claim_scope: { type: "string" },
      current_conclusion_topic_id: { type: ["string", "null"] },
      current_conclusion_query: { type: ["string", "null"] },
      forbidden_conclusions: { type: "array", items: { type: "string" } },
      diagnosis_target: { type: "string" },
      fair_comparability: { type: "object" },
      value_of_information: { type: "object" },
      gate_policy: { type: "object" },
      requires_review: { type: "boolean" },
      allowed_actions: { type: "array", items: { type: "string" } },
      blocked_actions: { type: "array", items: { type: "string" } },
      success_gates: { type: "array", items: { type: "string" } },
      stop_conditions: { type: "array", items: { type: "string" } },
      allowed_write_paths: { type: "array", items: { type: "string" } },
      allowed_commands: { type: "array", items: { type: "string" } },
      queue_policy: { type: "object" },
      review_required_when: { type: "array", items: { type: "string" } },
      morning_brief_questions: { type: "array", items: { type: "string" } },
      tasks: { type: "array", items: { type: "object" } }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  routeCanonicalSchema: () => JSON.stringify({
    type: "object",
    required: [
      "schema_version",
      "route_id",
      "route_epoch",
      "owner_mode",
      "requires_review"
    ],
    properties: {
      schema_version: { type: "integer" },
      updated_utc: { type: ["string", "null"] },
      route_id: { type: "string" },
      route_epoch: { type: "string" },
      macro_goal: { type: "string" },
      active_ladder: { type: ["array", "string"] },
      current_allowed_step: { type: ["string", "null"] },
      blocked_downstream_steps: { type: "array", items: { type: "string" } },
      current_budget_contract: { type: "string" },
      main_provider_contract: { type: "string" },
      promotion_gates: { type: "array", items: { type: "string" } },
      owner_mode: { type: "string" },
      successor_contract_required: { type: "boolean" },
      requires_review: { type: "boolean" },
      active_task_id: { type: ["string", "null"] },
      exact_next_task_id: { type: ["string", "null"] },
      exact_profile_path: { type: ["string", "null"] },
      exact_queue_draft_path: { type: ["string", "null"] },
      exact_next_object_path: { type: ["string", "null"] },
      required_successor_exactness: { type: "string" },
      successor_materialization_status: { type: "string" },
      experiment_gate_status: { type: "string" },
      experiment_decision_gate_required: { type: "boolean" },
      experiment_decision_gate_blocking: { type: "boolean" },
      successor_provenance: successorProvenanceSummarySchema,
      current_conclusion_topic_id: { type: ["string", "null"] },
      current_conclusion_query: { type: ["string", "null"] }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  secondarySkillsSchema: () => JSON.stringify({
    type: "object",
    required: ["schema_version", "skills"],
    properties: {
      schema_version: { type: "integer" },
      skills: {
        type: "array",
        items: {
          type: "object",
          required: ["skill_id", "path", "selectors"],
          properties: {
            skill_id: { type: "string" },
            enabled: { type: "boolean" },
            required: { type: "boolean" },
            path: { type: "string" },
            notes: { type: "string" },
            selectors: {
              type: "object",
              properties: {
                primary_skills: { type: "array", items: { type: "string" } },
                roles: { type: "array", items: { type: "string" } },
                supervisor_modes: { type: "array", items: { type: "string" } },
                task_capabilities: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }, null, 2) + "\n",

  jobSchema: () => JSON.stringify({
    type: "object",
    required: ["job_id", "task_id", "created_utc", "runner", "command_profile", "expected_outputs", "max_runtime_minutes"],
    properties: {
      job_id: { type: "string" },
      task_id: { type: "string" },
      created_utc: { type: "string" },
      runner: { type: "string", enum: ["cpu", "gpu", "report_only"] },
      requested_gpu: { type: ["string", "integer", "null"] },
      command_profile: { type: "string" },
      command: { type: ["string", "null"] },
      expected_outputs: { type: "array", items: { type: "string" } },
      max_runtime_minutes: { type: "integer", minimum: 1 },
      status: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] },
      log_path: { type: ["string", "null"] }
    },
    additionalProperties: true
  }, null, 2) + "\n",

  gateSchema: () => JSON.stringify({
    type: "object",
    required: ["gates"],
    properties: {
      gates: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "path", "field", "op", "value"],
          properties: {
            name: { type: "string" },
            path: { type: "string" },
            field: { type: "string" },
            op: { type: "string", enum: [">", ">=", "<", "<=", "==", "!="] },
            value: {}
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  }, null, 2) + "\n"
};

module.exports = {
  watchdogSchemaTemplates
};
