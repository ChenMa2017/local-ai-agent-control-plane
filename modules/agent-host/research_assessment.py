from __future__ import annotations

import datetime as dt
from typing import Any

from post_run_artifacts import claim_boundary_for_evaluation
from promotion_policy import (
    current_conclusions_promotion_state,
    experiment_promotion_state,
    hypothesis_promotion_state,
)

JsonObject = dict[str, Any]
PASS_LIKE_SUCCESS_CRITERION_STATUSES = {"pass", "passed", "met", "success", "satisfied"}
FAIL_LIKE_SUCCESS_CRITERION_STATUSES = {"fail", "failed", "not_met", "unsatisfied"}
EPISTEMIC_SUCCESS_CRITERION_KINDS = {"metric", "falsification"}


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _experiment_failure_criteria(experiment_result: JsonObject | None) -> list[JsonObject]:
    if not isinstance(experiment_result, dict):
        return []
    failure_criteria = experiment_result.get("failure_criteria")
    if not isinstance(failure_criteria, list):
        return []
    return [item for item in failure_criteria if isinstance(item, dict)]


def _success_criterion_is_resolved(item: JsonObject) -> bool:
    status = str(item.get("status") or "").strip().lower()
    kind = str(item.get("kind") or "").strip().lower()
    if kind in EPISTEMIC_SUCCESS_CRITERION_KINDS:
        return status in PASS_LIKE_SUCCESS_CRITERION_STATUSES | FAIL_LIKE_SUCCESS_CRITERION_STATUSES
    return status != "missing"


def _failure_criteria_summary(failure_criteria: list[JsonObject]) -> JsonObject:
    summary = {
        "total": len(failure_criteria),
        "triggered": 0,
        "clear": 0,
        "not_evaluated": 0,
    }
    for item in failure_criteria:
        status = str(item.get("status") or "").strip()
        if status == "triggered":
            summary["triggered"] += 1
        elif status == "clear":
            summary["clear"] += 1
        else:
            summary["not_evaluated"] += 1
    return summary


def build_research_machine_checks(
    evaluation: JsonObject,
    evidence_retrieval: JsonObject,
    hypothesis_registry: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
    review_proposal_draft: JsonObject,
    *,
    hypothesis_promotion_state_value: str,
    experiment_promotion_state_value: str,
    current_conclusion_promotion_state_value: str,
    generated_supporting_experiments: list[str] | None = None,
) -> JsonObject:
    read_plan = evidence_retrieval.get("read_plan") if isinstance(evidence_retrieval.get("read_plan"), list) else []
    hypotheses = hypothesis_registry.get("hypotheses") if isinstance(hypothesis_registry.get("hypotheses"), list) else []
    experiment_hypothesis_ids = [
        str(item)
        for item in (experiment_spec.get("hypothesis_ids") or [])
        if str(item or "").strip()
    ]
    success_criteria = []
    if isinstance(experiment_result, dict) and isinstance(experiment_result.get("success_criteria"), list):
        success_criteria = experiment_result.get("success_criteria") or []
    elif isinstance(experiment_spec.get("success_criteria"), list):
        success_criteria = experiment_spec.get("success_criteria") or []
    failure_criteria = _experiment_failure_criteria(experiment_result)
    triggered_failure_criteria = [
        str(item.get("name") or item.get("criterion_id") or "").strip()
        for item in failure_criteria
        if str(item.get("status") or "").strip() == "triggered"
    ]
    experiment_success_criteria_resolved = True
    if bool(experiment_spec.get("required")):
        experiment_success_criteria_resolved = not any(
            isinstance(item, dict) and not _success_criterion_is_resolved(item)
            for item in success_criteria
        )
    return {
        "schema_valid": True,
        "task_terminal": str(evaluation.get("task_status") or "") in {"done", "failed", "timeout", "stale", "cancelled", "policy_violation"},
        "safe_result_present": bool(evaluation.get("result_available")),
        "read_plan_available": bool(read_plan),
        "write_audit_clean": not bool(((evaluation.get("write_audit") or {}).get("protected_path_violation"))),
        "review_proposal_present": bool(review_proposal_draft),
        "hypothesis_registry_present": bool(hypothesis_registry),
        "hypothesis_candidate_present": bool(hypotheses),
        "experiment_spec_present": bool(experiment_spec),
        "experiment_result_present": (not bool(experiment_spec.get("required"))) or bool(experiment_result),
        "experiment_required": bool(experiment_spec.get("required")),
        "experiment_metric_backed": (
            str((experiment_result or {}).get("assessment_basis") or "") == "runner_metrics"
            if isinstance(experiment_result, dict)
            else False
        ),
        "experiment_promotion_eligible": (
            bool((experiment_result or {}).get("promotion_eligible"))
            if isinstance(experiment_result, dict)
            else False
        ),
        "runner_metrics_artifact_present": (
            bool(((experiment_result or {}).get("runner_metrics_artifact") or {}).get("present"))
            if isinstance(experiment_result, dict)
            else False
        ),
        "runner_metrics_artifact_validated": (
            bool(((experiment_result or {}).get("runner_metrics_artifact") or {}).get("validated"))
            if isinstance(experiment_result, dict)
            else False
        ),
        "runner_metrics_artifact_producer_allowed": (
            bool(((experiment_result or {}).get("runner_metrics_artifact") or {}).get("producer_allowed"))
            if isinstance(experiment_result, dict)
            else False
        ),
        "runner_metrics_artifact_trusted": (
            bool(((experiment_result or {}).get("runner_metrics_artifact") or {}).get("trusted"))
            if isinstance(experiment_result, dict)
            else False
        ),
        "experiment_failure_criteria_present": bool(failure_criteria),
        "experiment_failure_criteria_triggered": bool(triggered_failure_criteria),
        "experiment_failure_criteria_triggered_names": triggered_failure_criteria,
        "experiment_success_criteria_resolved": experiment_success_criteria_resolved,
        "experiment_has_hypothesis_binding": (not bool(experiment_spec.get("required"))) or bool(experiment_hypothesis_ids),
        "generated_supporting_experiments_present": (not bool(experiment_spec.get("required"))) or bool(generated_supporting_experiments),
        "evidence_safe_to_answer": str(evaluation.get("evidence_retrieval_decision") or "") == "safe_to_answer",
        "human_review_required": bool(review_proposal_draft.get("requires_human_review")),
        "hypothesis_promotion_ready": hypothesis_promotion_state_value in {"candidate_ready", "review_required", "human_review_required"},
        "experiment_promotion_ready": experiment_promotion_state_value in {"candidate_ready", "review_required", "human_review_required"},
        "current_conclusion_promotion_ready": current_conclusion_promotion_state_value in {"candidate_ready", "review_required", "bounded_only", "human_review_required"},
    }


