"use strict";

const pythonEvidenceToolTemplates = {
  validateWatchdogIndex: () => `#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Validate a watchdog project evidence contract.")
    parser.add_argument("--project-root", default=".", help="Watchdog project root. Defaults to the current directory.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of plain text.")
    return parser.parse_args()


def parse_timestamp(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string or null")
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def current_time_utc():
    raw = str(os.environ.get("WATCHDOG_FIXED_NOW") or "").strip()
    if raw:
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except Exception:
            pass
    return datetime.now(timezone.utc)


def load_json(path, errors, required=True, default=None):
    if not path.exists():
        if required:
            errors.append(f"missing required JSON file: {path}")
        return default
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        errors.append(f"invalid JSON in {path}: {exc}")
        return default


def load_jsonl(path, errors, required=True):
    if not path.exists():
        if required:
            errors.append(f"missing required JSONL file: {path}")
        return []
    records = []
    for lineno, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except Exception as exc:
            errors.append(f"invalid JSONL in {path}:{lineno}: {exc}")
    return records


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_relative_project_path(value):
    if not isinstance(value, str) or not value.strip():
        return False
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts


def is_safe_project_area(value):
    if not isinstance(value, str) or not value.strip():
        return False
    return all(char.isalnum() or char in {"_", "-", "/", "."} for char in value)


def require_nonempty_string(value, label, errors, allow_null=False):
    if allow_null and value in (None, ""):
        return
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{label} must be a nonempty string")


def require_boolean(value, label, errors):
    if not isinstance(value, bool):
        errors.append(f"{label} must be a boolean")


def require_string_array(value, label, errors, allow_empty=True):
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return []
    cleaned = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{label}[{index}] must be a nonempty string")
            continue
        cleaned.append(item)
    if not allow_empty and not cleaned:
        errors.append(f"{label} must not be empty")
    return cleaned


def validate_metric_specs(value, label, errors, allow_empty=False):
    if not isinstance(value, list):
        errors.append(f"{label} must be an array")
        return []
    if not allow_empty and not value:
        errors.append(f"{label} must not be empty")
    validated = []
    for index, metric in enumerate(value):
        metric_label = f"{label}[{index}]"
        if not isinstance(metric, dict):
            errors.append(f"{metric_label} must be an object")
            continue
        require_nonempty_string(metric.get("name"), f"{metric_label}.name", errors)
        require_boolean(metric.get("higher_is_better"), f"{metric_label}.higher_is_better", errors)
        require_boolean(metric.get("required_for_claim"), f"{metric_label}.required_for_claim", errors)
        if isinstance(metric.get("name"), str) and metric.get("name").strip():
            validated.append(metric.get("name"))
    return validated


def add_warning_if_stale(conclusion, warnings):
    reviewed = conclusion.get("last_reviewed_at")
    stale_after = conclusion.get("stale_after_days")
    if reviewed in (None, "") or stale_after in (None, ""):
        return
    try:
        reviewed_at = parse_timestamp(reviewed)
    except Exception:
        return
    if not isinstance(stale_after, int) or stale_after < 0:
        return
    now = current_time_utc()
    if reviewed_at.tzinfo is None:
        reviewed_at = reviewed_at.replace(tzinfo=timezone.utc)
    if now >= reviewed_at + timedelta(days=stale_after):
        warnings.append(f"current conclusion is stale: {conclusion.get('topic_id') or conclusion.get('topic')}")


def validate_research_program(research_program, errors):
    policy = {
        "allowed_project_areas": set(),
        "forbidden_project_areas": set(),
        "baseline_required": False,
        "allowed_conclusion_statuses": set(),
        "require_primary_evidence_for_confirmed_claims": False,
    }
    if not isinstance(research_program, dict):
        errors.append("research/RESEARCH_PROGRAM.json must be an object")
        return policy
    if research_program.get("schema_version") != "research_program.v0.1":
        errors.append("research/RESEARCH_PROGRAM.json schema_version must be research_program.v0.1")
    require_nonempty_string(research_program.get("program_id"), "research_program.program_id", errors)
    for timestamp_field in ("created_at", "updated_at"):
        try:
            parse_timestamp(research_program.get(timestamp_field))
        except Exception:
            errors.append(f"research_program.{timestamp_field} must be ISO-8601 or null")

    owner = research_program.get("owner")
    if not isinstance(owner, dict):
        errors.append("research_program.owner must be an object")
    else:
        require_nonempty_string(owner.get("human_owner"), "research_program.owner.human_owner", errors)
        require_nonempty_string(owner.get("supervisor_role"), "research_program.owner.supervisor_role", errors)
        require_nonempty_string(owner.get("default_runner_role"), "research_program.owner.default_runner_role", errors)

    domain = research_program.get("domain")
    if not isinstance(domain, dict):
        errors.append("research_program.domain must be an object")
    else:
        require_nonempty_string(domain.get("name"), "research_program.domain.name", errors)
        require_nonempty_string(domain.get("primary_question"), "research_program.domain.primary_question", errors)
        allowed_areas = set(require_string_array(domain.get("allowed_project_areas"), "research_program.domain.allowed_project_areas", errors))
        forbidden_areas = set(require_string_array(domain.get("forbidden_project_areas"), "research_program.domain.forbidden_project_areas", errors))
        require_string_array(domain.get("out_of_scope_requests"), "research_program.domain.out_of_scope_requests", errors)
        for area in allowed_areas | forbidden_areas:
            if not is_safe_project_area(area):
                errors.append(f"research_program.domain project area must use a safe label: {area!r}")
        overlap = allowed_areas & forbidden_areas
        if overlap:
            errors.append(f"research_program.domain allowed_project_areas overlaps forbidden_project_areas: {sorted(overlap)!r}")
        policy["allowed_project_areas"] = allowed_areas
        policy["forbidden_project_areas"] = forbidden_areas

    research_goal = research_program.get("research_goal")
    if not isinstance(research_goal, dict):
        errors.append("research_program.research_goal must be an object")
    else:
        require_nonempty_string(research_goal.get("primary_goal"), "research_program.research_goal.primary_goal", errors)
        require_nonempty_string(research_goal.get("decision_target"), "research_program.research_goal.decision_target", errors)
        require_string_array(research_goal.get("non_goals"), "research_program.research_goal.non_goals", errors)
        require_string_array(research_goal.get("deliverables"), "research_program.research_goal.deliverables", errors)

    metrics = research_program.get("metrics")
    if not isinstance(metrics, dict):
        errors.append("research_program.metrics must be an object")
    else:
        validate_metric_specs(metrics.get("primary"), "research_program.metrics.primary", errors, allow_empty=False)
        validate_metric_specs(metrics.get("guardrail"), "research_program.metrics.guardrail", errors, allow_empty=True)

    data_policy = research_program.get("data_policy")
    if not isinstance(data_policy, dict):
        errors.append("research_program.data_policy must be an object")
    else:
        require_string_array(data_policy.get("allowed_datasets"), "research_program.data_policy.allowed_datasets", errors)
        require_string_array(data_policy.get("restricted_datasets"), "research_program.data_policy.restricted_datasets", errors)
        require_nonempty_string(data_policy.get("evaluation_split_policy"), "research_program.data_policy.evaluation_split_policy", errors)
        require_nonempty_string(data_policy.get("pii_policy"), "research_program.data_policy.pii_policy", errors)

    baseline_policy = research_program.get("baseline_policy")
    if not isinstance(baseline_policy, dict):
        errors.append("research_program.baseline_policy must be an object")
    else:
        require_boolean(baseline_policy.get("required"), "research_program.baseline_policy.required", errors)
        require_string_array(baseline_policy.get("baseline_entities"), "research_program.baseline_policy.baseline_entities", errors)
        require_nonempty_string(baseline_policy.get("comparison_rule"), "research_program.baseline_policy.comparison_rule", errors)
        policy["baseline_required"] = bool(baseline_policy.get("required"))

    autonomy_policy = research_program.get("autonomy_policy")
    if not isinstance(autonomy_policy, dict):
        errors.append("research_program.autonomy_policy must be an object")
    else:
        require_nonempty_string(autonomy_policy.get("mode"), "research_program.autonomy_policy.mode", errors)
        allowed_task_types = set(require_string_array(autonomy_policy.get("allowed_task_types"), "research_program.autonomy_policy.allowed_task_types", errors, allow_empty=False))
        forbidden_task_types = set(require_string_array(autonomy_policy.get("forbidden_task_types"), "research_program.autonomy_policy.forbidden_task_types", errors))
        require_string_array(autonomy_policy.get("human_review_triggers"), "research_program.autonomy_policy.human_review_triggers", errors)
        overlap = allowed_task_types & forbidden_task_types
        if overlap:
            errors.append(f"research_program.autonomy_policy allowed_task_types overlaps forbidden_task_types: {sorted(overlap)!r}")

    resource_budget = research_program.get("resource_budget")
    if not isinstance(resource_budget, dict):
        errors.append("research_program.resource_budget must be an object")
    else:
        max_parallel = resource_budget.get("max_parallel_experiments")
        if not isinstance(max_parallel, int) or max_parallel < 1:
            errors.append("research_program.resource_budget.max_parallel_experiments must be an integer >= 1")
        max_runtime = resource_budget.get("max_runtime_hours_per_experiment")
        if max_runtime not in (None, "") and (not isinstance(max_runtime, (int, float)) or max_runtime < 0):
            errors.append("research_program.resource_budget.max_runtime_hours_per_experiment must be a nonnegative number or null")
        max_tokens = resource_budget.get("max_token_budget_per_cycle")
        if max_tokens not in (None, "") and (not isinstance(max_tokens, int) or max_tokens < 0):
            errors.append("research_program.resource_budget.max_token_budget_per_cycle must be a nonnegative integer or null")
        require_boolean(
            resource_budget.get("requires_budget_check_before_new_run"),
            "research_program.resource_budget.requires_budget_check_before_new_run",
            errors,
        )

    evidence_policy = research_program.get("evidence_policy")
    if not isinstance(evidence_policy, dict):
        errors.append("research_program.evidence_policy must be an object")
    else:
        for field in (
            "require_primary_evidence_for_confirmed_claims",
            "allow_auxiliary_notes",
            "require_index_entry_for_cited_files",
            "require_current_conclusions_update_for_new_claims",
        ):
            require_boolean(evidence_policy.get(field), f"research_program.evidence_policy.{field}", errors)
        policy["require_primary_evidence_for_confirmed_claims"] = bool(
            evidence_policy.get("require_primary_evidence_for_confirmed_claims")
        )

    conclusion_policy = research_program.get("conclusion_policy")
    if not isinstance(conclusion_policy, dict):
        errors.append("research_program.conclusion_policy must be an object")
    else:
        policy["allowed_conclusion_statuses"] = set(
            require_string_array(
                conclusion_policy.get("allowed_conclusion_statuses"),
                "research_program.conclusion_policy.allowed_conclusion_statuses",
                errors,
                allow_empty=False,
            )
        )
        require_boolean(
            conclusion_policy.get("require_staleness_tracking"),
            "research_program.conclusion_policy.require_staleness_tracking",
            errors,
        )
        require_boolean(
            conclusion_policy.get("require_invalidation_path"),
            "research_program.conclusion_policy.require_invalidation_path",
            errors,
        )
        require_boolean(
            conclusion_policy.get("publish_only_after_review"),
            "research_program.conclusion_policy.publish_only_after_review",
            errors,
        )

    require_string_array(research_program.get("stop_conditions"), "research_program.stop_conditions", errors, allow_empty=False)

    system_state = research_program.get("system_state")
    if not isinstance(system_state, dict):
        errors.append("research_program.system_state must be an object")
    else:
        lifecycle = system_state.get("lifecycle")
        if lifecycle not in {"bootstrap", "active", "paused", "blocked", "archived"}:
            errors.append("research_program.system_state.lifecycle must be one of bootstrap|active|paused|blocked|archived")
        require_nonempty_string(system_state.get("current_focus"), "research_program.system_state.current_focus", errors, allow_null=True)
        try:
            parse_timestamp(system_state.get("next_review_at"))
        except Exception:
            errors.append("research_program.system_state.next_review_at must be ISO-8601 or null")
        require_string_array(system_state.get("notes"), "research_program.system_state.notes", errors)

    return policy


def main():
    args = parse_args()
    root = Path(args.project_root).resolve()
    index_root = root / "project_index"
    schema_root = index_root / "schema"
    research_root = root / "research"
    research_schema_root = research_root / "schema"

    errors = []
    warnings = []

    enums = load_json(schema_root / "enums.json", errors, required=True, default={}) or {}
    for schema_name in (
        "document_index.schema.json",
        "experiment_index.schema.json",
        "current_conclusions.schema.json",
    ):
        schema_data = load_json(schema_root / schema_name, errors, required=True, default={})
        if isinstance(schema_data, dict) and schema_data.get("type") != "object":
            warnings.append(f"{schema_name} should declare top-level type=object")
    research_program_schema = load_json(research_schema_root / "research_program.schema.json", errors, required=True, default={}) or {}
    if isinstance(research_program_schema, dict) and research_program_schema.get("type") != "object":
        warnings.append("research_program.schema.json should declare top-level type=object")

    doc_records = load_jsonl(index_root / "document_index.jsonl", errors, required=True)
    experiment_records = load_jsonl(index_root / "experiment_index.jsonl", errors, required=True)
    current_conclusions = load_json(index_root / "current_conclusions.json", errors, required=True, default={}) or {}
    golden_queries = load_json(index_root / "golden_queries.json", errors, required=True, default={}) or {}
    research_program = load_json(research_root / "RESEARCH_PROGRAM.json", errors, required=True, default={}) or {}

    valid_doc_types = set(enums.get("doc_type", []))
    valid_status = set(enums.get("status", []))
    valid_evidence_scope = set(enums.get("evidence_scope", []))
    valid_conclusion_status = set(enums.get("conclusion_status", []))
    valid_search_decision = set(enums.get("search_decision", []))
    research_policy = validate_research_program(research_program, errors)

    docs_by_id = {}
    experiments_by_id = {}

    def require_fields(record, fields, label):
        missing = [field for field in fields if field not in record]
        for field in missing:
            errors.append(f"{label} missing required field: {field}")

    for index, record in enumerate(doc_records):
        label = f"document_index[{index}]"
        if not isinstance(record, dict):
            errors.append(f"{label} must be an object")
            continue
        require_fields(record, [
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
            "indexed_at",
        ], label)
        doc_id = record.get("doc_id")
        if not isinstance(doc_id, str) or not doc_id.strip():
            errors.append(f"{label}.doc_id must be a nonempty string")
        elif doc_id in docs_by_id:
            errors.append(f"duplicate doc_id: {doc_id}")
        else:
            docs_by_id[doc_id] = record
        rel_path = record.get("path")
        if not is_relative_project_path(rel_path):
            errors.append(f"{label}.path must be a safe relative path")
            target = None
        else:
            target = root / rel_path
            if not target.exists():
                errors.append(f"{label}.path does not exist: {rel_path}")
        if record.get("doc_type") not in valid_doc_types:
            errors.append(f"{label}.doc_type is invalid: {record.get('doc_type')!r}")
        if record.get("status") not in valid_status:
            errors.append(f"{label}.status is invalid: {record.get('status')!r}")
        if record.get("evidence_scope") not in valid_evidence_scope:
            errors.append(f"{label}.evidence_scope is invalid: {record.get('evidence_scope')!r}")
        project_area = record.get("project_area")
        if not is_safe_project_area(project_area):
            errors.append(f"{label}.project_area must be a safe nonempty label")
        elif research_policy["allowed_project_areas"] and project_area not in research_policy["allowed_project_areas"]:
            errors.append(f"{label}.project_area is outside research_program allowed_project_areas: {project_area!r}")
        if project_area in research_policy["forbidden_project_areas"]:
            errors.append(f"{label}.project_area is forbidden by research_program: {project_area!r}")
        if record.get("checksum_scope") != "raw_file_bytes":
            errors.append(f"{label}.checksum_scope must be raw_file_bytes")
        if not isinstance(record.get("tags"), list):
            errors.append(f"{label}.tags must be an array")
        for field in ("supersedes", "superseded_by"):
            if not isinstance(record.get(field), list):
                errors.append(f"{label}.{field} must be an array")
        checksum = record.get("checksum")
        if target and checksum is not None:
            if not isinstance(checksum, str):
                errors.append(f"{label}.checksum must be a string or null")
            elif checksum != sha256_file(target):
                warnings.append(f"checksum drift for {record.get('path')}")
        for timestamp_field in ("created_at", "updated_at", "indexed_at"):
            try:
                parse_timestamp(record.get(timestamp_field))
            except Exception:
                errors.append(f"{label}.{timestamp_field} must be ISO-8601 or null")

    for index, record in enumerate(experiment_records):
        label = f"experiment_index[{index}]"
        if not isinstance(record, dict):
            errors.append(f"{label} must be an object")
            continue
        require_fields(record, [
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
            "official_conclusion_doc",
        ], label)
        experiment_id = record.get("experiment_id")
        if not isinstance(experiment_id, str) or not experiment_id.strip():
            errors.append(f"{label}.experiment_id must be a nonempty string")
        elif experiment_id in experiments_by_id:
            errors.append(f"duplicate experiment_id: {experiment_id}")
        else:
            experiments_by_id[experiment_id] = record
        if record.get("status") not in valid_status:
            errors.append(f"{label}.status is invalid: {record.get('status')!r}")
        if record.get("evidence_scope") not in valid_evidence_scope:
            errors.append(f"{label}.evidence_scope is invalid: {record.get('evidence_scope')!r}")
        if research_policy["baseline_required"] and record.get("status") == "active" and record.get("baseline_model") in (None, ""):
            errors.append(f"{label}.baseline_model must be set because research_program.baseline_policy.required=true")
        primary_metrics = record.get("primary_metrics")
        if not isinstance(primary_metrics, list):
            errors.append(f"{label}.primary_metrics must be an array")
        else:
            for metric_index, metric in enumerate(primary_metrics):
                metric_label = f"{label}.primary_metrics[{metric_index}]"
                if not isinstance(metric, dict):
                    errors.append(f"{metric_label} must be an object")
                    continue
                for required_field in ("name", "value", "higher_is_better"):
                    if required_field not in metric:
                        errors.append(f"{metric_label} missing required field: {required_field}")
        for path_field in ("primary_eval_path", "config_path"):
            path_value = record.get(path_field)
            if path_value not in (None, ""):
                if not is_relative_project_path(path_value):
                    errors.append(f"{label}.{path_field} must be a safe relative path or null")
                elif not (root / path_value).exists():
                    errors.append(f"{label}.{path_field} does not exist: {path_value}")
        conclusion_doc = record.get("official_conclusion_doc")
        if conclusion_doc not in (None, "") and conclusion_doc not in docs_by_id:
            errors.append(f"{label}.official_conclusion_doc references unknown doc_id: {conclusion_doc}")

    if not isinstance(current_conclusions, dict):
        errors.append("current_conclusions.json must be an object")
        current_conclusions = {}
    if current_conclusions.get("schema_version") != "current_conclusions.v0.1":
        errors.append("current_conclusions.json schema_version must be current_conclusions.v0.1")
    try:
        parse_timestamp(current_conclusions.get("updated_at"))
    except Exception:
        errors.append("current_conclusions.json updated_at must be ISO-8601 or null")
    items = current_conclusions.get("items")
    if not isinstance(items, list):
        errors.append("current_conclusions.json items must be an array")
        items = []
    for index, item in enumerate(items):
        label = f"current_conclusions.items[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        require_fields(item, [
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
            "risk_flags",
        ], label)
        if item.get("conclusion_status") not in valid_conclusion_status:
            errors.append(f"{label}.conclusion_status is invalid: {item.get('conclusion_status')!r}")
        if research_policy["allowed_conclusion_statuses"] and item.get("conclusion_status") not in research_policy["allowed_conclusion_statuses"]:
            errors.append(
                f"{label}.conclusion_status is outside research_program allowed_conclusion_statuses: {item.get('conclusion_status')!r}"
            )
        if item.get("evidence_scope") not in valid_evidence_scope:
            errors.append(f"{label}.evidence_scope is invalid: {item.get('evidence_scope')!r}")
        if not isinstance(item.get("supporting_docs"), list):
            errors.append(f"{label}.supporting_docs must be an array")
        else:
            for doc_id in item.get("supporting_docs", []):
                if doc_id not in docs_by_id:
                    errors.append(f"{label}.supporting_docs references unknown doc_id: {doc_id}")
                elif docs_by_id[doc_id].get("status") == "invalidated":
                    errors.append(f"{label}.supporting_docs references invalidated doc_id: {doc_id}")
        if not isinstance(item.get("supporting_experiments"), list):
            errors.append(f"{label}.supporting_experiments must be an array")
        else:
            for experiment_id in item.get("supporting_experiments", []):
                if experiment_id not in experiments_by_id:
                    errors.append(f"{label}.supporting_experiments references unknown experiment_id: {experiment_id}")
        if item.get("invalidated_by") not in (None, "") and item.get("invalidated_by") not in docs_by_id:
            warnings.append(f"{label}.invalidated_by does not match a known doc_id: {item.get('invalidated_by')}")
        if not isinstance(item.get("risk_flags"), list):
            errors.append(f"{label}.risk_flags must be an array")
        try:
            parse_timestamp(item.get("last_reviewed_at"))
        except Exception:
            errors.append(f"{label}.last_reviewed_at must be ISO-8601 or null")
        stale_after_days = item.get("stale_after_days")
        if stale_after_days not in (None, "") and (not isinstance(stale_after_days, int) or stale_after_days < 0):
            errors.append(f"{label}.stale_after_days must be a nonnegative integer or null")
        if item.get("conclusion_status") == "confirmed":
            support_scopes = []
            for doc_id in item.get("supporting_docs", []):
                if doc_id in docs_by_id:
                    support_scopes.append(docs_by_id[doc_id].get("evidence_scope"))
            for experiment_id in item.get("supporting_experiments", []):
                if experiment_id in experiments_by_id:
                    support_scopes.append(experiments_by_id[experiment_id].get("evidence_scope"))
            if support_scopes and all(scope == "auxiliary_only" for scope in support_scopes):
                errors.append(f"{label} confirmed conclusion cannot rely only on auxiliary_only evidence")
            if research_policy["require_primary_evidence_for_confirmed_claims"] and not any(
                scope in {"primary_only", "mixed"} for scope in support_scopes
            ):
                errors.append(f"{label} confirmed conclusion must include primary or mixed evidence per research_program")
        add_warning_if_stale(item, warnings)

    if not isinstance(golden_queries, dict):
        errors.append("golden_queries.json must be an object")
        golden_queries = {}
    queries = golden_queries.get("queries")
    if not isinstance(queries, list):
        errors.append("golden_queries.json queries must be an array")
        queries = []
    for index, query in enumerate(queries):
        label = f"golden_queries.queries[{index}]"
        if not isinstance(query, dict):
            errors.append(f"{label} must be an object")
            continue
        if not isinstance(query.get("query"), str) or not query.get("query").strip():
            errors.append(f"{label}.query must be a nonempty string")
        expected_decision = query.get("expected_decision")
        if expected_decision not in (None, "") and expected_decision not in valid_search_decision:
            errors.append(f"{label}.expected_decision is invalid: {expected_decision!r}")

    if not doc_records and not experiment_records and not items:
        warnings.append("project_index is empty; retrieval will usually return no_index_hit until curated entries are added")
    if not queries:
        warnings.append("golden_queries.json has no regression queries yet")

    summary = {
        "ok": not errors,
        "project_root": str(root),
        "counts": {
            "documents": len(doc_records),
            "experiments": len(experiment_records),
            "current_conclusions": len(items),
            "golden_queries": len(queries),
            "research_program": 1 if isinstance(research_program, dict) else 0,
        },
        "errors": errors,
        "warnings": warnings,
    }

    if args.json:
        sys.stdout.write(json.dumps(summary, indent=2, ensure_ascii=False) + "\\n")
    else:
        status = "ok" if not errors else "error"
        print(f"[watchdog-index] status={status} root={root}")
        print(
            "[watchdog-index] documents={documents} experiments={experiments} current_conclusions={current_conclusions} golden_queries={golden_queries} research_program={research_program}".format(
                **summary["counts"]
            )
        )
        for warning in warnings:
            print(f"warning: {warning}")
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
`,

  watchdogDocSearch: () => `#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[\\u4e00-\\u9fff]+")


def parse_args():
    parser = argparse.ArgumentParser(description="Metadata-first watchdog evidence retrieval.")
    parser.add_argument("--query", required=True, help="Question or retrieval query.")
    parser.add_argument("--doc-type", action="append", default=[], dest="doc_types", help="Filter by doc_type. Repeatable.")
    parser.add_argument("--status", action="append", default=[], dest="statuses", help="Filter by status. Repeatable.")
    parser.add_argument("--evidence-scope", action="append", default=[], dest="evidence_scopes", help="Filter by evidence_scope. Repeatable.")
    parser.add_argument("--project-area", action="append", default=[], dest="project_areas", help="Filter by project_area. Repeatable.")
    parser.add_argument("--primary-only", action="store_true", help="Restrict hits to primary_only evidence.")
    parser.add_argument("--exclude-auxiliary", action="store_true", help="Hide auxiliary_only hits.")
    parser.add_argument("--experiment-id", action="append", default=[], dest="experiment_ids", help="Restrict hits to specific experiment IDs.")
    parser.add_argument("--path-prefix", default="", help="Restrict document paths to this relative prefix.")
    parser.add_argument("--include-deprecated", action="store_true", help="Include deprecated, archived, and invalidated records.")
    parser.add_argument("--include-superseded", action="store_true", help="Include superseded records.")
    parser.add_argument("--history", action="store_true", help="Include all historical statuses.")
    parser.add_argument("--top-k", type=int, default=5, help="Maximum number of hits and read-plan entries to return.")
    parser.add_argument("--json", action="store_true", help="Emit JSON.")
    parser.add_argument("--project-root", default=".", help="Watchdog project root. Defaults to the current directory.")
    return parser.parse_args()


def load_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def load_jsonl(path):
    if not path.exists():
        return []
    records = []
    for line in path.read_text().splitlines():
        if line.strip():
            records.append(json.loads(line))
    return records


def tokenize(text):
    if text is None:
        return []
    if not isinstance(text, str):
        text = str(text)
    return [token.lower() for token in TOKEN_RE.findall(text)]


def joined_tokens(*values):
    tokens = []
    for value in values:
        if isinstance(value, list):
            for item in value:
                tokens.extend(tokenize(item))
        else:
            tokens.extend(tokenize(value))
    return tokens


def parse_timestamp(value):
    if value in (None, ""):
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def current_time_utc():
    raw = str(os.environ.get("WATCHDOG_FIXED_NOW") or "").strip()
    if raw:
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except Exception:
            pass
    return datetime.now(timezone.utc)


def conclusion_is_stale(item):
    reviewed = item.get("last_reviewed_at")
    stale_after_days = item.get("stale_after_days")
    if reviewed in (None, "") or stale_after_days in (None, ""):
        return False
    try:
        reviewed_at = parse_timestamp(reviewed)
    except Exception:
        return False
    if reviewed_at.tzinfo is None:
        reviewed_at = reviewed_at.replace(tzinfo=timezone.utc)
    return current_time_utc() >= reviewed_at + timedelta(days=int(stale_after_days))


def query_requests_formal_conclusion(lowered_query):
    markers = [
        "current conclusion",
        "current best",
        "best candidate",
        "formal result",
        "official conclusion",
        "should we adopt",
        "should we replace",
        "verify whether",
        "compare",
        "versus",
        "vs ",
        "当前",
        "结论",
        "最佳",
        "比较",
        "验证",
        "是否采用",
        "是否替换",
    ]
    return any(marker in lowered_query for marker in markers)


def status_allowed(status, args):
    if args.statuses:
        return status in set(args.statuses)
    if args.history:
        return True
    if status in {"active", "draft"}:
        return True
    if status == "superseded":
        return args.include_superseded
    if status in {"deprecated", "archived", "invalidated"}:
        return args.include_deprecated
    return False


def evidence_scope_allowed(scope, args):
    if args.primary_only and scope != "primary_only":
        return False
    if args.exclude_auxiliary and scope == "auxiliary_only":
        return False
    if args.evidence_scopes:
        return scope in set(args.evidence_scopes)
    return True


def score_overlap(query_tokens, candidate_tokens):
    if not query_tokens or not candidate_tokens:
        return 0
    candidate_set = set(candidate_tokens)
    overlap = sum(1 for token in query_tokens if token in candidate_set)
    prefix_bonus = 0
    for token in query_tokens:
        if any(item.startswith(token) for item in candidate_set):
            prefix_bonus += 0.2
    return overlap + prefix_bonus


def add_unique_read_plan(read_plan, seen_paths, path, reason, score):
    if not path or path in seen_paths:
        return
    read_plan.append({"path": path, "reason": reason, "score": round(score, 3)})
    seen_paths.add(path)


def main():
    args = parse_args()
    root = Path(args.project_root).resolve()
    index_root = root / "project_index"

    try:
        docs = load_jsonl(index_root / "document_index.jsonl")
        experiments = load_jsonl(index_root / "experiment_index.jsonl")
        current_conclusions = load_json(index_root / "current_conclusions.json")
    except Exception as exc:
        payload = {
            "query": args.query,
            "decision": "index_error",
            "warnings": [f"failed to load project_index: {exc}"],
            "read_plan": [],
            "hits": [],
        }
        if args.json:
            sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\\n")
            raise SystemExit(0)
        print(f"index_error: {exc}")
        raise SystemExit(0)

    docs_by_id = {record.get("doc_id"): record for record in docs if isinstance(record, dict)}
    experiments_by_id = {record.get("experiment_id"): record for record in experiments if isinstance(record, dict)}

    query_tokens = tokenize(args.query)
    lowered_query = args.query.lower()
    hits = []
    read_plan = []
    read_plan_paths = set()
    warnings = []

    for record in docs:
        if not isinstance(record, dict):
            continue
        if not status_allowed(record.get("status"), args):
            continue
        if not evidence_scope_allowed(record.get("evidence_scope"), args):
            continue
        if args.doc_types and record.get("doc_type") not in set(args.doc_types):
            continue
        if args.project_areas and record.get("project_area") not in set(args.project_areas):
            continue
        path_value = record.get("path") or ""
        if args.path_prefix and not str(path_value).startswith(args.path_prefix):
            continue
        candidate_tokens = joined_tokens(
            record.get("title"),
            record.get("summary"),
            record.get("path"),
            record.get("project_area"),
            record.get("tags"),
            record.get("doc_type"),
        )
        score = score_overlap(query_tokens, candidate_tokens)
        if score <= 0 and query_tokens:
            continue
        if record.get("status") == "active":
            score += 1.5
        if record.get("evidence_scope") == "primary_only":
            score += 2.0
        elif record.get("evidence_scope") == "mixed":
            score += 1.0
        elif record.get("evidence_scope") == "auxiliary_only":
            score -= 0.5
        hits.append({
            "kind": "document",
            "id": record.get("doc_id"),
            "title": record.get("title"),
            "path": record.get("path"),
            "status": record.get("status"),
            "evidence_scope": record.get("evidence_scope"),
            "doc_type": record.get("doc_type"),
            "project_area": record.get("project_area"),
            "summary": record.get("summary"),
            "score": round(score, 3),
        })

    for record in experiments:
        if not isinstance(record, dict):
            continue
        if not status_allowed(record.get("status"), args):
            continue
        if not evidence_scope_allowed(record.get("evidence_scope"), args):
            continue
        if args.experiment_ids and record.get("experiment_id") not in set(args.experiment_ids):
            continue
        candidate_tokens = joined_tokens(
            record.get("name"),
            record.get("purpose"),
            record.get("experiment_type"),
            record.get("model"),
            record.get("baseline_model"),
            record.get("primary_metric_name"),
        )
        score = score_overlap(query_tokens, candidate_tokens)
        if score <= 0 and query_tokens:
            continue
        if record.get("status") == "active":
            score += 1.0
        if record.get("evidence_scope") == "primary_only":
            score += 1.5
        hits.append({
            "kind": "experiment",
            "id": record.get("experiment_id"),
            "name": record.get("name"),
            "status": record.get("status"),
            "evidence_scope": record.get("evidence_scope"),
            "primary_metric_name": record.get("primary_metric_name"),
            "primary_eval_path": record.get("primary_eval_path"),
            "official_conclusion_doc": record.get("official_conclusion_doc"),
            "score": round(score, 3),
        })

    for item in current_conclusions.get("items", []):
        if not isinstance(item, dict):
            continue
        status = "invalidated" if item.get("conclusion_status") == "invalidated" else "active"
        if not status_allowed(status, args):
            continue
        if not evidence_scope_allowed(item.get("evidence_scope"), args):
            continue
        if args.experiment_ids and not set(item.get("supporting_experiments", [])).intersection(args.experiment_ids):
            continue
        candidate_tokens = joined_tokens(item.get("topic"), item.get("claim"), item.get("risk_flags"))
        score = score_overlap(query_tokens, candidate_tokens)
        if score <= 0 and query_tokens:
            continue
        score += 3.0
        if item.get("conclusion_status") == "confirmed":
            score += 2.0
        if item.get("evidence_scope") == "primary_only":
            score += 1.5
        hit = {
            "kind": "current_conclusion",
            "id": item.get("topic_id"),
            "topic": item.get("topic"),
            "claim": item.get("claim"),
            "conclusion_status": item.get("conclusion_status"),
            "evidence_scope": item.get("evidence_scope"),
            "supporting_docs": item.get("supporting_docs", []),
            "supporting_experiments": item.get("supporting_experiments", []),
            "risk_flags": item.get("risk_flags", []),
            "stale": conclusion_is_stale(item),
            "score": round(score, 3),
        }
        hits.append(hit)

    hits.sort(key=lambda item: (-item.get("score", 0), item.get("kind"), item.get("id") or ""))
    hits = hits[: max(1, args.top_k)]

    for hit in hits:
        if hit["kind"] == "current_conclusion":
            for doc_id in hit.get("supporting_docs", []):
                doc = docs_by_id.get(doc_id)
                if doc:
                    add_unique_read_plan(
                        read_plan,
                        read_plan_paths,
                        doc.get("path"),
                        f"supports current conclusion: {hit.get('topic')}",
                        hit.get("score", 0),
                    )
            for experiment_id in hit.get("supporting_experiments", []):
                experiment = experiments_by_id.get(experiment_id)
                if experiment and experiment.get("primary_eval_path"):
                    add_unique_read_plan(
                        read_plan,
                        read_plan_paths,
                        experiment.get("primary_eval_path"),
                        f"primary evaluation for experiment: {experiment.get('name')}",
                        hit.get("score", 0) - 0.2,
                    )
        elif hit["kind"] == "document":
            add_unique_read_plan(
                read_plan,
                read_plan_paths,
                hit.get("path"),
                f"{hit.get('status')} {hit.get('doc_type')} ({hit.get('evidence_scope')})",
                hit.get("score", 0),
            )
        elif hit["kind"] == "experiment" and hit.get("primary_eval_path"):
            add_unique_read_plan(
                read_plan,
                read_plan_paths,
                hit.get("primary_eval_path"),
                f"primary evaluation for experiment: {hit.get('name')}",
                hit.get("score", 0),
            )
            doc_id = hit.get("official_conclusion_doc")
            if doc_id and doc_id in docs_by_id:
                add_unique_read_plan(
                    read_plan,
                    read_plan_paths,
                    docs_by_id[doc_id].get("path"),
                    f"official conclusion doc for experiment: {hit.get('name')}",
                    hit.get("score", 0) - 0.2,
                )

    decision = "safe_to_answer"
    if not hits:
        decision = "no_index_hit"
        warnings.append("no indexed evidence matched the query")
    else:
        stale_hits = [hit for hit in hits if hit.get("kind") == "current_conclusion" and hit.get("stale")]
        conflicting_hits = [
            hit
            for hit in hits
            if hit.get("kind") == "current_conclusion"
            and any(flag in {"conflicting_evidence", "conflict", "needs_human_decision"} for flag in hit.get("risk_flags", []))
        ]
        effective_scopes = [hit.get("evidence_scope") for hit in hits if hit.get("evidence_scope") is not None]
        has_primary_support = any(scope in {"primary_only", "mixed"} for scope in effective_scopes) or any(
            hit.get("kind") == "current_conclusion" and hit.get("conclusion_status") == "confirmed" and not hit.get("stale")
            for hit in hits
        )
        all_auxiliary = bool(effective_scopes) and all(scope in {"auxiliary_only", "none"} for scope in effective_scopes)
        if conflicting_hits:
            decision = "conflicting_evidence"
            warnings.append("matching current conclusions carry conflicting_evidence or needs_human_decision flags")
        elif stale_hits:
            decision = "stale_conclusion"
            warnings.append("matching current conclusion is stale and should be rechecked before citation")
        elif all_auxiliary:
            decision = "only_auxiliary_found"
            warnings.append("only auxiliary evidence matched the query")
        elif query_requests_formal_conclusion(lowered_query) and not has_primary_support:
            decision = "insufficient_primary_evidence"
            warnings.append("the query asks for a formal conclusion but the index did not surface primary evidence")
    if not docs and not experiments and not current_conclusions.get("items"):
        warnings.append("project_index is empty; curate entries before relying on this retriever for formal answers")

    payload = {
        "query": args.query,
        "decision": decision,
        "warnings": warnings,
        "read_plan": read_plan[: max(1, args.top_k)],
        "hits": hits,
    }

    if args.json:
        sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\\n")
    else:
        print(f"decision: {decision}")
        for warning in warnings:
            print(f"warning: {warning}")
        print("read_plan:")
        for item in payload["read_plan"]:
            print(f"- {item['path']}: {item['reason']}")
        if hits:
            print("hits:")
            for hit in hits:
                label = hit.get("title") or hit.get("topic") or hit.get("name") or hit.get("id")
                print(f"- {hit['kind']} {label} score={hit.get('score')}")


if __name__ == "__main__":
    main()
`
};

module.exports = {
  pythonEvidenceToolTemplates
};
