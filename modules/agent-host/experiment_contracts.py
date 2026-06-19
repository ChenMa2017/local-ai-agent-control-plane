from __future__ import annotations

from typing import Any

JsonObject = dict[str, Any]

TERMINAL_TASK_STATUSES = {"done", "failed", "timeout", "stale", "cancelled", "policy_violation"}


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
) -> JsonObject:
    task_status = str(evaluation.get("task_status") or "")
    result_available = bool(evaluation.get("result_available"))
    protected_path_violation = bool(((evaluation.get("write_audit") or {}).get("protected_path_violation")))
    success_criteria = (
        list(experiment_spec.get("success_criteria") or [])
        if isinstance(experiment_spec.get("success_criteria"), list)
        else []
    )
    unresolved_success_criteria = [
        str(item.get("name") or item.get("criterion_id") or "")
        for item in success_criteria
        if isinstance(item, dict) and str(item.get("status") or "") == "missing"
    ]
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
    metrics: list[JsonObject] = []
    for item in metric_definitions:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        metric = dict(item)
        if name == "safe_result_available":
            metric["value"] = 1 if result_available else 0
            metric["notes"] = (
                "Execution produced a non-empty safe result excerpt."
                if result_available
                else "Execution did not produce a safe result excerpt."
            )
        else:
            metric["value"] = None
            metric["notes"] = "Structured runner metrics are not yet exported for this experiment."
        metrics.append(metric)
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
    if validity == "invalid":
        result = "invalid"

    limitations = ["assessment_structural_only"]
    if unresolved_success_criteria:
        limitations.append("success_criteria_unresolved")
    if missing_reproducibility_fields:
        limitations.append("reproducibility_contract_incomplete")

    experiment_id = str(experiment_spec.get("experiment_id") or "").strip() or None
    hypothesis_ids = [str(item) for item in (experiment_spec.get("hypothesis_ids") or []) if str(item or "").strip()]
    return {
        "schema_version": "experiment_result.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "experiment_id": experiment_id,
        "hypothesis_ids": hypothesis_ids,
        "assessment_basis": "structural_only",
        "evaluator": {
            "kind": "agent_host_structural_evaluator",
            "version": "v0.1",
        },
        "validity": validity,
        "result": result,
        "evidence_strength": "structural_only",
        "metrics": metrics,
        "baseline_comparison": {
            "status": "not_available",
            "baseline_required": baseline_spec.get("required"),
            "baseline_entities": list(baseline_spec.get("entities") or []),
        },
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