def build_research_validity(
    machine_checks: JsonObject,
    *,
    hypothesis_promotion_state_value: str,
    experiment_promotion_state_value: str,
    current_conclusion_promotion_state_value: str,
) -> JsonObject:
    blocking_reasons: list[str] = []
    limitations: list[str] = []
    if not machine_checks.get("task_terminal"):
        blocking_reasons.append("task_not_terminal")
    if not machine_checks.get("safe_result_present"):
        blocking_reasons.append("missing_safe_result_excerpt")
    if not machine_checks.get("write_audit_clean"):
        blocking_reasons.append("write_audit_not_clean")
    if machine_checks.get("experiment_required") and not machine_checks.get("experiment_result_present"):
        blocking_reasons.append("experiment_result_missing")
    if not machine_checks.get("experiment_has_hypothesis_binding"):
        blocking_reasons.append("experiment_missing_hypothesis_binding")
    if not machine_checks.get("read_plan_available"):
        limitations.append("read_plan_missing")
    if not machine_checks.get("evidence_safe_to_answer"):
        limitations.append("safe_to_answer_not_confirmed")
    if machine_checks.get("runner_metrics_artifact_present") and not machine_checks.get("runner_metrics_artifact_trusted"):
        limitations.append("runner_metrics_rejected")
    if machine_checks.get("experiment_required") and not machine_checks.get("experiment_success_criteria_resolved"):
        limitations.append("success_criteria_not_resolved")
    if machine_checks.get("experiment_failure_criteria_triggered"):
        limitations.append("failure_criteria_triggered")
    if hypothesis_promotion_state_value == "review_required":
        limitations.append("hypothesis_review_required")
    if experiment_promotion_state_value == "review_required":
        limitations.append("experiment_review_required")
    if current_conclusion_promotion_state_value == "bounded_only":
        limitations.append("conclusion_bounded_only")
    if machine_checks.get("human_review_required"):
        limitations.append("human_review_required")

    status = "valid_metric_backed" if machine_checks.get("experiment_metric_backed") else "valid_structural_only"
    if blocking_reasons:
        status = "invalid"
    elif machine_checks.get("human_review_required"):
        status = "review_required"
    elif limitations:
        status = "valid_with_limitations"
    return {
        "status": status,
        "blocking_reasons": blocking_reasons,
        "limitations": limitations,
    }


