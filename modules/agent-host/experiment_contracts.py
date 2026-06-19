from __future__ import annotations

from typing import Any

JsonObject = dict[str, Any]

TERMINAL_TASK_STATUSES = {"done", "failed", "timeout", "stale", "cancelled", "policy_violation"}
PASS_STATUSES = {"pass", "passed", "met", "success", "satisfied"}
FAIL_STATUSES = {"fail", "failed", "not_met", "unsatisfied"}


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
            for field in ("value", "notes", "unit", "status", "target", "baseline_value", "baseline_delta", "source"):
                if field in provided:
                    merged[field] = provided.get(field)
            if "higher_is_better" in provided and provided.get("higher_is_better") is not None:
                merged["higher_is_better"] = provided.get("higher_is_better")
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
    for item in provided_metrics:
        if not isinstance(item, dict):
            continue
        key = _metric_key(item)
        if not key or key in seen_keys:
            continue
        extra = dict(item)
        if not _normalized_outcome_status(extra.get("status")) and isinstance(extra.get("target"), dict):
            evaluated = _evaluate_target(extra.get("value"), extra.get("target"))
            if evaluated is True:
                extra["status"] = "pass"
            elif evaluated is False:
                extra["status"] = "fail"
        metrics.append(extra)
    return metrics


def _merge_success_criteria(
    success_criteria: list[JsonObject],
    provided_criteria: list[JsonObject],
    metrics: list[JsonObject],
) -> list[JsonObject]:
    criteria_index = {
        _criterion_key(item): dict(item)
        for item in provided_criteria
        if isinstance(item, dict) and _criterion_key(item)
    }
    metric_index = {
        _metric_key(item): item
        for item in metrics
        if isinstance(item, dict) and _metric_key(item)
    }
    merged_criteria: list[JsonObject] = []
    seen_keys: set[str] = set()
    for item in success_criteria:
        if not isinstance(item, dict):
            continue
        merged = dict(item)
        key = _criterion_key(merged)
        provided = criteria_index.get(key) if key else None
        if isinstance(provided, dict):
            merged.update(provided)
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
        if key:
            seen_keys.add(key)
    for item in provided_criteria:
        if not isinstance(item, dict):
            continue
        key = _criterion_key(item)
        if not key or key in seen_keys:
            continue
        extra = dict(item)
        metric_name = str(extra.get("metric_name") or "").strip().lower()
        metric = metric_index.get(metric_name) if metric_name else None
        if not _normalized_outcome_status(extra.get("status")) and isinstance(metric, dict):
            metric_status = _normalized_outcome_status(metric.get("status"))
            if metric_status is not None:
                extra["status"] = metric_status
            elif isinstance(extra.get("target"), dict):
                evaluated = _evaluate_target(metric.get("value"), extra.get("target"))
                if evaluated is True:
                    extra["status"] = "pass"
                elif evaluated is False:
                    extra["status"] = "fail"
        merged_criteria.append(extra)
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
) -> JsonObject:
    task_status = str(evaluation.get("task_status") or "")
    result_available = bool(evaluation.get("result_available"))
    protected_path_violation = bool(((evaluation.get("write_audit") or {}).get("protected_path_violation")))
    success_criteria = (
        list(experiment_spec.get("success_criteria") or [])
        if isinstance(experiment_spec.get("success_criteria"), list)
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
    provided_metrics = (
        list(runner_metrics_payload.get("metrics") or [])
        if isinstance(runner_metrics_payload.get("metrics"), list)
        else []
    )
    provided_success_criteria = (
        list(runner_metrics_payload.get("success_criteria") or [])
        if isinstance(runner_metrics_payload.get("success_criteria"), list)
        else []
    )
    metrics = _merge_metric_items(
        metric_definitions,
        provided_metrics,
        result_available=result_available,
    )
    success_criteria = _merge_success_criteria(
        success_criteria,
        provided_success_criteria,
        metrics,
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
    assessment_basis = "structural_only"
    if provided_metrics or provided_success_criteria or str(runner_metrics_payload.get("result") or "").strip():
        assessment_basis = "runner_metrics"
    if validity == "invalid":
        result = "invalid"
    elif not unresolved_success_criteria and assessment_basis == "runner_metrics":
        outcome_statuses = [
            normalized
            for normalized in (
                _normalized_outcome_status(item.get("status"))
                for item in success_criteria
                if isinstance(item, dict)
            )
            if normalized is not None
        ]
        explicit_result = str(runner_metrics_payload.get("result") or "").strip().lower()
        if outcome_statuses:
            if all(status == "pass" for status in outcome_statuses):
                result = "supported"
            elif all(status == "fail" for status in outcome_statuses):
                result = "refuted"
        elif explicit_result in {"supported", "refuted", "inconclusive"}:
            result = explicit_result

    limitations: list[str] = []
    if assessment_basis == "structural_only":
        limitations.append("assessment_structural_only")
    if unresolved_success_criteria:
        limitations.append("success_criteria_unresolved")
    if missing_reproducibility_fields:
        limitations.append("reproducibility_contract_incomplete")
    if assessment_basis == "runner_metrics":
        outcome_statuses = [
            normalized
            for normalized in (
                _normalized_outcome_status(item.get("status"))
                for item in success_criteria
                if isinstance(item, dict)
            )
            if normalized is not None
        ]
        if "pass" in outcome_statuses and "fail" in outcome_statuses:
            limitations.append("mixed_success_criteria")

    experiment_id = str(experiment_spec.get("experiment_id") or "").strip() or None
    hypothesis_ids = [str(item) for item in (experiment_spec.get("hypothesis_ids") or []) if str(item or "").strip()]
    baseline_comparison = (
        runner_metrics_payload.get("baseline_comparison")
        if isinstance(runner_metrics_payload.get("baseline_comparison"), dict)
        else {}
    )
    if not baseline_comparison:
        baseline_comparison = {
            "status": "not_available",
            "baseline_required": baseline_spec.get("required"),
            "baseline_entities": list(baseline_spec.get("entities") or []),
        }
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
        "result": result,
        "evidence_strength": "metric_backed" if assessment_basis == "runner_metrics" else "structural_only",
        "metrics": metrics,
        "baseline_comparison": baseline_comparison,
        "success_criteria": success_criteria,
        "limitations": limitations,
        "reproducibility": {
            "status": "contract_incomplete" if missing_reproducibility_fields else "contract_ready",
            "missing_fields": missing_reproducibility_fields,
            "repeat_count": experiment_spec.get("repeat_count"),
            "random_seeds": list(experiment_spec.get("random_seeds") or []),
        },
        "updated_at": evaluation.get("updated_at"),
    }
