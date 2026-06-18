from __future__ import annotations

import datetime as dt
import json
from typing import Any

JsonObject = dict[str, Any]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def summary_timestamp(*candidates: Any) -> str:
    for value in candidates:
        text = str(value or "").strip()
        if text:
            return text
    return utc_now().isoformat().replace("+00:00", "Z")


def action_payload(
    *,
    kind: str,
    description: str,
    reason: str,
    can_execute_automatically: bool,
    target_path: str | None = None,
) -> JsonObject:
    return {
        "kind": kind,
        "description": description,
        "reason": reason,
        "can_execute_automatically": can_execute_automatically,
        "target_path": target_path,
    }


def blocker_payload(
    *,
    kind: str,
    description: str,
    reason: str,
    can_execute_automatically: bool,
) -> JsonObject:
    return {
        "kind": kind,
        "description": description,
        "reason": reason,
        "can_execute_automatically": can_execute_automatically,
    }


def current_conclusion_operator_context(promotion: JsonObject | None) -> tuple[str, str | None, str, str]:
    if not isinstance(promotion, dict):
        return "", None, "", ""
    notes = [str(item) for item in (promotion.get("notes") or []) if str(item or "").strip()]
    decision = str(promotion.get("decision") or "").strip()
    state = str(promotion.get("promotion_state") or "").strip()
    project_sync = promotion.get("project_sync") if isinstance(promotion.get("project_sync"), dict) else {}
    sync_status = str(project_sync.get("status") or "").strip()
    target_path = (
        str(project_sync.get("target_path") or "").strip()
        or str(promotion.get("review_proposal_path_hint") or "").strip()
        or str(promotion.get("target_path_hint") or "").strip()
        or None
    )
    if notes:
        return notes[0], target_path, sync_status, decision
    if decision == "bounded_only_do_not_publish":
        return (
            "The current conclusion stays bounded until evidence retrieval can support a safe_to_answer publication path.",
            target_path,
            sync_status,
            decision,
        )
    if sync_status == "review_bundle_written":
        return (
            "A current conclusion review bundle was written and needs operator resolution before publication.",
            target_path,
            sync_status,
            decision,
        )
    if state == "review_required":
        return (
            "The current conclusion is structurally ready, but publication still requires review.",
            target_path,
            sync_status,
            decision,
        )
    if state == "human_review_required":
        return (
            "A human decision is still required before any conclusion promotion.",
            target_path,
            sync_status,
            decision,
        )
    return state or decision or sync_status, target_path, sync_status, decision


