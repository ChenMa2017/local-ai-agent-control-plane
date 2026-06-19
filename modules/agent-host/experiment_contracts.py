from __future__ import annotations

import hashlib
import json
import math
from typing import Any

JsonObject = dict[str, Any]

TERMINAL_TASK_STATUSES = {"done", "failed", "timeout", "stale", "cancelled", "policy_violation"}
PASS_STATUSES = {"pass", "passed", "met", "success", "satisfied"}
FAIL_STATUSES = {"fail", "failed", "not_met", "unsatisfied"}
RUNNER_METRICS_SCHEMA_VERSION = "runner_metrics.v0.2"
RUNNER_METRICS_TOP_LEVEL_FIELDS = {
    "schema_version",
    "task_id",
    "intake_id",
    "experiment_id",
    "experiment_spec_digest",
    "producer",
    "generated_at",
    "metrics",
}
RUNNER_METRIC_ALLOWED_FIELDS = {
    "metric_id",
    "name",
    "value",
    "unit",
    "sample_count",
    "artifact_refs",
    "notes",
    "baseline_value",
}


def _metric_key(item: JsonObject) -> str:
    return str(item.get("name") or item.get("metric_id") or "").strip().lower()


def _criterion_key(item: JsonObject) -> str:
    return str(item.get("criterion_id") or item.get("name") or "").strip().lower()