def build_hypothesis_assessment(
    hypothesis_registry: JsonObject,
    hypothesis_update: JsonObject | None,
    *,
    hypothesis_promotion_state_value: str,
) -> JsonObject:
    hypotheses = hypothesis_registry.get("hypotheses") if isinstance(hypothesis_registry.get("hypotheses"), list) else []
    first = hypothesis_update if isinstance(hypothesis_update, dict) and hypothesis_update else (
        hypotheses[0] if hypotheses and isinstance(hypotheses[0], dict) else {}
    )
    hypothesis_id = str(first.get("hypothesis_id") or "").strip() or None
    confidence = first.get("confidence") if isinstance(first.get("confidence"), dict) else {}
    confidence_value = confidence.get("value")
    if not isinstance(confidence_value, (int, float)):
        confidence_value = None
    assessment = {
        "not_required": "not_applicable",
        "not_ready": "not_ready",
        "review_required": "review_required",
        "candidate_ready": "active_candidate",
        "human_review_required": "human_review_required",
    }.get(hypothesis_promotion_state_value, "not_applicable")
    return {
        "hypothesis_id": hypothesis_id,
        "assessment": assessment,
        "confidence": confidence_value,
        "assessment_basis": str(first.get("assessment_basis") or "structural_only"),
        "status_candidate": str(first.get("status") or "") or None,
        "status_reason": str(first.get("status_reason") or "") or None,
        "status_blockers": [
            str(item).strip()
            for item in (first.get("status_blockers") or [])
            if str(item or "").strip()
        ],
        "evaluation_result": str(first.get("evaluation_result") or "") or None,
        "evaluation_validity": str(first.get("evaluation_validity") or "") or None,
    }


def build_experiment_assessment(
    experiment_spec: JsonObject,
    experiment_index_update: JsonObject | None,
    experiment_result: JsonObject | None,
    *,
    experiment_promotion_state_value: str,
) -> JsonObject:
    experiment_id = None
    if isinstance(experiment_index_update, dict) and experiment_index_update:
        experiment_id = str(experiment_index_update.get("experiment_id") or "").strip() or None
    if experiment_id is None:
        experiment_id = str(experiment_spec.get("experiment_id") or "").strip() or None
    assessment = {
        "not_required": "not_applicable",
        "not_ready": "not_ready",
        "review_required": "review_required",
        "candidate_ready": "candidate_recorded",
        "human_review_required": "human_review_required",
    }.get(experiment_promotion_state_value, "not_applicable")
    failure_criteria = _experiment_failure_criteria(experiment_result)
    triggered_failure_criteria = [
        str(item.get("name") or item.get("criterion_id") or "").strip()
        for item in failure_criteria
        if str(item.get("status") or "").strip() == "triggered"
    ]
    return {
        "experiment_id": experiment_id,
        "assessment": assessment,
        "assessment_basis": (
            str((experiment_result or {}).get("assessment_basis") or "structural_only")
            if isinstance(experiment_result, dict)
            else "structural_only"
        ),
        "result": (
            str((experiment_result or {}).get("result") or "").strip()
            if isinstance(experiment_result, dict)
            else None
        ),
        "validity": (
            str((experiment_result or {}).get("validity") or "").strip()
            if isinstance(experiment_result, dict)
            else None
        ),
        "status_candidate": (
            str((experiment_index_update or {}).get("status") or "").strip()
            if isinstance(experiment_index_update, dict)
            else None
        ),
        "failure_criteria_triggered": triggered_failure_criteria,
        "failure_criteria_summary": _failure_criteria_summary(failure_criteria),
    }


def build_conclusion_assessment(
    *,
    current_conclusion_promotion_state_value: str,
    evidence_decision: str,
) -> JsonObject:
    assessment = {
        "not_ready": "not_ready",
        "bounded_only": "bounded_only",
        "review_required": "review_required",
        "candidate_ready": "candidate_ready",
        "human_review_required": "human_review_required",
    }.get(current_conclusion_promotion_state_value, "not_ready")
    return {
        "assessment": assessment,
        "assessment_basis": "structural_only",
        "evidence_decision": evidence_decision or None,
    }


