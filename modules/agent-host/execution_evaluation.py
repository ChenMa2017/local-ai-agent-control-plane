from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from post_run_artifacts import (
    build_followup_task_draft,
    build_ledger_note_draft,
    build_review_proposal_draft,
    execution_evaluation_decision,
    execution_evaluation_fingerprint,
    execution_evaluation_markdown,
    execution_result_excerpt,
    followup_task_draft_fingerprint,
    followup_task_draft_markdown,
    ledger_note_draft_fingerprint,
    ledger_note_draft_markdown,
    review_proposal_draft_fingerprint,
    review_proposal_draft_markdown,
)

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class ExecutionEvaluationDependencies:
    utc_now: Callable[[], dt.datetime]
    intake_dir: Callable[[Any, str], Path]
    read_json_object_if_exists: Callable[[Path], JsonObject]
    write_json_atomic: Callable[[Path, JsonObject], None]
    write_text_atomic: Callable[[Path, str], None]
    append_jsonl: Callable[[Path, JsonObject], None]
    task_intake_id: Callable[[JsonObject], str]


def load_task_prepare_bundle(
    config: Any,
    task: JsonObject,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any]:
    intake_id = deps.task_intake_id(task)
    if not intake_id:
        return {}
    root = deps.intake_dir(config, intake_id)
    if not root.exists():
        return {"intake_id": intake_id, "available": False}
    return {
        "intake_id": intake_id,
        "available": True,
        "intent": deps.read_json_object_if_exists(root / "INTENT_DRAFT.json"),
        "contract": deps.read_json_object_if_exists(root / "TASK_CONTRACT.json"),
        "taskbox": deps.read_json_object_if_exists(root / "TASKBOX_DRAFT.json"),
        "preflight": deps.read_json_object_if_exists(root / "POLICY_PREFLIGHT.json"),
        "evidence_retrieval": deps.read_json_object_if_exists(root / "EVIDENCE_RETRIEVAL.json"),
    }


