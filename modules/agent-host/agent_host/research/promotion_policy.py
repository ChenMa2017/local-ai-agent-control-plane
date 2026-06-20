from __future__ import annotations

from typing import Any

JsonObject = dict[str, Any]


def experiment_promotion_state(
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    research_program: JsonObject,
    review_proposal_draft: JsonObject,
    experiment_result: JsonObject | None = None,
) -> str:
    if not bool(experiment_spec.get("required")):
        return "not_required"
    next_action = str(evaluation.get("recommended_next_action") or "")
    if next_action == "human_review" or bool(review_proposal_draft.get("requires_human_review")):
        return "human_review_required"
    if not evaluation.get("result_available") or str(evaluation.get("task_status") or "") != "done":
        return "not_ready"
    if isinstance(experiment_result, dict) and experiment_result and not bool(experiment_result.get("promotion_eligible")):
        return "review_required"
    if bool(research_program.get("publish_only_after_review")) or review_proposal_draft:
        return "review_required"
    return "candidate_ready"


def hypothesis_promotion_state(
    evaluation: JsonObject,
    hypothesis_registry: JsonObject,
    review_proposal_draft: JsonObject,
    experiment_spec: JsonObject | None = None,
    experiment_result: JsonObject | None = None,
) -> str:
    hypotheses = hypothesis_registry.get("hypotheses") if isinstance(hypothesis_registry.get("hypotheses"), list) else []
    if not hypotheses:
        return "not_required"
    registry_status = str(hypothesis_registry.get("registry_status") or "")
    next_action = str(evaluation.get("recommended_next_action") or "")
    if registry_status == "analysis_only":
        return "not_required"
    if next_action == "human_review" or bool(review_proposal_draft.get("requires_human_review")):
        return "human_review_required"
    if registry_status == "needs_clarification":
        return "review_required"
    if str(evaluation.get("task_status") or "") != "done":
        return "not_ready"
    if bool((experiment_spec or {}).get("required")) and isinstance(experiment_result, dict) and experiment_result:
        if not bool(experiment_result.get("promotion_eligible")):
            return "review_required"
    return "candidate_ready"


def current_conclusions_promotion_state(
    evaluation: JsonObject,
    review_proposal_draft: JsonObject,
    research_program: JsonObject,
) -> str:
    task_status = str(evaluation.get("task_status") or "")
    next_action = str(evaluation.get("recommended_next_action") or "")
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    if task_status != "done" or not evaluation.get("result_available"):
        return "not_ready"
    if next_action == "human_review" or bool(review_proposal_draft.get("requires_human_review")):
        return "human_review_required"
    if evidence_decision not in {"", "safe_to_answer"}:
        return "bounded_only"
    if bool(research_program.get("publish_only_after_review")) or review_proposal_draft:
        return "review_required"
    return "candidate_ready"