def _coerce_comparable(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return stripped
        try:
            return float(stripped)
        except ValueError:
            return stripped
    return value


def _evaluate_target(value: Any, target: JsonObject) -> bool | None:
    operator = str(target.get("operator") or "").strip()
    if not operator:
        return None
    actual = _coerce_comparable(value)
    expected = _coerce_comparable(target.get("value"))
    try:
        if operator == ">":
            return actual > expected
        if operator == ">=":
            return actual >= expected
        if operator == "<":
            return actual < expected
        if operator == "<=":
            return actual <= expected
        if operator == "==":
            return actual == expected
        if operator == "!=":
            return actual != expected
    except TypeError:
        return None
    return None


def _normalized_outcome_status(status: Any) -> str | None:
    normalized = str(status or "").strip().lower()
    if normalized in PASS_STATUSES:
        return "pass"
    if normalized in FAIL_STATUSES:
        return "fail"
    return None


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _stable_experiment_spec_for_digest(experiment_spec: JsonObject) -> JsonObject:
    return {
        "experiment_id": experiment_spec.get("experiment_id"),
        "objective": experiment_spec.get("objective"),
        "task_type": experiment_spec.get("task_type"),
        "hypothesis_ids": list(experiment_spec.get("hypothesis_ids") or []),
        "baseline_spec": experiment_spec.get("baseline_spec") if isinstance(experiment_spec.get("baseline_spec"), dict) else {},
        "dataset_refs": list(experiment_spec.get("dataset_refs") or []),
        "checkpoint_refs": list(experiment_spec.get("checkpoint_refs") or []),
        "code_reference": experiment_spec.get("code_reference") if isinstance(experiment_spec.get("code_reference"), dict) else {},
        "config_reference": experiment_spec.get("config_reference") if isinstance(experiment_spec.get("config_reference"), dict) else {},
        "random_seeds": list(experiment_spec.get("random_seeds") or []),
        "repeat_count": experiment_spec.get("repeat_count"),
        "metric_definitions": list(experiment_spec.get("metric_definitions") or []),
        "success_criteria": list(experiment_spec.get("success_criteria") or []),
        "failure_criteria": list(experiment_spec.get("failure_criteria") or []),
    }


def experiment_spec_digest(experiment_spec: JsonObject) -> str:
    stable = _stable_experiment_spec_for_digest(experiment_spec)
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _metric_definition_index(metric_definitions: list[JsonObject]) -> dict[str, JsonObject]:
    index: dict[str, JsonObject] = {}
    for item in metric_definitions:
        if not isinstance(item, dict):
            continue
        for key in (
            str(item.get("metric_id") or "").strip().lower(),
            str(item.get("name") or "").strip().lower(),
        ):
            if key:
                index[key] = item
    return index


def validate_runner_metrics_payload(
    payload: JsonObject,
    *,
    evaluation: JsonObject,
    experiment_spec: JsonObject,
) -> tuple[JsonObject, str | None]:
    if not isinstance(payload, dict):
        return {}, "payload is not a JSON object"
    unknown_top_level_fields = sorted(set(payload) - RUNNER_METRICS_TOP_LEVEL_FIELDS)
    if unknown_top_level_fields:
        return {}, f"unexpected top-level fields: {', '.join(unknown_top_level_fields)}"
    if str(payload.get("schema_version") or "") != RUNNER_METRICS_SCHEMA_VERSION:
        return {}, f"schema_version must be {RUNNER_METRICS_SCHEMA_VERSION}"
    if str(payload.get("task_id") or "") != str(evaluation.get("task_id") or ""):
        return {}, "task_id does not match the current task"
    intake_id = str(evaluation.get("intake_id") or "")
    if intake_id and str(payload.get("intake_id") or "") != intake_id:
        return {}, "intake_id does not match the current intake"
    experiment_id = str(experiment_spec.get("experiment_id") or "")
    if experiment_id and str(payload.get("experiment_id") or "") != experiment_id:
        return {}, "experiment_id does not match ExperimentSpec"
    if str(payload.get("experiment_spec_digest") or "") != experiment_spec_digest(experiment_spec):
        return {}, "experiment_spec_digest does not match ExperimentSpec"
    producer = payload.get("producer")
    if not isinstance(producer, dict):
        return {}, "producer must be an object"
    for field in ("kind", "id", "version"):
        if not str(producer.get(field) or "").strip():
            return {}, f"producer.{field} is required"
    if not str(payload.get("generated_at") or "").strip():
        return {}, "generated_at is required"
    metrics = payload.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        return {}, "metrics must be a non-empty list"

    metric_definitions = (
        list(experiment_spec.get("metric_definitions") or [])
        if isinstance(experiment_spec.get("metric_definitions"), list)
        else []
    )
    metric_index = _metric_definition_index(metric_definitions)
    normalized_metrics: list[JsonObject] = []
    seen_metric_keys: set[str] = set()
    for item in metrics:
        if not isinstance(item, dict):
            return {}, "each metric must be an object"
        unknown_metric_fields = sorted(set(item) - RUNNER_METRIC_ALLOWED_FIELDS)
        if unknown_metric_fields:
            return {}, f"unexpected metric fields: {', '.join(unknown_metric_fields)}"
        candidate_keys = [
            str(item.get("metric_id") or "").strip().lower(),
            str(item.get("name") or "").strip().lower(),
        ]
        metric_key = next((key for key in candidate_keys if key), "")
        if not metric_key:
            return {}, "metric_id or name is required for each metric"
        definition = metric_index.get(metric_key)
        if not isinstance(definition, dict):
            return {}, f"metric {metric_key} is not declared in ExperimentSpec"
        canonical_key = str(definition.get("metric_id") or definition.get("name") or "").strip().lower()
        if canonical_key in seen_metric_keys:
            return {}, f"duplicate metric {canonical_key}"
        seen_metric_keys.add(canonical_key)
        value = item.get("value")
        if not _is_finite_number(value):
            return {}, f"metric {canonical_key} has non-finite numeric value"
        sample_count = item.get("sample_count")
        if sample_count is not None and (not isinstance(sample_count, int) or sample_count <= 0):
            return {}, f"metric {canonical_key} has invalid sample_count"
        unit = item.get("unit")
        if unit is not None and not str(unit).strip():
            return {}, f"metric {canonical_key} has empty unit"
        baseline_value = item.get("baseline_value")
        if baseline_value is not None and not _is_finite_number(baseline_value):
            return {}, f"metric {canonical_key} has non-finite baseline_value"
        artifact_refs = item.get("artifact_refs")
        if artifact_refs is not None:
            if not isinstance(artifact_refs, list) or any(not str(ref or "").strip() for ref in artifact_refs):
                return {}, f"metric {canonical_key} has invalid artifact_refs"
        normalized_metric = {
            "metric_id": str(definition.get("metric_id") or item.get("metric_id") or "").strip() or None,
            "name": str(definition.get("name") or item.get("name") or "").strip() or None,
            "value": float(value),
        }
        if sample_count is not None:
            normalized_metric["sample_count"] = sample_count
        if unit is not None:
            normalized_metric["unit"] = str(unit).strip()
        if item.get("notes") is not None:
            normalized_metric["notes"] = str(item.get("notes") or "")
        if artifact_refs is not None:
            normalized_metric["artifact_refs"] = [str(ref).strip() for ref in artifact_refs]
        if baseline_value is not None:
            normalized_metric["baseline_value"] = float(baseline_value)
        normalized_metrics.append(normalized_metric)
    return {
        "schema_version": RUNNER_METRICS_SCHEMA_VERSION,
        "task_id": str(payload.get("task_id") or ""),
        "intake_id": str(payload.get("intake_id") or ""),
        "experiment_id": str(payload.get("experiment_id") or ""),
        "experiment_spec_digest": str(payload.get("experiment_spec_digest") or ""),
        "producer": {
            "kind": str(producer.get("kind") or "").strip(),
            "id": str(producer.get("id") or "").strip(),
            "version": str(producer.get("version") or "").strip(),
        },
        "generated_at": str(payload.get("generated_at") or "").strip(),
        "metrics": normalized_metrics,
    }, None


def _criterion_outcome_statuses(success_criteria: list[JsonObject], *, criterion_kind: str | None = None) -> list[str]:
    statuses: list[str] = []
    for item in success_criteria:
        if not isinstance(item, dict):
            continue
        if criterion_kind and str(item.get("kind") or "").strip() != criterion_kind:
            continue
        normalized = _normalized_outcome_status(item.get("status"))
        if normalized is not None:
            statuses.append(normalized)
    return statuses


def _baseline_comparison_from_metrics(metrics: list[JsonObject], baseline_spec: JsonObject) -> JsonObject:
    comparison = {
        "status": "not_available",
        "baseline_required": baseline_spec.get("required"),
        "baseline_entities": list(baseline_spec.get("entities") or []),
    }
    observed = next(
        (
            item
            for item in metrics
            if isinstance(item, dict)
            and _is_finite_number(item.get("value"))
            and _is_finite_number(item.get("baseline_value"))
        ),
        None,
    )
    if not isinstance(observed, dict):
        if comparison["baseline_required"]:
            comparison["status"] = "pending"
        return comparison
    value = float(observed.get("value"))
    baseline_value = float(observed.get("baseline_value"))
    higher_is_better = observed.get("higher_is_better")
    delta = value - baseline_value
    comparison.update(
        {
            "metric_name": observed.get("name"),
            "observed_value": value,
            "baseline_value": baseline_value,
            "delta": delta,
        }
    )
    if higher_is_better is True:
        if delta > 0:
            comparison["status"] = "improved"
        elif delta < 0:
            comparison["status"] = "worse"
        else:
            comparison["status"] = "matched"
    elif higher_is_better is False:
        if delta < 0:
            comparison["status"] = "improved"
        elif delta > 0:
            comparison["status"] = "worse"
        else:
            comparison["status"] = "matched"
    else:
        comparison["status"] = "observed"
    return comparison


def _merge_metric_items(
    metric_definitions: list[JsonObject],
    provided_metrics: list[JsonObject],
    *,
    result_available: bool,
) -> list[JsonObject]:
    metric_index = {
        _metric_key(item): dict(item)
        for item in provided_metrics
        if isinstance(item, dict) and _metric_key(item)
    }
    metrics: list[JsonObject] = []
    seen_keys: set[str] = set()
    for item in metric_definitions:
        if not isinstance(item, dict):
            continue
        merged = dict(item)
        key = _metric_key(merged)
        provided = metric_index.get(key) if key else None
        if isinstance(provided, dict):
            for field in ("value", "notes", "unit", "sample_count", "artifact_refs", "baseline_value"):
                if field in provided:
                    merged[field] = provided.get(field)
        name = str(merged.get("name") or "")
        if name == "safe_result_available" and "value" not in merged:
            merged["value"] = 1 if result_available else 0
            merged["notes"] = (
                "Execution produced a non-empty safe result excerpt."
                if result_available
                else "Execution did not produce a safe result excerpt."
            )
        elif "value" not in merged:
            merged["value"] = None
            merged["notes"] = "Structured runner metrics are not yet exported for this experiment."
        if not _normalized_outcome_status(merged.get("status")) and isinstance(merged.get("target"), dict):
            evaluated = _evaluate_target(merged.get("value"), merged.get("target"))
            if evaluated is True:
                merged["status"] = "pass"
            elif evaluated is False:
                merged["status"] = "fail"
        metrics.append(merged)
        if key:
            seen_keys.add(key)
    return metrics


def _merge_success_criteria(
    success_criteria: list[JsonObject],
    metrics: list[JsonObject],
) -> list[JsonObject]:
    metric_index = {
        _metric_key(item): item
        for item in metrics
        if isinstance(item, dict) and _metric_key(item)
    }
    merged_criteria: list[JsonObject] = []
    for item in success_criteria:
        if not isinstance(item, dict):
            continue
        merged = dict(item)
        metric_name = str(merged.get("metric_name") or "").strip().lower()
        metric = metric_index.get(metric_name) if metric_name else None
        if not _normalized_outcome_status(merged.get("status")) and isinstance(metric, dict):
            metric_status = _normalized_outcome_status(metric.get("status"))
            if metric_status is not None:
                merged["status"] = metric_status
            elif isinstance(merged.get("target"), dict):
                evaluated = _evaluate_target(metric.get("value"), merged.get("target"))
                if evaluated is True:
                    merged["status"] = "pass"
                elif evaluated is False:
                    merged["status"] = "fail"
        merged_criteria.append(merged)
    return merged_criteria


def _merge_failure_criteria(
    failure_criteria: list[JsonObject],
    *,
    task_status: str,
    result_available: bool,
    protected_path_violation: bool,
) -> list[JsonObject]:
    merged_criteria: list[JsonObject] = []
    for item in failure_criteria:
        if not isinstance(item, dict):
            continue
        merged = dict(item)
        name = str(merged.get("name") or "").strip()
        triggered: bool | None = None
        if name == "task_not_terminal":
            triggered = task_status not in TERMINAL_TASK_STATUSES
        elif name == "protected_path_violation":
            triggered = protected_path_violation
        elif name == "missing_safe_result_excerpt":
            triggered = not result_available
        merged["status"] = (
            "triggered"
            if triggered is True
            else ("clear" if triggered is False else "not_evaluated")
        )
        merged["triggered"] = triggered
        merged_criteria.append(merged)
    return merged_criteria


def build_experiment_contract_fields(
    *,
    objective: str,
    task_type: str,
    summary: str,
    decision_gate: JsonObject,
    taskbox: JsonObject,
    preflight: JsonObject,
    read_plan: list[JsonObject],
    baseline_required: bool | None,
    baseline_entities: list[str],
    experiment_required: bool,
) -> JsonObject:
    unresolved_items = [str(item) for item in (decision_gate.get("unresolved_items") or []) if str(item or "").strip()]
    unresolved_set = set(unresolved_items)
    baseline_required_value = bool(baseline_required) if isinstance(baseline_required, bool) else False
    metric_definitions = []
    if experiment_required:
        metric_definitions.append(
            {
                "metric_id": "M-01",
                "name": "safe_result_available",
                "kind": "binary",
                "source": "execution_safe_result_excerpt",
                "higher_is_better": True,
                "description": "Whether the bounded run produced a non-empty safe result excerpt.",
            }
        )
        metric_definitions.append(
            {
                "metric_id": "M-02",
                "name": "domain_primary_metric",
                "kind": "external_or_user_defined",
                "source": "future_runner_metrics",
                "higher_is_better": None,
                "description": "Reserved slot for the domain metric once the runner exports structured measurements.",
            }
        )

    success_criteria = []
    if experiment_required:
        success_criteria.extend(
            [
                {
                    "criterion_id": "SC-01",
                    "name": "bounded_result_available",
                    "kind": "structural",
                    "status": "ready",
                    "description": "Execution should finish with a non-empty safe result excerpt.",
                },
                {
                    "criterion_id": "SC-02",
                    "name": "user_success_criterion_defined",
                    "kind": "contract",
                    "status": "missing" if "success_criterion_missing" in unresolved_set else "resolved",
                    "description": "The prepare contract should capture an explicit success criterion for the experiment.",
                },
                {
                    "criterion_id": "SC-03",
                    "name": "control_definition_resolved",
                    "kind": "contract",
                    "status": "missing" if "control_definition_missing" in unresolved_set else "resolved",
                    "description": "The control or baseline arm should be explicitly defined before interpreting the run.",
                },
                {
                    "criterion_id": "SC-04",
                    "name": "fairness_constraint_resolved",
                    "kind": "contract",
                    "status": "missing" if "fairness_constraint_missing" in unresolved_set else "resolved",
                    "description": "The fairness constraint should define whether only one factor may vary.",
                },
            ]
        )

    failure_criteria = []
    if experiment_required:
        failure_criteria.extend(
            [
                {
                    "criterion_id": "FC-01",
                    "name": "task_not_terminal",
                    "kind": "execution",
                    "description": "The run did not reach a terminal task status.",
                },
                {
                    "criterion_id": "FC-02",
                    "name": "protected_path_violation",
                    "kind": "policy",
                    "description": "The run touched a protected path according to write audit evidence.",
                },
                {
                    "criterion_id": "FC-03",
                    "name": "missing_safe_result_excerpt",
                    "kind": "execution",
                    "description": "The run finished without a safe result excerpt that can be reviewed.",
                },
            ]
        )

    stop_conditions = []
    if experiment_required:
        stop_conditions = [
            "policy_violation",
            "timeout",
            "protected_path_violation",
            "human_review_required",
        ]

    expected_artifacts = []
    if experiment_required:
        expected_artifacts = [
            "EXECUTION_EVALUATION.json",
            "EXPERIMENT_RESULT.json",
            "EXPERIMENT_INDEX_UPDATE.json",
            "EXPERIMENT_PROMOTION.json",
            "EVALUATION_REPORT.json",
        ]

    read_plan_paths = [
        str(item.get("path") or "")
        for item in read_plan
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ]
    return {
        "baseline_spec": {
            "required": baseline_required if isinstance(baseline_required, bool) else None,
            "entities": baseline_entities,
            "status": (
                "resolved"
                if baseline_entities
                else ("missing" if baseline_required_value else "not_required")
            ),
        },
        "control_variables": [
            {
                "name": "allowed_runner",
                "value": taskbox.get("allowed_runner"),
                "source": "taskbox",
            },
            {
                "name": "workspace_mode",
                "value": taskbox.get("workspace_mode"),
                "source": "taskbox",
            },
            {
                "name": "control_definition_resolved",
                "value": experiment_required and "control_definition_missing" not in unresolved_set,
                "source": "decision_gate",
            },
            {
                "name": "fairness_constraint_resolved",
                "value": experiment_required and "fairness_constraint_missing" not in unresolved_set,
                "source": "decision_gate",
            },
        ],
        "dataset_refs": [],
        "checkpoint_refs": [],
        "code_reference": {
            "commit": None,
            "paths": [],
            "status": "unspecified",
        },
        "config_reference": {
            "path": None,
            "hash": None,
            "status": "unspecified",
        },
        "random_seeds": [],
        "repeat_count": 1 if experiment_required else 0,
        "command_template": {
            "kind": "prepared_taskbox_contract",
            "objective": objective,
            "task_type": task_type,
            "summary": summary,
            "allowed_runner": taskbox.get("allowed_runner"),
            "workspace_mode": taskbox.get("workspace_mode"),
        },
        "resource_budget": {
            "allowed_runner": taskbox.get("allowed_runner"),
            "workspace_mode": taskbox.get("workspace_mode"),
            "allowed_write_paths": list(taskbox.get("allowed_write_paths") or []),
            "preflight_ok": bool(preflight.get("ok")),
            "blocked_by": list(preflight.get("blocked_by") or []),
        },
        "timeout_seconds": None,
        "metric_definitions": metric_definitions,
        "metric_parser": {
            "kind": "agent_host_structural_only",
            "status": "placeholder",
            "read_plan_paths": read_plan_paths,
        },
        "success_criteria": success_criteria,
        "failure_criteria": failure_criteria,
        "stop_conditions": stop_conditions,
        "expected_artifacts": expected_artifacts,
        "unresolved_contract_fields": unresolved_items,
    }


def build_structural_experiment_result(
    *,
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    review_required: bool,
    runner_metrics: JsonObject | None = None,
    runner_metrics_status: JsonObject | None = None,
) -> JsonObject:
    task_status = str(evaluation.get("task_status") or "")
    result_available = bool(evaluation.get("result_available"))
    protected_path_violation = bool(((evaluation.get("write_audit") or {}).get("protected_path_violation")))
    success_criteria = (
        list(experiment_spec.get("success_criteria") or [])
        if isinstance(experiment_spec.get("success_criteria"), list)
        else []
    )
    failure_criteria = (
        list(experiment_spec.get("failure_criteria") or [])
        if isinstance(experiment_spec.get("failure_criteria"), list)
        else []
    )
    metric_definitions = (
        list(experiment_spec.get("metric_definitions") or [])
        if isinstance(experiment_spec.get("metric_definitions"), list)
        else []
    )
    if not metric_definitions:
        metric_definitions = [
            {
                "metric_id": "M-01",
                "name": "safe_result_available",
                "kind": "binary",
                "source": "execution_safe_result_excerpt",
                "higher_is_better": True,
                "description": "Whether the bounded run produced a non-empty safe result excerpt.",
            }
        ]
    runner_metrics_payload = runner_metrics if isinstance(runner_metrics, dict) else {}
    runner_metrics_metadata = runner_metrics_status if isinstance(runner_metrics_status, dict) else {}
    provided_metrics = (
        list(runner_metrics_payload.get("metrics") or [])
        if isinstance(runner_metrics_payload.get("metrics"), list)
        else []
    )
    metrics = _merge_metric_items(
        metric_definitions,
        provided_metrics,
        result_available=result_available,
    )
    success_criteria = _merge_success_criteria(
        success_criteria,
        metrics,
    )
    failure_criteria = _merge_failure_criteria(
        failure_criteria,
        task_status=task_status,
        result_available=result_available,
        protected_path_violation=protected_path_violation,
    )
    unresolved_success_criteria = [
        str(item.get("name") or item.get("criterion_id") or "")
        for item in success_criteria
        if isinstance(item, dict) and str(item.get("status") or "") == "missing"
    ]
    missing_reproducibility_fields: list[str] = []
    if not list(experiment_spec.get("dataset_refs") or []):
        missing_reproducibility_fields.append("dataset_refs")
    if not list(experiment_spec.get("random_seeds") or []):
        missing_reproducibility_fields.append("random_seeds")
    config_reference = experiment_spec.get("config_reference") if isinstance(experiment_spec.get("config_reference"), dict) else {}
    if not config_reference.get("path"):
        missing_reproducibility_fields.append("config_reference")
    code_reference = experiment_spec.get("code_reference") if isinstance(experiment_spec.get("code_reference"), dict) else {}
    if not code_reference.get("commit"):
        missing_reproducibility_fields.append("code_reference")
    baseline_spec = experiment_spec.get("baseline_spec") if isinstance(experiment_spec.get("baseline_spec"), dict) else {}
    if bool(baseline_spec.get("required")) and not list(baseline_spec.get("entities") or []):
        missing_reproducibility_fields.append("baseline_spec")

    validity = "valid"
    if task_status not in TERMINAL_TASK_STATUSES or not result_available or protected_path_violation:
        validity = "invalid"
    elif review_required:
        validity = "review_required"

    result = "inconclusive"
    provisional_result = "inconclusive"
    assessment_basis = "structural_only"
    conflicting_success_criteria = False
    if provided_metrics and bool(runner_metrics_metadata.get("trusted")):
        assessment_basis = "runner_metrics"
    if validity == "invalid":
        result = "invalid"
        provisional_result = "invalid"
    elif not unresolved_success_criteria and assessment_basis == "runner_metrics":
        support_outcomes = _criterion_outcome_statuses(success_criteria, criterion_kind="metric")
        falsification_outcomes = _criterion_outcome_statuses(success_criteria, criterion_kind="falsification")
        support_passed = bool(support_outcomes) and all(status == "pass" for status in support_outcomes)
        falsification_passed = bool(falsification_outcomes) and all(status == "pass" for status in falsification_outcomes)
        conflicting_success_criteria = support_passed and falsification_passed
        if conflicting_success_criteria:
            provisional_result = "inconclusive"
        elif support_passed:
            provisional_result = "supported"
        elif falsification_passed:
            provisional_result = "refuted"

    limitations: list[str] = []
    if assessment_basis == "structural_only":
        limitations.append("assessment_structural_only")
    if unresolved_success_criteria:
        limitations.append("success_criteria_unresolved")
    if missing_reproducibility_fields:
        limitations.append("reproducibility_contract_incomplete")
    if assessment_basis == "runner_metrics":
        outcome_statuses = _criterion_outcome_statuses(success_criteria)
        if "pass" in outcome_statuses and "fail" in outcome_statuses:
            limitations.append("mixed_success_criteria")
    if conflicting_success_criteria:
        limitations.append("conflicting_success_criteria")
    runner_metrics_rejection_reason = str(runner_metrics_metadata.get("rejection_reason") or "").strip()
    if runner_metrics_rejection_reason:
        limitations.append("runner_metrics_rejected")

    promotion_eligible = (
        validity == "valid"
        and not runner_metrics_rejection_reason
        and not conflicting_success_criteria
    )
    adjudication_status = "accepted"
    if validity == "invalid":
        adjudication_status = "rejected"
    elif not promotion_eligible or review_required:
        adjudication_status = "pending_review"
    if validity == "valid" and promotion_eligible:
        result = provisional_result
    elif validity != "invalid":
        result = "inconclusive"

    experiment_id = str(experiment_spec.get("experiment_id") or "").strip() or None
    hypothesis_ids = [str(item) for item in (experiment_spec.get("hypothesis_ids") or []) if str(item or "").strip()]
    baseline_comparison = _baseline_comparison_from_metrics(metrics, baseline_spec)
    return {
        "schema_version": "experiment_result.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "experiment_id": experiment_id,
        "hypothesis_ids": hypothesis_ids,
        "assessment_basis": assessment_basis,
        "evaluator": {
            "kind": "agent_host_experiment_evaluator",
            "version": "v0.2",
        },
        "validity": validity,
        "provisional_result": provisional_result,
        "result": result,
        "final_result": provisional_result if promotion_eligible and validity == "valid" else None,
        "adjudication_status": adjudication_status,
        "promotion_eligible": promotion_eligible,
        "evidence_strength": "metric_backed" if assessment_basis == "runner_metrics" else "structural_only",
        "metrics": metrics,
        "baseline_comparison": baseline_comparison,
        "success_criteria": success_criteria,
        "failure_criteria": failure_criteria,
        "limitations": limitations,
        "runner_metrics_artifact": {
            "present": bool(runner_metrics_metadata.get("present")),
            "trusted": bool(runner_metrics_metadata.get("trusted")),
            "rejection_reason": runner_metrics_rejection_reason or None,
            "schema_version": str(runner_metrics_payload.get("schema_version") or "") or None,
        },
        "reproducibility": {
            "status": "contract_incomplete" if missing_reproducibility_fields else "contract_ready",
            "missing_fields": missing_reproducibility_fields,
            "repeat_count": experiment_spec.get("repeat_count"),
            "random_seeds": list(experiment_spec.get("random_seeds") or []),
        },
        "updated_at": evaluation.get("updated_at"),
    }
