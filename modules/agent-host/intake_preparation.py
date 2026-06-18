from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from evidence_retrieval import maybe_run_evidence_retrieval
from execution_evaluation import ExecutionEvaluationDependencies
from operator_summary import build_prepare_operator_summary
from prepared_context import count_jsonl_records, filter_source_task_artifact
from intake_store import (
    append_jsonl,
    intake_dir,
    intake_root,
    load_intake_intent,
    load_intake_json_artifact,
    load_intake_questions,
    load_optional_intake_json_artifact,
    load_prepared_run_context,
    new_intake_id,
    read_json_object_if_exists,
    validate_intake_id,
    write_json_atomic,
    write_text_atomic,
)
from prepare_artifacts import (
    intake_summary_markdown,
    make_policy_preflight,
    make_task_contract,
    make_taskbox_draft,
    persist_intake_artifacts,
)
from prepare_intent import (
    build_gray_areas,
    clarification_questions,
    infer_objective,
    intake_risk_class,
    parse_intent_signals,
    should_consult_evidence_index,
)

JsonObject = dict[str, Any]
Payload = dict[str, str]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class IntakePreparationDependencies:
    utc_now: Callable[[], dt.datetime]
    reject_frontend_identity: Callable[[Payload], None]
    can_access_intake: Callable[[JsonObject, Any], bool]
    validate_task_id: Callable[[str], str]
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    task_intake_id: Callable[[JsonObject], str]
    safe_adapter_source: Callable[[str], str]
    prompt_preview: Callable[[Any], str]
    project_name_re: re.Pattern[str]
    error_factory: ErrorFactory


