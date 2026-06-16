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
  }, null, 2)}\n`
};

module.exports = {
  watchdogEvidenceSchemaTemplates
};
