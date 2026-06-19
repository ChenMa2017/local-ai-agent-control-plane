from __future__ import annotations

import re
from typing import Any, Callable

from evidence_retrieval import maybe_run_evidence_retrieval
from operator_summary import build_prepare_operator_summary
from intake_store import (
    intake_dir,
    load_intake_intent,
    load_optional_intake_json_artifact,
    new_intake_id,
    validate_intake_id,
)
from intake_views import load_followup_prepare_seed
from prepare_artifacts import (
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

FOLLOWUP_RESPONSE_FIELDS = (
    "execution_evaluation",
    "ledger_note_draft",
    "review_proposal_draft",
    "hypothesis_update",
    "hypothesis_promotion",
    "experiment_result",
    "experiment_index_update",
    "experiment_promotion",
    "current_conclusion_update",
    "current_conclusion_promotion",
    "evaluation_report",
    "current_conclusions",
    "operator_summary",
)


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


def _optional_dict(seed: JsonObject, key: str) -> JsonObject | None:
    value = seed.get(key)
    if isinstance(value, dict) and value:
        return value
    return None


def followup_guidance_from_draft(followup_draft: JsonObject) -> JsonObject | None:
    if not isinstance(followup_draft, dict) or not followup_draft:
        return None
    remediation = followup_draft.get("remediation") if isinstance(followup_draft.get("remediation"), dict) else None
    guidance: JsonObject = {
        "recommended_next_action": str(followup_draft.get("recommended_next_action") or "").strip() or None,
        "reason": str(followup_draft.get("reason") or followup_draft.get("summary") or "").strip() or None,
        "remediation": remediation,
        "evidence_retrieval_decision": str(followup_draft.get("evidence_retrieval_decision") or "").strip() or None,
        "requires_prepare": bool(followup_draft.get("requires_prepare")),
        "claim_boundary": str(followup_draft.get("claim_boundary") or "").strip() or None,
    }
    if not any(
        value not in (None, "", False)
        for key, value in guidance.items()
        if key != "requires_prepare"
    ) and not guidance["requires_prepare"]:
        return None
    return guidance


def build_followup_context(
    followup_seed: JsonObject,
    followup_task_id: str,
    followup_draft: JsonObject,
) -> JsonObject | None:
    if not followup_task_id:
        return None
    context: JsonObject = {
        "source_task_id": followup_task_id or None,
        "source_intake_id": str(followup_seed.get("source_intake_id") or "") or None,
        "followup_guidance": followup_guidance_from_draft(followup_draft),
        "followup_task_draft": followup_draft or None,
    }
    for field in FOLLOWUP_RESPONSE_FIELDS:
        context[field] = _optional_dict(followup_seed, field)
    return context


def handle_codex_prepare(
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: Any,
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
    followup_guidance = followup_guidance_from_draft(followup_draft) or {}

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
        "followup_recommended_next_action": str(followup_guidance.get("recommended_next_action") or ""),
        "followup_reason": str(followup_guidance.get("reason") or ""),
        "followup_remediation": (
            followup_guidance.get("remediation")
            if isinstance(followup_guidance.get("remediation"), dict)
            else None
        ),
        "followup_evidence_retrieval_decision": str(followup_guidance.get("evidence_retrieval_decision") or ""),
        "followup_requires_prepare": bool(followup_guidance.get("requires_prepare")),
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
        "followup_guidance": followup_guidance or None,
        "followup_context": build_followup_context(followup_seed, followup_task_id, followup_draft),
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