def build_prepare_operator_summary(
    intent: JsonObject,
    contract: JsonObject,
    taskbox: JsonObject,
    preflight: JsonObject,
    evidence_retrieval: JsonObject,
    questions: list[str],
) -> JsonObject:
    blocked_by = [str(item) for item in (preflight.get("blocked_by") or []) if str(item or "").strip()]
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    unresolved_items = [str(item) for item in (decision_gate.get("unresolved_items") or []) if str(item or "").strip()]
    blockers: list[JsonObject] = []
    unmet_requirements: list[str] = []
    if questions:
        blockers.append(
            blocker_payload(
                kind="clarification_required",
                description="Clarification questions are still open.",
                reason=questions[0],
                can_execute_automatically=False,
            )
        )
        unmet_requirements.extend(questions)
    if decision_gate.get("required") and decision_gate.get("blocking"):
        reason = ", ".join(unresolved_items) or "The experiment decision gate is still unresolved."
        blockers.append(
            blocker_payload(
                kind="experiment_decision_gate_required",
                description="The experiment decision gate is blocking execution.",
                reason=reason,
                can_execute_automatically=False,
            )
        )
        unmet_requirements.extend(unresolved_items)
    if "human_review_required" in blocked_by:
        blockers.append(
            blocker_payload(
                kind="human_review_required",
                description="A human decision is required before execution.",
                reason="The current task objective or risk class requires explicit approval.",
                can_execute_automatically=False,
            )
        )
    evidence_decision = str(evidence_retrieval.get("decision") or "").strip()
    if bool(evidence_retrieval.get("required")) and not bool(evidence_retrieval.get("consulted")):
        unmet_requirements.append("evidence_retrieval_unavailable")
        blockers.append(
            blocker_payload(
                kind="evidence_retrieval_unavailable",
                description="Evidence retrieval was required but not available.",
                reason="The workspace could not provide the expected evidence index for this request.",
                can_execute_automatically=False,
            )
        )

    required_action = str(preflight.get("required_action") or "prepare").strip() or "prepare"
    if required_action == "run":
        next_safe_action = action_payload(
            kind="queue_run",
            description="Queue the prepared bounded task.",
            reason="Prepare checks passed and the intake is ready to run.",
            can_execute_automatically=True,
        )
    elif required_action == "reply_to_questions":
        next_safe_action = action_payload(
            kind="reply_to_questions",
            description="Answer the outstanding clarification questions.",
            reason=questions[0] if questions else "The intake still has unresolved clarification questions.",
            can_execute_automatically=False,
        )
    else:
        next_safe_action = action_payload(
            kind="human_review",
            description="Review the blocked gate before any run is queued.",
            reason="Prepare checks require human review before the task can proceed.",
            can_execute_automatically=False,
        )

    overall_status = "ready_to_run"
    if blockers:
        overall_status = "human_review_required" if any(item.get("kind") == "human_review_required" for item in blockers) else "blocked"

    if overall_status == "ready_to_run":
        operator_message = "Prepare is complete and the bounded task is ready to run."
    elif any(item.get("kind") == "clarification_required" for item in blockers):
        operator_message = "Prepare is blocked on clarification; answer the open questions before rerunning prepare."
    elif any(item.get("kind") == "experiment_decision_gate_required" for item in blockers):
        operator_message = "Prepare is blocked on an unresolved experiment decision gate."
    else:
        operator_message = "Prepare is blocked until a human resolves the current safety or approval requirement."

    return {
        "schema_version": "operator_summary.v0.1",
        "intake_id": intent.get("intake_id") or contract.get("intake_id"),
        "workspace": intent.get("workspace") or contract.get("workspace"),
        "phase": "prepare",
        "source_task_id": None,
        "overall_status": overall_status,
        "blocked": bool(blockers),
        "operator_message": operator_message,
        "evidence_decision": evidence_decision or None,
        "prepare_gate_status": str(taskbox.get("experiment_gate_status") or "").strip() or None,
        "promotion_states": {},
        "blockers": blockers,
        "unmet_requirements": unmet_requirements,
        "next_safe_action": next_safe_action,
        "updated_at": summary_timestamp(
            contract.get("updated_at"),
            intent.get("updated_at"),
        ),
    }


def build_post_run_operator_summary(
    evaluation: JsonObject,
    followup_task_draft: JsonObject | None,
    review_proposal_draft: JsonObject | None,
    hypothesis_promotion: JsonObject | None,
    experiment_promotion: JsonObject | None,
    current_conclusion_promotion: JsonObject | None,
    evaluation_report: JsonObject | None,
    current_conclusions: JsonObject | None,
) -> JsonObject:
    blockers: list[JsonObject] = []
    unmet_requirements: list[str] = []
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "").strip()
    recommended_next_action = str(evaluation.get("recommended_next_action") or "").strip()
    validity = evaluation_report.get("validity") if isinstance(evaluation_report, dict) and isinstance(evaluation_report.get("validity"), dict) else {}
    limitations = [str(item) for item in (validity.get("limitations") or []) if str(item or "").strip()]
    blocking_reasons = [str(item) for item in (validity.get("blocking_reasons") or []) if str(item or "").strip()]
    unmet_requirements.extend(limitations)
    unmet_requirements.extend(blocking_reasons)

    if recommended_next_action == "inspect_logs":
        blockers.append(
            blocker_payload(
                kind="execution_failed",
                description="The task did not finish cleanly.",
                reason=str(evaluation.get("summary") or "Inspect the safe logs before planning any retry."),
                can_execute_automatically=False,
            )
        )
    if recommended_next_action == "human_review":
        blockers.append(
            blocker_payload(
                kind="human_review_required",
                description="A human review is required before any retry or promotion.",
                reason=str(evaluation.get("summary") or "The task hit a policy boundary."),
                can_execute_automatically=False,
            )
        )
    if evidence_decision and evidence_decision != "safe_to_answer":
        blockers.append(
            blocker_payload(
                kind="bounded_claim_review",
                description="The result remains bounded and cannot be treated as a formal safe answer yet.",
                reason=f"Evidence retrieval returned {evidence_decision}.",
                can_execute_automatically=False,
            )
        )
    if isinstance(review_proposal_draft, dict) and review_proposal_draft:
        blockers.append(
            blocker_payload(
                kind="review_proposal_required",
                description="A review proposal is waiting for operator resolution.",
                reason=str(review_proposal_draft.get("summary") or review_proposal_draft.get("reason") or "Review is required."),
                can_execute_automatically=False,
            )
        )

    transition_candidates = [
        ("hypothesis_transition_review", hypothesis_promotion),
        ("experiment_transition_review", experiment_promotion),
    ]
    for kind, promotion in transition_candidates:
        if not isinstance(promotion, dict):
            continue
        project_sync = promotion.get("project_sync") if isinstance(promotion.get("project_sync"), dict) else {}
        if str(project_sync.get("status") or "") != "transition_review_required":
            continue
        transition_validation = project_sync.get("transition_validation") if isinstance(project_sync.get("transition_validation"), dict) else {}
        blockers.append(
            blocker_payload(
                kind=kind,
                description="A project-level state transition needs review before it can be applied.",
                reason=str(transition_validation.get("reason") or "transition_review_required"),
                can_execute_automatically=False,
            )
        )
        unmet_requirements.append(str(transition_validation.get("reason") or "transition_review_required"))

    conclusion_state = ""
    current_conclusion_reason = ""
    current_conclusion_target_path: str | None = None
    current_conclusion_sync_status = ""
    current_conclusion_decision = ""
    if isinstance(current_conclusion_promotion, dict):
        conclusion_state = str(current_conclusion_promotion.get("promotion_state") or "").strip()
        (
            current_conclusion_reason,
            current_conclusion_target_path,
            current_conclusion_sync_status,
            current_conclusion_decision,
        ) = current_conclusion_operator_context(current_conclusion_promotion)
    if conclusion_state in {"review_required", "human_review_required", "bounded_only"}:
        description = "The current conclusion cannot yet be promoted to a fully reusable result."
        if current_conclusion_sync_status == "review_bundle_written":
            description = "A current conclusion review bundle is waiting for operator resolution."
        elif conclusion_state == "bounded_only":
            description = "The current conclusion remains bounded and cannot be published yet."
        elif conclusion_state == "human_review_required":
            description = "A human decision is still required before the current conclusion can be promoted."
        blockers.append(
            blocker_payload(
                kind="current_conclusion_gate",
                description=description,
                reason=current_conclusion_reason or conclusion_state,
                can_execute_automatically=False,
            )
        )
        for item in (conclusion_state, current_conclusion_decision, current_conclusion_sync_status):
            if item and item not in unmet_requirements:
                unmet_requirements.append(item)

    next_safe_action: JsonObject
    hypothesis_sync = hypothesis_promotion.get("project_sync") if isinstance(hypothesis_promotion, dict) and isinstance(hypothesis_promotion.get("project_sync"), dict) else {}
    experiment_sync = experiment_promotion.get("project_sync") if isinstance(experiment_promotion, dict) and isinstance(experiment_promotion.get("project_sync"), dict) else {}
    if str(hypothesis_sync.get("status") or "") == "transition_review_required":
        next_safe_action = action_payload(
            kind="review_hypothesis_transition_bundle",
            description="Review the generated hypothesis transition bundle before applying it to the project registry.",
            reason=str(((hypothesis_sync.get("transition_validation") or {}).get("reason")) or "transition_review_required"),
            can_execute_automatically=False,
            target_path=str(hypothesis_sync.get("target_path") or "") or None,
        )
    elif str(experiment_sync.get("status") or "") == "transition_review_required":
        next_safe_action = action_payload(
            kind="review_experiment_transition_bundle",
            description="Review the generated experiment transition bundle before applying it to the project index.",
            reason=str(((experiment_sync.get("transition_validation") or {}).get("reason")) or "transition_review_required"),
            can_execute_automatically=False,
            target_path=str(experiment_sync.get("target_path") or "") or None,
        )
    elif isinstance(review_proposal_draft, dict) and review_proposal_draft:
        next_safe_action = action_payload(
            kind="resolve_review_proposal",
            description=str(review_proposal_draft.get("suggested_reviewer_action") or review_proposal_draft.get("title") or "Resolve the review proposal."),
            reason=current_conclusion_reason or str(review_proposal_draft.get("summary") or review_proposal_draft.get("reason") or "Review is required."),
            can_execute_automatically=False,
            target_path=current_conclusion_target_path,
        )
    elif conclusion_state in {"review_required", "human_review_required", "bounded_only"}:
        next_safe_action = action_payload(
            kind=(
                "review_current_conclusion_bundle"
                if current_conclusion_sync_status == "review_bundle_written"
                else "review_bounded_conclusion"
            ),
            description=(
                "Review the generated current conclusion bundle before publication."
                if current_conclusion_sync_status == "review_bundle_written"
                else "Review the bounded current conclusion gate before broader reuse."
            ),
            reason=current_conclusion_reason or "Current conclusion promotion is still blocked.",
            can_execute_automatically=False,
            target_path=current_conclusion_target_path,
        )
    elif isinstance(followup_task_draft, dict) and followup_task_draft:
        next_safe_action = action_payload(
            kind=str(followup_task_draft.get("recommended_next_action") or "prepare_followup"),
            description=str(followup_task_draft.get("title") or "Prepare the next bounded step."),
            reason=str(followup_task_draft.get("summary") or "Use the follow-up draft as the next bounded step."),
            can_execute_automatically=str(followup_task_draft.get("recommended_next_action") or "") != "human_review",
        )
    else:
        next_safe_action = action_payload(
            kind="wait",
            description="Wait for a clearer terminal result before taking the next step.",
            reason="No follow-up draft is currently available.",
            can_execute_automatically=False,
        )

    promotion_states = {
        "hypothesis": str((hypothesis_promotion or {}).get("promotion_state") or "").strip() or None,
        "experiment": str((experiment_promotion or {}).get("promotion_state") or "").strip() or None,
        "current_conclusion": conclusion_state or None,
        "current_conclusions_candidate": (
            str((current_conclusions or {}).get("promotion_state") or "").strip()
            if isinstance(current_conclusions, dict)
            else None
        ),
    }

    overall_status = "followup_ready"
    if str(evaluation.get("task_status") or "") != "done":
        overall_status = "not_ready"
    elif any(item.get("kind") in {"execution_failed", "human_review_required"} for item in blockers):
        overall_status = "blocked"
    elif blockers:
        overall_status = "review_required"
    elif any(value == "candidate_ready" for value in promotion_states.values() if isinstance(value, str)):
        overall_status = "promotion_ready"

    if overall_status == "promotion_ready":
        operator_message = "The result is structurally ready for bounded promotion and follow-up."
    elif overall_status == "review_required":
        if current_conclusion_sync_status == "review_bundle_written":
            operator_message = "The result exists, but current conclusion publication is waiting on the generated review bundle."
        elif conclusion_state == "bounded_only":
            operator_message = "The result exists, but current conclusion reuse remains bounded until stronger evidence or review resolves the claim."
        elif conclusion_state in {"review_required", "human_review_required"}:
            operator_message = "The result exists, but current conclusion publication still requires review before broader reuse."
        else:
            operator_message = "The result exists, but review or bounded claim resolution is still required before broader reuse."
    elif overall_status == "blocked":
        operator_message = "The result flow is blocked; inspect the current blocker before any retry or promotion."
    else:
        operator_message = "The result is available; use the bounded follow-up path to continue safely."

    return {
        "schema_version": "operator_summary.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "workspace": evaluation.get("workspace"),
        "phase": "post_run",
        "source_task_id": evaluation.get("task_id"),
        "overall_status": overall_status,
        "blocked": bool(blockers),
        "operator_message": operator_message,
        "evidence_decision": evidence_decision or None,
        "prepare_gate_status": None,
        "promotion_states": promotion_states,
        "blockers": blockers,
        "unmet_requirements": unmet_requirements,
        "next_safe_action": next_safe_action,
        "updated_at": summary_timestamp(
            evaluation.get("updated_at"),
            (followup_task_draft or {}).get("updated_at"),
            (review_proposal_draft or {}).get("updated_at"),
            (evaluation_report or {}).get("updated_at"),
        ),
    }