def build_execution_evaluation(
    config: Any,
    task_dir: Path,
    task: JsonObject,
    result_data: JsonObject,
    deps: ExecutionEvaluationDependencies,
    *,
    prepare_bundle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bundle = prepare_bundle if isinstance(prepare_bundle, dict) else load_task_prepare_bundle(config, task, deps)
    contract = bundle.get("contract") if isinstance(bundle.get("contract"), dict) else {}
    evidence = bundle.get("evidence_retrieval") if isinstance(bundle.get("evidence_retrieval"), dict) else {}
    intake_id = str(bundle.get("intake_id") or "")
    execution_decision, next_action, summary = execution_evaluation_decision(task)
    excerpt = execution_result_excerpt(result_data)
    warnings: list[str] = []
    evidence_decision = evidence.get("decision")
    if evidence_decision and evidence_decision != "safe_to_answer":
        warnings.append(
            f"Prepared evidence decision remains {evidence_decision}; keep formal conclusion claims bounded until reviewer confirmation."
        )
    if str(task.get("status", "")) == "policy_violation":
        warnings.append("Task hit a protected-path or policy boundary; inspect write audit evidence before any retry.")
    if str(task.get("status", "")) == "done" and not excerpt:
        warnings.append("Task finished without a non-empty safe result excerpt.")
    if intake_id and not bundle.get("available"):
        warnings.append("Prepared intake artifacts are missing; evaluation is based only on task metadata and safe result.")
    return {
        "schema_version": 1,
        "intake_id": intake_id,
        "task_id": str(task.get("task_id") or task_dir.name),
        "workspace": str(task.get("project") or ""),
        "objective": str(contract.get("objective") or ""),
        "task_status": str(task.get("status") or ""),
        "task_mode": str(task.get("mode") or ""),
        "reference_task_id": str(task.get("reference_task_id") or ""),
        "execution_decision": execution_decision,
        "recommended_next_action": next_action,
        "summary": summary,
        "evidence_retrieval_decision": evidence_decision,
        "result_available": bool(excerpt),
        "safe_result_excerpt": excerpt,
        "warnings": warnings,
        "write_audit": {
            "present": bool(task.get("write_audit_path")),
            "changed_files_count": task.get("changed_files_count") if isinstance(task.get("changed_files_count"), int) else None,
            "protected_path_violation": bool(task.get("protected_path_violation")),
        },
        "updated_at": deps.utc_now().isoformat().replace("+00:00", "Z"),
    }


def persist_execution_evaluation(
    config: Any,
    evaluation: dict[str, Any],
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any]:
    intake_id = str(evaluation.get("intake_id") or "")
    if not intake_id:
        return evaluation
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "EXECUTION_EVALUATION.json")
    if existing and execution_evaluation_fingerprint(existing) == execution_evaluation_fingerprint(evaluation):
        return existing
    deps.write_json_atomic(root / "EXECUTION_EVALUATION.json", evaluation)
    deps.write_text_atomic(root / "EXECUTION_EVALUATION.md", execution_evaluation_markdown(evaluation))
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "execution_evaluated",
            "intake_id": intake_id,
            "task_id": evaluation.get("task_id"),
            "task_status": evaluation.get("task_status"),
            "execution_decision": evaluation.get("execution_decision"),
            "recommended_next_action": evaluation.get("recommended_next_action"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return evaluation


def persist_followup_task_draft(
    config: Any,
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    intake_id = str(evaluation.get("intake_id") or "")
    if not intake_id:
        return None
    draft = build_followup_task_draft(evaluation, contract, evidence)
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "FOLLOWUP_TASK_DRAFT.json")
    if existing and followup_task_draft_fingerprint(existing) == followup_task_draft_fingerprint(draft):
        return existing
    deps.write_json_atomic(root / "FOLLOWUP_TASK_DRAFT.json", draft)
    deps.write_text_atomic(root / "FOLLOWUP_TASK_DRAFT.md", followup_task_draft_markdown(draft))
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "followup_task_drafted",
            "intake_id": intake_id,
            "source_task_id": evaluation.get("task_id"),
            "recommended_next_action": draft.get("recommended_next_action"),
            "requires_prepare": bool(draft.get("requires_prepare")),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return draft


def persist_ledger_note_draft(
    config: Any,
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    intake_id = str(evaluation.get("intake_id") or "")
    if not intake_id:
        return None
    draft = build_ledger_note_draft(evaluation, contract, evidence)
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "LEDGER_NOTE_DRAFT.json")
    if existing and ledger_note_draft_fingerprint(existing) == ledger_note_draft_fingerprint(draft):
        return existing
    deps.write_json_atomic(root / "LEDGER_NOTE_DRAFT.json", draft)
    deps.write_text_atomic(root / "LEDGER_NOTE_DRAFT.md", ledger_note_draft_markdown(draft))
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "ledger_note_drafted",
            "intake_id": intake_id,
            "source_task_id": evaluation.get("task_id"),
            "recommended_next_action": draft.get("recommended_next_action"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return draft


def persist_review_proposal_draft(
    config: Any,
    evaluation: dict[str, Any],
    contract: dict[str, Any],
    evidence: dict[str, Any],
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    intake_id = str(evaluation.get("intake_id") or "")
    if not intake_id:
        return None
    draft = build_review_proposal_draft(evaluation, contract, evidence)
    if draft is None:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "REVIEW_PROPOSAL_DRAFT.json")
    if existing and review_proposal_draft_fingerprint(existing) == review_proposal_draft_fingerprint(draft):
        return existing
    deps.write_json_atomic(root / "REVIEW_PROPOSAL_DRAFT.json", draft)
    deps.write_text_atomic(root / "REVIEW_PROPOSAL_DRAFT.md", review_proposal_draft_markdown(draft))
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "review_proposal_drafted",
            "intake_id": intake_id,
            "source_task_id": evaluation.get("task_id"),
            "review_scope": draft.get("review_scope"),
            "requires_human_review": bool(draft.get("requires_human_review")),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return draft


def maybe_attach_execution_evaluation(
    config: Any,
    task_dir: Path,
    task: JsonObject,
    result_data: JsonObject,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, dict[str, Any]]:
    intake_id = deps.task_intake_id(task)
    if not intake_id:
        return {}
    prepare_bundle = load_task_prepare_bundle(config, task, deps)
    evaluation = build_execution_evaluation(
        config,
        task_dir,
        task,
        result_data,
        deps,
        prepare_bundle=prepare_bundle,
    )
    evaluation = persist_execution_evaluation(config, evaluation, deps)
    contract = prepare_bundle.get("contract") if isinstance(prepare_bundle.get("contract"), dict) else {}
    evidence = prepare_bundle.get("evidence_retrieval") if isinstance(prepare_bundle.get("evidence_retrieval"), dict) else {}
    followup_task_draft = persist_followup_task_draft(config, evaluation, contract, evidence, deps)
    ledger_note_draft = persist_ledger_note_draft(config, evaluation, contract, evidence, deps)
    review_proposal_draft = persist_review_proposal_draft(config, evaluation, contract, evidence, deps)
    attachments: dict[str, dict[str, Any]] = {"execution_evaluation": evaluation}
    if followup_task_draft:
        attachments["followup_task_draft"] = followup_task_draft
    if ledger_note_draft:
        attachments["ledger_note_draft"] = ledger_note_draft
    if review_proposal_draft:
        attachments["review_proposal_draft"] = review_proposal_draft
    return attachments