def validate_codex_project(
    config: Any,
    project: str,
    *,
    project_name_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> Any:
    if not project_name_re.match(project):
        raise error_factory("project is required and must be a safe project name", 400, "invalid_request")
    if project not in getattr(config, "projects", {}):
        raise error_factory(f"project is not allowlisted: {project}", 403, "workspace_not_found")
    item = config.projects[project]
    if not item.root.exists() or not item.root.is_dir():
        raise error_factory(f"project root does not exist: {item.root}", 500, None)
    return item


def handle_codex_intake(
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: IntakePreparationDependencies,
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
    execution_evaluation = load_optional_intake_json_artifact(
        config,
        intake_id,
        "EXECUTION_EVALUATION.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    followup_task_draft = load_optional_intake_json_artifact(
        config,
        intake_id,
        "FOLLOWUP_TASK_DRAFT.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    ledger_note_draft = load_optional_intake_json_artifact(
        config,
        intake_id,
        "LEDGER_NOTE_DRAFT.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    review_proposal_draft = load_optional_intake_json_artifact(
        config,
        intake_id,
        "REVIEW_PROPOSAL_DRAFT.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    hypothesis_update = load_optional_intake_json_artifact(
        config,
        intake_id,
        "HYPOTHESIS_UPDATE.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    hypothesis_promotion = load_optional_intake_json_artifact(
        config,
        intake_id,
        "HYPOTHESIS_PROMOTION.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    experiment_index_update = load_optional_intake_json_artifact(
        config,
        intake_id,
        "EXPERIMENT_INDEX_UPDATE.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    experiment_promotion = load_optional_intake_json_artifact(
        config,
        intake_id,
        "EXPERIMENT_PROMOTION.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    current_conclusion_update = load_optional_intake_json_artifact(
        config,
        intake_id,
        "CURRENT_CONCLUSION_UPDATE.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    current_conclusion_promotion = load_optional_intake_json_artifact(
        config,
        intake_id,
        "CURRENT_CONCLUSION_PROMOTION.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    evaluation_report = load_optional_intake_json_artifact(
        config,
        intake_id,
        "EVALUATION_REPORT.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    current_conclusions = load_optional_intake_json_artifact(
        config,
        intake_id,
        "CURRENT_CONCLUSIONS.json",
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    operator_summary = load_optional_intake_json_artifact(
        config,
        intake_id,
        "OPERATOR_SUMMARY.json",
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
        "execution_evaluation": execution_evaluation,
        "followup_task_draft": followup_task_draft,
        "ledger_note_draft": ledger_note_draft,
        "review_proposal_draft": review_proposal_draft,
        "hypothesis_update": hypothesis_update,
        "hypothesis_promotion": hypothesis_promotion,
        "experiment_index_update": experiment_index_update,
        "experiment_promotion": experiment_promotion,
        "current_conclusion_update": current_conclusion_update,
        "current_conclusion_promotion": current_conclusion_promotion,
        "evaluation_report": evaluation_report,
        "current_conclusions": current_conclusions,
        "operator_summary": operator_summary,
        "event_count": event_count,
        "ready_to_run": bool(bundle["preflight"].get("ok") and not questions),
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
    execution_evaluation = filter_source_task_artifact(
        read_json_object_if_exists(root / "EXECUTION_EVALUATION.json"),
        followup_task_id,
        "task_id",
    )
    ledger_note_draft = filter_source_task_artifact(
        read_json_object_if_exists(root / "LEDGER_NOTE_DRAFT.json"),
        followup_task_id,
        "source_task_id",
    )
    review_proposal_draft = filter_source_task_artifact(
        read_json_object_if_exists(root / "REVIEW_PROPOSAL_DRAFT.json"),
        followup_task_id,
        "source_task_id",
    )
    hypothesis_update = filter_source_task_artifact(
        read_json_object_if_exists(root / "HYPOTHESIS_UPDATE.json"),
        followup_task_id,
        "source_task_id",
    )
    hypothesis_promotion = filter_source_task_artifact(
        read_json_object_if_exists(root / "HYPOTHESIS_PROMOTION.json"),
        followup_task_id,
        "source_task_id",
    )
    experiment_index_update = filter_source_task_artifact(
        read_json_object_if_exists(root / "EXPERIMENT_INDEX_UPDATE.json"),
        followup_task_id,
        "source_task_id",
    )
    experiment_promotion = filter_source_task_artifact(
        read_json_object_if_exists(root / "EXPERIMENT_PROMOTION.json"),
        followup_task_id,
        "source_task_id",
    )
    current_conclusion_update = filter_source_task_artifact(
        read_json_object_if_exists(root / "CURRENT_CONCLUSION_UPDATE.json"),
        followup_task_id,
        "source_task_id",
    )
    current_conclusion_promotion = filter_source_task_artifact(
        read_json_object_if_exists(root / "CURRENT_CONCLUSION_PROMOTION.json"),
        followup_task_id,
        "source_task_id",
    )
    evaluation_report = filter_source_task_artifact(
        read_json_object_if_exists(root / "EVALUATION_REPORT.json"),
        followup_task_id,
        "task_id",
    )
    current_conclusions = filter_source_task_artifact(
        read_json_object_if_exists(root / "CURRENT_CONCLUSIONS.json"),
        followup_task_id,
        "source_task_id",
    )
    operator_summary = filter_source_task_artifact(
        read_json_object_if_exists(root / "OPERATOR_SUMMARY.json"),
        followup_task_id,
        "source_task_id",
    )
    return {
        "task_id": followup_task_id,
        "source_intake_id": intake_id,
        "task": task,
        "draft": draft,
        "execution_evaluation": execution_evaluation,
        "ledger_note_draft": ledger_note_draft,
        "review_proposal_draft": review_proposal_draft,
        "hypothesis_update": hypothesis_update,
        "hypothesis_promotion": hypothesis_promotion,
        "experiment_index_update": experiment_index_update,
        "experiment_promotion": experiment_promotion,
        "current_conclusion_update": current_conclusion_update,
        "current_conclusion_promotion": current_conclusion_promotion,
        "evaluation_report": evaluation_report,
        "current_conclusions": current_conclusions,
        "operator_summary": operator_summary,
    }


def execution_evaluation_dependencies(
    *,
    utc_now: Callable[[], dt.datetime],
    task_intake_id: Callable[[JsonObject], str],
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> ExecutionEvaluationDependencies:
    return ExecutionEvaluationDependencies(
        utc_now=utc_now,
        intake_dir=lambda config, intake_id: intake_dir(
            config,
            intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        ),
        read_json_object_if_exists=read_json_object_if_exists,
        write_json_atomic=write_json_atomic,
        write_text_atomic=write_text_atomic,
        append_jsonl=append_jsonl,
        task_intake_id=task_intake_id,
    )


def safe_intake_text(
    value: str,
    max_chars: int,
    *,
    error_factory: ErrorFactory,
) -> str:
    text = str(value or "").strip()
    if len(text) > max_chars:
        raise error_factory(f"text is too long; max {max_chars} chars", 400, "invalid_request")
    return text


def intake_answers_text(
    payload: Payload,
    *,
    error_factory: ErrorFactory,
) -> str:
    return safe_intake_text(
        payload.get("answers") or payload.get("answer") or "",
        4000,
        error_factory=error_factory,
    )


def handle_codex_prepare(
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: IntakePreparationDependencies,
    intake_id_re: re.Pattern[str],
    max_task_chars: int,
) -> JsonObject:
    deps.reject_frontend_identity(payload)
    intake_id = (payload.get("intake_id") or "").strip()
    followup_task_id = (payload.get("followup_task_id") or payload.get("followupTaskId") or "").strip()
    if intake_id and followup_task_id:
        raise deps.error_factory("intake_id and followup_task_id cannot be used together", 400, "invalid_request")
    existing_intent: JsonObject = {}
    followup_seed: JsonObject = {}
    if intake_id:
        intake_id = validate_intake_id(intake_id, intake_id_re=intake_id_re, error_factory=deps.error_factory)
        existing_intent = load_intake_intent(config, intake_id, intake_id_re=intake_id_re, error_factory=deps.error_factory)
    else:
        intake_id = new_intake_id(utc_now=deps.utc_now)
    if followup_task_id:
        followup_task_id = deps.validate_task_id(followup_task_id)
        followup_seed = load_followup_prepare_seed(
            config,
            followup_task_id,
            principal,
            authorize_task=deps.authorize_task,
            task_intake_id=deps.task_intake_id,
            intake_id_re=intake_id_re,
            error_factory=deps.error_factory,
        )
    followup_draft = followup_seed.get("draft") if isinstance(followup_seed.get("draft"), dict) else {}

    project_name = (
        (payload.get("workspace") or payload.get("project", "")).strip()
        or str(existing_intent.get("workspace") or "")
        or str(followup_draft.get("workspace") or "")
        or str((followup_seed.get("task") or {}).get("project") or "")
    )
    prompt = safe_intake_text(
        payload.get("prompt", "") or str(existing_intent.get("prompt") or "") or str(followup_draft.get("prompt") or ""),
        max_task_chars,
        error_factory=deps.error_factory,
    )
    if not prompt:
        raise deps.error_factory("prompt is required", 400, "invalid_request")
    project = validate_codex_project(
        config,
        project_name,
        project_name_re=deps.project_name_re,
        error_factory=deps.error_factory,
    )
    mode = (
        payload.get("mode")
        or str(existing_intent.get("desired_mode") or "")
        or str(followup_draft.get("suggested_mode") or "")
        or project.default_mode
    ).strip() or project.default_mode
    if mode not in project.allowed_modes:
        allowed = ", ".join(project.allowed_modes)
        raise deps.error_factory(
            f"mode {mode} is not allowed for workspace {project.name}; allowed: {allowed}",
            400,
            "invalid_request",
        )

    answers = intake_answers_text(payload, error_factory=deps.error_factory)
    reference_task_id = (
        payload.get("reference_task_id")
        or payload.get("referenceTaskId")
        or str(existing_intent.get("reference_task_id") or "")
        or str(followup_draft.get("reference_task_id") or "")
    ).strip()
    if reference_task_id:
        reference_task_id = deps.validate_task_id(reference_task_id)
        deps.authorize_task(config, principal, reference_task_id)

    source = deps.safe_adapter_source(payload.get("source", "web"))
    signals = parse_intent_signals(prompt, answers)
    objective = infer_objective(signals)
    gray_areas = build_gray_areas(prompt, answers, reference_task_id, signals)
    questions = clarification_questions(gray_areas, signals)
    risk_class = intake_risk_class(objective, signals)
    status = "blocked" if risk_class == "high" else ("clarifying" if questions else "compiled")
    evidence_retrieval = maybe_run_evidence_retrieval(
        project.root,
        prompt,
        answers,
        objective,
        signals,
        lambda text, max_chars: safe_intake_text(text, max_chars, error_factory=deps.error_factory),
        should_consult_evidence_index,
    )
    contract = make_task_contract(
        intake_id=intake_id,
        project=project,
        prompt=prompt,
        answers=answers,
        objective=objective,
        mode=mode,
        reference_task_id=reference_task_id,
        risk_class=risk_class,
        signals=signals,
        status=status,
        evidence_retrieval=evidence_retrieval,
        prompt_preview=deps.prompt_preview,
        utc_now=deps.utc_now,
    )
    taskbox = make_taskbox_draft(contract)
    preflight = make_policy_preflight(project, contract, taskbox, questions, evidence_retrieval)
    intent = {
        "schema_version": 1,
        "intake_id": intake_id,
        "workspace": project.name,
        "source": source,
        "user": principal.user,
        "reference_task_id": reference_task_id or "",
        "followup_task_id": followup_task_id or "",
        "followup_source_intake_id": str(followup_seed.get("source_intake_id") or ""),
        "prompt": prompt,
        "prompt_preview": deps.prompt_preview(prompt),
        "desired_mode": mode,
        "status": status,
        "objective_guess": objective,
        "signals": signals,
        "gray_area_count": len(gray_areas),
        "experiment_decision_gate_required": bool((contract.get("experiment_decision_gate") or {}).get("required")),
        "evidence_retrieval_required": bool(evidence_retrieval.get("required")),
        "evidence_retrieval_consulted": bool(evidence_retrieval.get("consulted")),
        "evidence_retrieval_decision": evidence_retrieval.get("decision"),
        "answers_count": 1 if answers else 0,
        "updated_at": deps.utc_now().isoformat().replace("+00:00", "Z"),
    }
    persist_intake_artifacts(
        config=config,
        project=project,
        intake_id=intake_id,
        intent=intent,
        gray_areas=gray_areas,
        questions=questions,
        contract=contract,
        taskbox=taskbox,
        preflight=preflight,
        evidence_retrieval=evidence_retrieval,
        answers=answers,
        event_type="intake_replied"
        if answers and existing_intent
        else ("intake_created_from_followup" if followup_task_id else "intake_created"),
        utc_now=deps.utc_now,
        intake_id_re=intake_id_re,
        error_factory=deps.error_factory,
    )
    operator_summary = build_prepare_operator_summary(
        intent,
        contract,
        taskbox,
        preflight,
        evidence_retrieval,
        questions,
    )
    return {
        "ok": True,
        "intake_id": intake_id,
        "workspace": project.name,
        "followup_task_id": followup_task_id or None,
        "followup_source_intake_id": str(followup_seed.get("source_intake_id") or "") or None,
        "followup_context": {
            "source_task_id": followup_task_id or None,
            "source_intake_id": str(followup_seed.get("source_intake_id") or "") or None,
            "execution_evaluation": (
                followup_seed.get("execution_evaluation")
                if isinstance(followup_seed.get("execution_evaluation"), dict) and followup_seed.get("execution_evaluation")
                else None
            ),
            "followup_task_draft": followup_draft or None,
            "ledger_note_draft": (
                followup_seed.get("ledger_note_draft")
                if isinstance(followup_seed.get("ledger_note_draft"), dict) and followup_seed.get("ledger_note_draft")
                else None
            ),
            "review_proposal_draft": (
                followup_seed.get("review_proposal_draft")
                if isinstance(followup_seed.get("review_proposal_draft"), dict) and followup_seed.get("review_proposal_draft")
                else None
            ),
            "hypothesis_update": (
                followup_seed.get("hypothesis_update")
                if isinstance(followup_seed.get("hypothesis_update"), dict) and followup_seed.get("hypothesis_update")
                else None
            ),
            "hypothesis_promotion": (
                followup_seed.get("hypothesis_promotion")
                if isinstance(followup_seed.get("hypothesis_promotion"), dict) and followup_seed.get("hypothesis_promotion")
                else None
            ),
            "experiment_index_update": (
                followup_seed.get("experiment_index_update")
                if isinstance(followup_seed.get("experiment_index_update"), dict) and followup_seed.get("experiment_index_update")
                else None
            ),
            "experiment_promotion": (
                followup_seed.get("experiment_promotion")
                if isinstance(followup_seed.get("experiment_promotion"), dict) and followup_seed.get("experiment_promotion")
                else None
            ),
            "current_conclusion_update": (
                followup_seed.get("current_conclusion_update")
                if isinstance(followup_seed.get("current_conclusion_update"), dict) and followup_seed.get("current_conclusion_update")
                else None
            ),
            "current_conclusion_promotion": (
                followup_seed.get("current_conclusion_promotion")
                if isinstance(followup_seed.get("current_conclusion_promotion"), dict) and followup_seed.get("current_conclusion_promotion")
                else None
            ),
            "evaluation_report": (
                followup_seed.get("evaluation_report")
                if isinstance(followup_seed.get("evaluation_report"), dict) and followup_seed.get("evaluation_report")
                else None
            ),
            "current_conclusions": (
                followup_seed.get("current_conclusions")
                if isinstance(followup_seed.get("current_conclusions"), dict) and followup_seed.get("current_conclusions")
                else None
            ),
            "operator_summary": (
                followup_seed.get("operator_summary")
                if isinstance(followup_seed.get("operator_summary"), dict) and followup_seed.get("operator_summary")
                else None
            ),
        }
        if followup_task_id
        else None,
        "status": "blocked" if risk_class == "high" else ("need_user_reply" if questions else ("blocked" if not preflight.get("ok") else "prepared")),
        "questions": questions,
        "gray_areas": gray_areas,
        "decision_gate": contract.get("experiment_decision_gate"),
        "contract": contract,
        "taskbox": taskbox,
        "preflight": preflight,
        "evidence_retrieval": evidence_retrieval,
        "operator_summary": operator_summary,
        "research_program": load_optional_intake_json_artifact(
            config,
            intake_id,
            "RESEARCH_PROGRAM.json",
            intake_id_re=intake_id_re,
            error_factory=deps.error_factory,
        ),
        "hypothesis_registry": load_optional_intake_json_artifact(
            config,
            intake_id,
            "HYPOTHESIS_REGISTRY.json",
            intake_id_re=intake_id_re,
            error_factory=deps.error_factory,
        ),
        "experiment_spec": load_optional_intake_json_artifact(
            config,
            intake_id,
            "EXPERIMENT_SPEC.json",
            intake_id_re=intake_id_re,
            error_factory=deps.error_factory,
        ),
        "artifacts_dir": str(intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=deps.error_factory)),
        "ready_to_run": bool(preflight.get("ok") and not questions),
    }