def build_evaluation_report(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    hypothesis_registry: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
    review_proposal_draft: JsonObject,
    *,
    hypothesis_promotion: JsonObject | None = None,
    experiment_promotion: JsonObject | None = None,
) -> JsonObject:
    promotion_state = current_conclusions_promotion_state(evaluation, review_proposal_draft, research_program)
    hypothesis_promotion_state_value = str((hypothesis_promotion or {}).get("promotion_state") or "")
    if not hypothesis_promotion_state_value:
        hypothesis_promotion_state_value = hypothesis_promotion_state(
            evaluation,
            hypothesis_registry,
            review_proposal_draft,
            experiment_spec,
            experiment_result,
        )
    experiment_promotion_state_value = str((experiment_promotion or {}).get("promotion_state") or "")
    if not experiment_promotion_state_value:
        experiment_promotion_state_value = experiment_promotion_state(
            evaluation,
            experiment_spec,
            research_program,
            review_proposal_draft,
            experiment_result,
        )
    experiment_index_update = (
        experiment_promotion.get("experiment_index_update")
        if isinstance(experiment_promotion, dict) and isinstance(experiment_promotion.get("experiment_index_update"), dict)
        else {}
    )
    hypothesis_update = (
        hypothesis_promotion.get("hypothesis_update")
        if isinstance(hypothesis_promotion, dict) and isinstance(hypothesis_promotion.get("hypothesis_update"), dict)
        else {}
    )
    generated_supporting_experiments = []
    experiment_id = str(experiment_index_update.get("experiment_id") or "").strip()
    if experiment_id:
        generated_supporting_experiments.append(experiment_id)
    machine_checks = build_research_machine_checks(
        evaluation,
        evidence_retrieval,
        hypothesis_registry,
        experiment_spec,
        experiment_result,
        review_proposal_draft,
        hypothesis_promotion_state_value=hypothesis_promotion_state_value,
        experiment_promotion_state_value=experiment_promotion_state_value,
        current_conclusion_promotion_state_value=promotion_state,
        generated_supporting_experiments=generated_supporting_experiments,
    )
    validity = build_research_validity(
        machine_checks,
        hypothesis_promotion_state_value=hypothesis_promotion_state_value,
        experiment_promotion_state_value=experiment_promotion_state_value,
        current_conclusion_promotion_state_value=promotion_state,
    )
    return {
        "schema_version": "evaluation_report.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "objective": str(contract.get("objective") or evaluation.get("objective") or ""),
        "research_program_id": str(research_program.get("program_id") or ""),
        "task_status": evaluation.get("task_status"),
        "execution_decision": evaluation.get("execution_decision"),
        "recommended_next_action": evaluation.get("recommended_next_action"),
        "summary": evaluation.get("summary"),
        "claim_boundary": claim_boundary_for_evaluation(evaluation),
        "safe_result_excerpt": evaluation.get("safe_result_excerpt"),
        "created_by": "agent_host_evaluator_stub",
        "assessment_basis": (
            str((experiment_result or {}).get("assessment_basis") or "structural_only")
            if isinstance(experiment_result, dict)
            else "structural_only"
        ),
        "machine_checks": machine_checks,
        "validity": validity,
        "experiment_result": experiment_result or None,
        "hypothesis_assessment": build_hypothesis_assessment(
            hypothesis_registry,
            hypothesis_update,
            hypothesis_promotion_state_value=hypothesis_promotion_state_value,
        ),
        "experiment_assessment": build_experiment_assessment(
            experiment_spec,
            experiment_index_update,
            experiment_result,
            experiment_promotion_state_value=experiment_promotion_state_value,
        ),
        "conclusion_assessment": build_conclusion_assessment(
            current_conclusion_promotion_state_value=promotion_state,
            evidence_decision=str(evaluation.get("evidence_retrieval_decision") or ""),
        ),
        "warnings": list(evaluation.get("warnings") or []),
        "evidence_retrieval_decision": evaluation.get("evidence_retrieval_decision"),
        "read_plan": list(evidence_retrieval.get("read_plan") or []),
        "hypothesis_promotion_state": hypothesis_promotion_state_value,
        "experiment_required": bool(experiment_spec.get("required")),
        "experiment_promotion_state": experiment_promotion_state_value,
        "review_scope": str(review_proposal_draft.get("review_scope") or "none"),
        "requires_human_review": bool(review_proposal_draft.get("requires_human_review")),
        "current_conclusions_promotion_state": promotion_state,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }
