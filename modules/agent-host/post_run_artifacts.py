from __future__ import annotations

import datetime as dt
import json
from typing import Any


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def execution_evaluation_decision(task: dict[str, Any]) -> tuple[str, str, str]:
    status = str(task.get("status", "") or "")
    if status == "done":
        return (
            "result_ready_for_review",
            "review_result",
            "Task completed successfully; review the safe result before turning it into a new claim or follow-up task.",
        )
    if status == "policy_violation":
        return (
            "policy_violation",
            "human_review",
            "Task stopped on a policy boundary; inspect the write audit or protected-path reason before any retry.",
        )
    if status in {"failed", "timeout", "stale"}:
        return (
            "execution_failed",
            "inspect_logs",
            "Task did not finish cleanly; inspect logs and decide whether a bounded retry is justified.",
        )
    if status == "cancelled":
        return (
            "cancelled",
            "prepare_followup",
            "Task was cancelled before completion; decide whether to close the intake or prepare a narrower follow-up.",
        )
    return (
        "task_incomplete",
        "wait",
        "Task is not yet in a terminal result state.",
    )


def execution_result_excerpt(result_data: dict[str, Any]) -> str:
    text = str(result_data.get("text", "") or "").strip()
    if len(text) <= 1600:
        return text
    return text[:1599].rstrip() + "…"