def operator_summary_fingerprint(summary: JsonObject) -> str:
    stable = {
        "intake_id": summary.get("intake_id"),
        "workspace": summary.get("workspace"),
        "phase": summary.get("phase"),
        "source_task_id": summary.get("source_task_id"),
        "overall_status": summary.get("overall_status"),
        "blocked": summary.get("blocked"),
        "operator_message": summary.get("operator_message"),
        "evidence_decision": summary.get("evidence_decision"),
        "prepare_gate_status": summary.get("prepare_gate_status"),
        "promotion_states": summary.get("promotion_states"),
        "blockers": summary.get("blockers"),
        "unmet_requirements": summary.get("unmet_requirements"),
        "next_safe_action": summary.get("next_safe_action"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def operator_summary_markdown(summary: JsonObject) -> str:
    lines = [
        "# Operator Summary",
        "",
        f"- intake_id: {summary.get('intake_id') or 'none'}",
        f"- workspace: {summary.get('workspace') or 'none'}",
        f"- phase: {summary.get('phase') or 'unknown'}",
        f"- source_task_id: {summary.get('source_task_id') or 'none'}",
        f"- overall_status: {summary.get('overall_status') or 'unknown'}",
        f"- blocked: {'true' if summary.get('blocked') else 'false'}",
        f"- evidence_decision: {summary.get('evidence_decision') or 'none'}",
        "",
        "## Message",
        "",
        str(summary.get("operator_message") or ""),
        "",
        "## Next Safe Action",
        "",
    ]
    next_safe_action = summary.get("next_safe_action") if isinstance(summary.get("next_safe_action"), dict) else {}
    lines.extend(
        [
            f"- kind: {next_safe_action.get('kind') or 'none'}",
            f"- description: {next_safe_action.get('description') or 'none'}",
            f"- reason: {next_safe_action.get('reason') or 'none'}",
            f"- can_execute_automatically: {'true' if next_safe_action.get('can_execute_automatically') else 'false'}",
        ]
    )
    if next_safe_action.get("target_path"):
        lines.append(f"- target_path: {next_safe_action.get('target_path')}")
    lines.append("")
    blockers = summary.get("blockers") if isinstance(summary.get("blockers"), list) else []
    if blockers:
        lines.extend(["## Blockers", ""])
        for item in blockers:
            if not isinstance(item, dict):
                continue
            lines.append(
                f"- {item.get('kind') or 'unknown'}: {item.get('description') or ''} ({item.get('reason') or 'no reason'})"
            )
        lines.append("")
    promotion_states = summary.get("promotion_states") if isinstance(summary.get("promotion_states"), dict) else {}
    if promotion_states:
        lines.extend(["## Promotion States", ""])
        for key, value in promotion_states.items():
            if value:
                lines.append(f"- {key}: {value}")
        lines.append("")
    unmet = summary.get("unmet_requirements") if isinstance(summary.get("unmet_requirements"), list) else []
    if unmet:
        lines.extend(["## Unmet Requirements", ""])
        for item in unmet:
            lines.append(f"- {item}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
