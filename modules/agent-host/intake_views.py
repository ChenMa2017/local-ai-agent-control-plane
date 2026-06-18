from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from prepared_context import count_jsonl_records, filter_source_task_artifact
from intake_store import (
    intake_dir,
    load_intake_json_artifact,
    load_intake_questions,
    load_optional_intake_json_artifact,
    load_prepared_run_context,
    read_json_object_if_exists,
    validate_intake_id,
)

JsonObject = dict[str, Any]
ErrorFactory = Callable[[str, int, str | None], Exception]

INTAKE_OPTIONAL_ARTIFACTS: dict[str, str] = {
    "execution_evaluation": "EXECUTION_EVALUATION.json",
    "followup_task_draft": "FOLLOWUP_TASK_DRAFT.json",
    "ledger_note_draft": "LEDGER_NOTE_DRAFT.json",
    "review_proposal_draft": "REVIEW_PROPOSAL_DRAFT.json",
    "hypothesis_update": "HYPOTHESIS_UPDATE.json",
    "hypothesis_promotion": "HYPOTHESIS_PROMOTION.json",
    "experiment_index_update": "EXPERIMENT_INDEX_UPDATE.json",
    "experiment_promotion": "EXPERIMENT_PROMOTION.json",
    "current_conclusion_update": "CURRENT_CONCLUSION_UPDATE.json",
    "current_conclusion_promotion": "CURRENT_CONCLUSION_PROMOTION.json",
    "evaluation_report": "EVALUATION_REPORT.json",
    "current_conclusions": "CURRENT_CONCLUSIONS.json",
    "operator_summary": "OPERATOR_SUMMARY.json",
}

FOLLOWUP_SOURCE_ARTIFACTS: dict[str, tuple[str, str]] = {
    "execution_evaluation": ("EXECUTION_EVALUATION.json", "task_id"),
    "ledger_note_draft": ("LEDGER_NOTE_DRAFT.json", "source_task_id"),
    "review_proposal_draft": ("REVIEW_PROPOSAL_DRAFT.json", "source_task_id"),
    "hypothesis_update": ("HYPOTHESIS_UPDATE.json", "source_task_id"),
    "hypothesis_promotion": ("HYPOTHESIS_PROMOTION.json", "source_task_id"),
    "experiment_index_update": ("EXPERIMENT_INDEX_UPDATE.json", "source_task_id"),
    "experiment_promotion": ("EXPERIMENT_PROMOTION.json", "source_task_id"),
    "current_conclusion_update": ("CURRENT_CONCLUSION_UPDATE.json", "source_task_id"),
    "current_conclusion_promotion": ("CURRENT_CONCLUSION_PROMOTION.json", "source_task_id"),
    "evaluation_report": ("EVALUATION_REPORT.json", "task_id"),
    "current_conclusions": ("CURRENT_CONCLUSIONS.json", "source_task_id"),
    "operator_summary": ("OPERATOR_SUMMARY.json", "source_task_id"),
}


def load_optional_artifacts(
    config: Any,
    intake_id: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> JsonObject:
    return {
        key: load_optional_intake_json_artifact(
            config,
            intake_id,
            filename,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )
        for key, filename in INTAKE_OPTIONAL_ARTIFACTS.items()
    }


def handle_codex_intake(
    payload: JsonObject,
    config: Any,
    principal: Any,
    *,
    deps: Any,
    intake_id_re: re.Pattern[str],
) -> JsonObject:
    deps.reject_frontend_identity(payload)
    intake_id = validate_intake_id((payload.get("intake_id") or "").strip(), intake_id_re=intake_id_re, error_factory=deps.error_factory)
    bundle = load_prepared_run_context(
        config,
        intake_id,
        principal,
        can_access_intake=deps.can_access_intake,
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    root = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=deps.error_factory)
    gray_areas_artifact = load_optional_intake_json_artifact(
        config,
        intake_id,
        "GRAY_AREAS.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    ) or {}
    decision_gate = load_optional_intake_json_artifact(
        config,
        intake_id,
        "DECISION_GATE.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    ) or {}
    questions = load_intake_questions(config, intake_id, intake_id_re=intake_id_re, error_factory=deps.error_factory)
    optional_artifacts = load_optional_artifacts(
        config,
        intake_id,
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    events_path = root / "TASK_INTAKE.events.jsonl"
    event_count = count_jsonl_records(events_path.read_text() if events_path.exists() else "")
    return {
        "ok": True,
        "intake_id": intake_id,
        "intent": bundle["intent"],
        "gray_areas": list(gray_areas_artifact.get("items") or []),
        "questions": questions,
        "contract": bundle["contract"],
        "taskbox": bundle["taskbox"],
        "preflight": bundle["preflight"],
        "decision_gate": decision_gate,
        "evidence_retrieval": bundle["evidence_retrieval"],
        "research_program": bundle.get("research_program"),
        "hypothesis_registry": bundle.get("hypothesis_registry"),
        "experiment_spec": bundle.get("experiment_spec"),
        **optional_artifacts,
        "event_count": event_count,
        "ready_to_run": bool(bundle["preflight"].get("ok") and not questions),
    }


def load_followup_source_artifacts(root: Path, followup_task_id: str) -> JsonObject:
    return {
        key: filter_source_task_artifact(
            read_json_object_if_exists(root / filename),
            followup_task_id,
            source_field,
        )
        for key, (filename, source_field) in FOLLOWUP_SOURCE_ARTIFACTS.items()
    }


def load_followup_prepare_seed(
    config: Any,
    followup_task_id: str,
    principal: Any,
    *,
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]],
    task_intake_id: Callable[[JsonObject], str],
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> JsonObject:
    _task_dir, task = authorize_task(config, principal, followup_task_id)
    intake_id = task_intake_id(task)
    if not intake_id:
        raise error_factory(
            f"follow-up draft is not available for task {followup_task_id}; the task is not linked to a prepared intake",
            409,
            "followup_draft_unavailable",
        )
    draft = load_intake_json_artifact(
        config,
        intake_id,
        "FOLLOWUP_TASK_DRAFT.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    if str(draft.get("source_task_id") or "") not in {"", followup_task_id}:
        raise error_factory(
            f"follow-up draft source does not match task {followup_task_id}",
            409,
            "followup_draft_invalid",
        )
    root = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory)
    return {
        "task_id": followup_task_id,
        "source_intake_id": intake_id,
        "task": task,
        "draft": draft,
        **load_followup_source_artifacts(root, followup_task_id),
    }