def execution_evaluation_fingerprint(evaluation: dict[str, Any]) -> str:
    stable = {
        "intake_id": evaluation.get("intake_id"),
        "task_id": evaluation.get("task_id"),
        "task_status": evaluation.get("task_status"),
        "execution_decision": evaluation.get("execution_decision"),
        "recommended_next_action": evaluation.get("recommended_next_action"),
        "result_available": evaluation.get("result_available"),
        "safe_result_excerpt": evaluation.get("safe_result_excerpt"),
        "evidence_retrieval_decision": evaluation.get("evidence_retrieval_decision"),
        "warnings": evaluation.get("warnings"),
        "write_audit": evaluation.get("write_audit"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def execution_evaluation_markdown(evaluation: dict[str, Any]) -> str:
    lines = [
        "# Execution Evaluation",
        "",
        f"- intake_id: {evaluation.get('intake_id') or 'none'}",
        f"- task_id: {evaluation.get('task_id') or 'none'}",
        f"- workspace: {evaluation.get('workspace') or 'none'}",
        f"- objective: {evaluation.get('objective') or 'unknown'}",
        f"- task_status: {evaluation.get('task_status') or 'unknown'}",
        f"- execution_decision: {evaluation.get('execution_decision') or 'unknown'}",
        f"- recommended_next_action: {evaluation.get('recommended_next_action') or 'unknown'}",
        f"- evidence_retrieval_decision: {evaluation.get('evidence_retrieval_decision') or 'none'}",
        "",
        "## Summary",
        "",
        str(evaluation.get("summary") or "No evaluation summary was produced."),
        "",
    ]
    warnings = evaluation.get("warnings") if isinstance(evaluation.get("warnings"), list) else []
    if warnings:
        lines.extend(["## Warnings", ""])
        for warning in warnings:
            lines.append(f"- {warning}")
        lines.append("")
    lines.extend([
        "## Write Audit",
        "",
        f"- changed_files_count: {((evaluation.get('write_audit') or {}).get('changed_files_count') if isinstance(evaluation.get('write_audit'), dict) else 'none')}",
        f"- protected_path_violation: {'true' if ((evaluation.get('write_audit') or {}).get('protected_path_violation') if isinstance(evaluation.get('write_audit'), dict) else False) else 'false'}",
        "",
        "## Safe Result Excerpt",
        "",
        str(evaluation.get("safe_result_excerpt") or "(empty result excerpt)"),
        "",
    ])
    return "\n".join(lines).rstrip() + "\n"


def claim_boundary_for_evaluation(evaluation: dict[str, Any]) -> str:
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    next_action = str(evaluation.get("recommended_next_action") or "")
    if evidence_decision and evidence_decision != "safe_to_answer":
        return "Do not treat the previous task as a finalized formal conclusion until the referenced evidence has been reviewed."
    if next_action == "human_review":
        return "Do not retry or promote filesystem changes until a human reviews the policy boundary and write audit evidence."
    if next_action == "inspect_logs":
        return "Do not treat this task as successful; inspect the safe logs and failure mode before planning any retry."
    return "Normal bounded review rules apply; keep claims tied to cited evidence."


def build_post_run_artifact_provenance(
    evaluation: dict[str, Any],
    *,
    artifact_role: str,
    repair_origin: str,
) -> dict[str, Any]:
    intake_id = str(evaluation.get("intake_id") or "").strip()
    report_path = f".codex-bridge/intake/{intake_id}/EXECUTION_EVALUATION.json" if intake_id else None
    report_timestamp = str(evaluation.get("updated_at") or "").strip() or None
    return {
        "artifact_role": artifact_role,
        "source": "fallback_synthesized",
        "repair_origin": repair_origin,
        "generated_by": "agent_host_post_run_artifacts",
        "derived_from_report": {
            "path": report_path,
            "timestamp_utc": report_timestamp,
            "report_type": "execution_evaluation",
        },
        "parent_route_id": None,
        "parent_route_epoch": None,
        "parent_task_box_id": None,
        "generated_at_utc": report_timestamp or utc_now().isoformat().replace("+00:00", "Z"),
        "model_authored": False,
        "route_repair_authored": False,
        "fallback_synthesized": True,
    }


def followup_prompt_for_evaluation(evaluation: dict[str, Any], contract: dict[str, Any], evidence: dict[str, Any]) -> str:
    task_id = str(evaluation.get("task_id") or "")
    workspace = str(evaluation.get("workspace") or "")
    objective = str(contract.get("objective") or evaluation.get("objective") or "report_only")
    original_prompt = str(contract.get("prompt") or "").strip()
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    status = str(evaluation.get("task_status") or "")
    next_action = str(evaluation.get("recommended_next_action") or "")
    read_plan = evidence.get("read_plan") if isinstance(evidence.get("read_plan"), list) else []

    if next_action == "review_result":
        lines = [
            f"Review the safe result from task {task_id} in workspace {workspace}.",
            "Check it against the prepared evidence/read-plan before turning it into a formal conclusion.",
        ]
        if evidence_decision and evidence_decision != "safe_to_answer":
            lines.append(
                f"Evidence retrieval previously returned {evidence_decision}; keep any conclusion claim bounded until the referenced files are reviewed."
            )
        if original_prompt:
            lines.append(f"Original request: {original_prompt}")
        if read_plan:
            refs = ", ".join(str(item.get("path") or "unknown") for item in read_plan[:3] if isinstance(item, dict))
            if refs:
                lines.append(f"Start with these files: {refs}.")
        lines.append("Summarize what still looks true, what is uncertain, and whether a bounded follow-up task is needed.")
        return " ".join(lines)

    if next_action == "inspect_logs":
        lines = [
            f"Inspect why task {task_id} ended with status {status}.",
            "Review the safe logs and safe result, identify the most likely failure cause, and propose the smallest bounded retry or scope reduction.",
        ]
        if original_prompt:
            lines.append(f"Original request: {original_prompt}")
        return " ".join(lines)

    if next_action == "prepare_followup":
        lines = [
            f"Prepare a narrower follow-up for cancelled task {task_id} in workspace {workspace}.",
            "Reuse the original objective, preserve the bounded scope, and explain what should change before rerunning.",
        ]
        if original_prompt:
            lines.append(f"Original request: {original_prompt}")
        return " ".join(lines)

    if next_action == "human_review":
        lines = [
            f"Review the policy boundary hit by task {task_id}.",
            "Explain which protected action or write boundary stopped the task and propose a safe next step that does not bypass review.",
        ]
        if original_prompt:
            lines.append(f"Original request: {original_prompt}")
        return " ".join(lines)

    return (
        f"Reassess task {task_id} in workspace {workspace} and decide the next safe bounded step for objective {objective}."
    )


def build_followup_task_draft(
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    next_action = str(evaluation.get("recommended_next_action") or "")
    requires_prepare = next_action in {"review_result", "inspect_logs", "prepare_followup", "human_review"}
    objective = str(contract.get("objective") or evaluation.get("objective") or "")
    title_map = {
        "review_result": "Review the result against prepared evidence",
        "inspect_logs": "Inspect failure logs and scope a bounded retry",
        "prepare_followup": "Prepare a narrower follow-up task",
        "human_review": "Review the policy boundary before retrying",
        "wait": "Wait for the current task to finish",
    }
    summary_map = {
        "review_result": "Use /prepare to review the completed task against the original read plan before making a new claim.",
        "inspect_logs": "Use /prepare to inspect logs, explain the failure mode, and decide whether a bounded retry is justified.",
        "prepare_followup": "Use /prepare to define a narrower follow-up that preserves the original safety boundary.",
        "human_review": "This follow-up needs a human decision before any new run should be queued.",
        "wait": "No follow-up should be prepared yet because the task is not in a terminal state.",
    }
    claim_boundary = claim_boundary_for_evaluation(evaluation)
    return {
        "schema_version": 1,
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "source_objective": objective,
        "source_execution_decision": evaluation.get("execution_decision"),
        "recommended_next_action": next_action,
        "title": title_map.get(next_action, "Prepare the next bounded step"),
        "summary": summary_map.get(next_action, "Review the latest task outcome and prepare the next safe bounded step."),
        "requires_prepare": requires_prepare,
        "suggested_surface": "prepare" if requires_prepare else "review",
        "suggested_mode": str(contract.get("mode") or evaluation.get("task_mode") or "readonly"),
        "reference_task_id": evaluation.get("task_id"),
        "prompt": followup_prompt_for_evaluation(evaluation, contract, evidence),
        "claim_boundary": claim_boundary,
        "read_plan": list(evidence.get("read_plan") or []),
        "provenance": build_post_run_artifact_provenance(
            evaluation,
            artifact_role="followup_task_draft",
            repair_origin="execution_evaluation.followup_task_draft",
        ),
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def followup_task_draft_fingerprint(draft: dict[str, Any]) -> str:
    stable = {
        "intake_id": draft.get("intake_id"),
        "source_task_id": draft.get("source_task_id"),
        "recommended_next_action": draft.get("recommended_next_action"),
        "title": draft.get("title"),
        "summary": draft.get("summary"),
        "prompt": draft.get("prompt"),
        "claim_boundary": draft.get("claim_boundary"),
        "read_plan": draft.get("read_plan"),
        "provenance": draft.get("provenance"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def followup_task_draft_markdown(draft: dict[str, Any]) -> str:
    lines = [
        "# Follow-up Task Draft",
        "",
        f"- intake_id: {draft.get('intake_id') or 'none'}",
        f"- source_task_id: {draft.get('source_task_id') or 'none'}",
        f"- workspace: {draft.get('workspace') or 'none'}",
        f"- source_objective: {draft.get('source_objective') or 'unknown'}",
        f"- recommended_next_action: {draft.get('recommended_next_action') or 'unknown'}",
        f"- requires_prepare: {'true' if draft.get('requires_prepare') else 'false'}",
        "",
        "## Title",
        "",
        str(draft.get("title") or "Prepare the next bounded step."),
        "",
        "## Summary",
        "",
        str(draft.get("summary") or ""),
        "",
        "## Prompt",
        "",
        str(draft.get("prompt") or ""),
        "",
        "## Claim Boundary",
        "",
        str(draft.get("claim_boundary") or ""),
        "",
    ]
    provenance = draft.get("provenance") if isinstance(draft.get("provenance"), dict) else {}
    if provenance:
        lines.extend([
            "## Provenance",
            "",
            f"- source: {provenance.get('source') or 'none'}",
            f"- repair_origin: {provenance.get('repair_origin') or 'none'}",
            f"- generated_by: {provenance.get('generated_by') or 'none'}",
            f"- derived_from_report: {((provenance.get('derived_from_report') or {}).get('path') if isinstance(provenance.get('derived_from_report'), dict) else 'none') or 'none'}",
            "",
        ])
    read_plan = draft.get("read_plan") if isinstance(draft.get("read_plan"), list) else []
    if read_plan:
        lines.extend(["## Read Plan", ""])
        for item in read_plan:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "unknown")
            reason = str(item.get("reason") or "")
            lines.append(f"- {path}" + (f": {reason}" if reason else ""))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def ledger_note_markdown_for_evaluation(
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
) -> str:
    objective = str(contract.get("objective") or evaluation.get("objective") or "unknown")
    summary = str(evaluation.get("summary") or "No summary was produced.")
    claim_boundary = claim_boundary_for_evaluation(evaluation)
    warnings = evaluation.get("warnings") if isinstance(evaluation.get("warnings"), list) else []
    read_plan = evidence.get("read_plan") if isinstance(evidence.get("read_plan"), list) else []
    lines = [
        "## Proposed Ledger Fragment",
        "",
        f"- Task: {evaluation.get('task_id') or 'none'}",
        f"- Workspace: {evaluation.get('workspace') or 'none'}",
        f"- Objective: {objective}",
        f"- Execution decision: {evaluation.get('execution_decision') or 'unknown'}",
        f"- Recommended next action: {evaluation.get('recommended_next_action') or 'unknown'}",
    ]
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    if evidence_decision:
        lines.append(f"- Evidence decision: {evidence_decision}")
    lines.extend([
        "",
        "### Summary",
        "",
        summary,
        "",
        "### Claim Boundary",
        "",
        claim_boundary,
        "",
    ])
    if warnings:
        lines.extend(["### Warnings", ""])
        for warning in warnings:
            lines.append(f"- {warning}")
        lines.append("")
    if read_plan:
        lines.extend(["### Read Plan", ""])
        for item in read_plan:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "unknown")
            reason = str(item.get("reason") or "")
            lines.append(f"- {path}" + (f": {reason}" if reason else ""))
        lines.append("")
    lines.extend([
        "### Safe Result Excerpt",
        "",
        str(evaluation.get("safe_result_excerpt") or "(empty result excerpt)"),
        "",
    ])
    return "\n".join(lines).rstrip() + "\n"


def build_ledger_note_draft(
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    objective = str(contract.get("objective") or evaluation.get("objective") or "")
    task_id = str(evaluation.get("task_id") or "")
    return {
        "schema_version": 1,
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": task_id,
        "workspace": evaluation.get("workspace"),
        "source_objective": objective,
        "source_execution_decision": evaluation.get("execution_decision"),
        "recommended_next_action": evaluation.get("recommended_next_action"),
        "title": f"Proposed ledger note for task {task_id or 'unknown'}",
        "summary": "Capture the latest safe result and its claim boundary as a non-authoritative ledger note draft.",
        "target_path_hint": "research/LEDGER_NOTES.md",
        "claim_boundary": claim_boundary_for_evaluation(evaluation),
        "evidence_retrieval_decision": evaluation.get("evidence_retrieval_decision"),
        "warnings": list(evaluation.get("warnings") or []),
        "read_plan": list(evidence.get("read_plan") or []),
        "provenance": build_post_run_artifact_provenance(
            evaluation,
            artifact_role="ledger_note_draft",
            repair_origin="execution_evaluation.ledger_note_draft",
        ),
        "note_markdown": ledger_note_markdown_for_evaluation(evaluation, contract, evidence),
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def ledger_note_draft_fingerprint(draft: dict[str, Any]) -> str:
    stable = {
        "intake_id": draft.get("intake_id"),
        "source_task_id": draft.get("source_task_id"),
        "recommended_next_action": draft.get("recommended_next_action"),
        "title": draft.get("title"),
        "summary": draft.get("summary"),
        "target_path_hint": draft.get("target_path_hint"),
        "claim_boundary": draft.get("claim_boundary"),
        "warnings": draft.get("warnings"),
        "read_plan": draft.get("read_plan"),
        "provenance": draft.get("provenance"),
        "note_markdown": draft.get("note_markdown"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def ledger_note_draft_markdown(draft: dict[str, Any]) -> str:
    lines = [
        "# Ledger Note Draft",
        "",
        f"- intake_id: {draft.get('intake_id') or 'none'}",
        f"- source_task_id: {draft.get('source_task_id') or 'none'}",
        f"- workspace: {draft.get('workspace') or 'none'}",
        f"- source_objective: {draft.get('source_objective') or 'unknown'}",
        f"- recommended_next_action: {draft.get('recommended_next_action') or 'unknown'}",
        f"- target_path_hint: {draft.get('target_path_hint') or 'research/LEDGER_NOTES.md'}",
        "",
        "## Summary",
        "",
        str(draft.get("summary") or ""),
        "",
        "## Claim Boundary",
        "",
        str(draft.get("claim_boundary") or ""),
        "",
    ]
    provenance = draft.get("provenance") if isinstance(draft.get("provenance"), dict) else {}
    if provenance:
        lines.extend([
            "## Provenance",
            "",
            f"- source: {provenance.get('source') or 'none'}",
            f"- repair_origin: {provenance.get('repair_origin') or 'none'}",
            f"- generated_by: {provenance.get('generated_by') or 'none'}",
            "",
        ])
    lines.extend([
        str(draft.get("note_markdown") or "").rstrip(),
        "",
    ])
    return "\n".join(lines).rstrip() + "\n"


def review_scope_for_evaluation(evaluation: dict[str, Any]) -> str:
    next_action = str(evaluation.get("recommended_next_action") or "")
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    if next_action == "human_review":
        return "unsafe_operation"
    if next_action == "review_result" and evidence_decision not in {"", "safe_to_answer"}:
        return "report_only"
    return "none"


def review_proposal_reason(evaluation: dict[str, Any]) -> str:
    next_action = str(evaluation.get("recommended_next_action") or "")
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    if next_action == "human_review":
        return "Task stopped on a policy boundary and needs a human decision before any retry or promotion."
    if next_action == "review_result" and evidence_decision not in {"", "safe_to_answer"}:
        return (
            f"Prepared evidence decision remains {evidence_decision}; a reviewer should confirm the bounded claim before it is reused."
        )
    return "No review proposal is needed."


def build_review_proposal_draft(
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any] | None:
    review_scope = review_scope_for_evaluation(evaluation)
    if review_scope == "none":
        return None
    requires_human_review = str(evaluation.get("recommended_next_action") or "") == "human_review"
    objective = str(contract.get("objective") or evaluation.get("objective") or "")
    reason = review_proposal_reason(evaluation)
    task_id = str(evaluation.get("task_id") or "")
    read_plan = evidence.get("read_plan") if isinstance(evidence.get("read_plan"), list) else []
    action_line = (
        "Inspect the write audit / protected-path evidence and decide whether a narrower retry is allowed."
        if requires_human_review
        else "Review the safe result against the prepared read plan and confirm what can be stated as a bounded claim."
    )
    stop_condition = (
        "Stop once a human has either approved a safe bounded next step or explicitly closed the retry path."
        if requires_human_review
        else "Stop once the reviewer has marked the reusable claim boundary or asked for a narrower prepared follow-up."
    )
    proposal_lines = [
        "# Review Proposal Draft",
        "",
        "## Purpose",
        "",
        reason,
        "",
        "## Task Context",
        "",
        f"- task_id: {task_id or 'none'}",
        f"- workspace: {evaluation.get('workspace') or 'none'}",
        f"- objective: {objective or 'unknown'}",
        f"- execution_decision: {evaluation.get('execution_decision') or 'unknown'}",
        f"- recommended_next_action: {evaluation.get('recommended_next_action') or 'unknown'}",
        f"- requires_human_review: {'true' if requires_human_review else 'false'}",
        "",
        "## Requested Review",
        "",
        action_line,
        "",
        "## Safety Boundary",
        "",
        claim_boundary_for_evaluation(evaluation),
        "",
    ]
    if read_plan:
        proposal_lines.extend(["## Read Plan", ""])
        for item in read_plan:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "unknown")
            reason_text = str(item.get("reason") or "")
            proposal_lines.append(f"- {path}" + (f": {reason_text}" if reason_text else ""))
        proposal_lines.append("")
    proposal_lines.extend([
        "## Safe Result Excerpt",
        "",
        str(evaluation.get("safe_result_excerpt") or "(empty result excerpt)"),
        "",
        "## Stop Condition",
        "",
        stop_condition,
        "",
    ])
    return {
        "schema_version": 1,
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": task_id,
        "workspace": evaluation.get("workspace"),
        "source_objective": objective,
        "source_execution_decision": evaluation.get("execution_decision"),
        "recommended_next_action": evaluation.get("recommended_next_action"),
        "requires_human_review": requires_human_review,
        "review_scope": review_scope,
        "review_resolver": "human",
        "title": (
            "Human review required before retrying the task"
            if requires_human_review
            else "Review the bounded claim before promoting the result"
        ),
        "summary": reason,
        "reason": reason,
        "suggested_reviewer_action": action_line,
        "stop_condition": stop_condition,
        "claim_boundary": claim_boundary_for_evaluation(evaluation),
        "read_plan": list(read_plan),
        "provenance": build_post_run_artifact_provenance(
            evaluation,
            artifact_role="review_proposal_draft",
            repair_origin="execution_evaluation.review_proposal_draft",
        ),
        "proposal_markdown": "\n".join(proposal_lines).rstrip() + "\n",
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def review_proposal_draft_fingerprint(draft: dict[str, Any]) -> str:
    stable = {
        "intake_id": draft.get("intake_id"),
        "source_task_id": draft.get("source_task_id"),
        "recommended_next_action": draft.get("recommended_next_action"),
        "requires_human_review": draft.get("requires_human_review"),
        "review_scope": draft.get("review_scope"),
        "title": draft.get("title"),
        "summary": draft.get("summary"),
        "reason": draft.get("reason"),
        "suggested_reviewer_action": draft.get("suggested_reviewer_action"),
        "stop_condition": draft.get("stop_condition"),
        "claim_boundary": draft.get("claim_boundary"),
        "read_plan": draft.get("read_plan"),
        "provenance": draft.get("provenance"),
        "proposal_markdown": draft.get("proposal_markdown"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def review_proposal_draft_markdown(draft: dict[str, Any]) -> str:
    lines = [
        "# Review Proposal Draft",
        "",
        f"- intake_id: {draft.get('intake_id') or 'none'}",
        f"- source_task_id: {draft.get('source_task_id') or 'none'}",
        f"- workspace: {draft.get('workspace') or 'none'}",
        f"- review_scope: {draft.get('review_scope') or 'none'}",
        f"- requires_human_review: {'true' if draft.get('requires_human_review') else 'false'}",
        "",
        "## Summary",
        "",
        str(draft.get("summary") or ""),
        "",
    ]
    provenance = draft.get("provenance") if isinstance(draft.get("provenance"), dict) else {}
    if provenance:
        lines.extend([
            "## Provenance",
            "",
            f"- source: {provenance.get('source') or 'none'}",
            f"- repair_origin: {provenance.get('repair_origin') or 'none'}",
            f"- generated_by: {provenance.get('generated_by') or 'none'}",
            "",
        ])
    lines.extend([
        str(draft.get("proposal_markdown") or "").rstrip(),
        "",
    ])
    return "\n".join(lines).rstrip() + "\n"
