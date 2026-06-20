from __future__ import annotations

import datetime as dt
import re
from typing import Any, Callable

from .intake_store import append_jsonl, intake_dir, write_json_atomic, write_text_atomic
from ..reporting.operator_summary import build_prepare_operator_summary, operator_summary_markdown
from .prepare_intent import build_experiment_decision_gate, evidence_retrieval_summary, read_plan_markdown
from ..research.research_objects import build_experiment_spec, build_hypothesis_registry, load_research_program_snapshot

JsonObject = dict[str, Any]
ErrorFactory = Callable[[str, int, str | None], Exception]


def make_task_contract(
    *,
    intake_id: str,
    project: Any,
    prompt: str,
    answers: str,
    objective: str,
    mode: str,
    reference_task_id: str,
    risk_class: str,
    signals: JsonObject,
    status: str,
    evidence_retrieval: JsonObject,
    prompt_preview: Callable[[Any], str],
    utc_now: Callable[[], dt.datetime],
) -> JsonObject:
    decision_source = "user+answers" if answers else "user"
    requires_human = risk_class == "high"
    decision_gate = build_experiment_decision_gate(prompt, answers, objective, signals)
    write_scope: list[str] = []
    if objective == "local_workspace_copy":
        write_scope = ["workspace/<task_id>/", "runs/<task_id>/", "agent/status/", "agent/reports/"]
    return {
        "schema_version": 1,
        "intake_id": intake_id,
        "workspace": project.name,
        "status": status,
        "objective": objective,
        "mode": mode,
        "risk_class": risk_class,
        "decision_source": decision_source,
        "requires_human": requires_human,
        "reference_task_id": reference_task_id or "",
        "prompt": prompt,
        "answers_summary": answers,
        "summary": prompt_preview(prompt),
        "experiment_decision_gate": decision_gate,
        "write_scope": write_scope,
        "blocked_actions": [
            "shared_file_promotion_without_human_review",
            "dataset_or_checkpoint_mutation",
            "external_send_without_human_review",
            "service_or_secret_mutation",
        ],
        "evidence_retrieval": evidence_retrieval_summary(evidence_retrieval),
        "signals": signals,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def make_taskbox_draft(contract: JsonObject) -> JsonObject:
    objective = str(contract.get("objective") or "")
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    retrieval = contract.get("evidence_retrieval") if isinstance(contract.get("evidence_retrieval"), dict) else {}
    gate_required = bool(decision_gate.get("required"))
    gate_blocking = bool(decision_gate.get("blocking"))
    gate_status = "blocked" if gate_blocking else ("required_ready" if gate_required else "not_required")
    if objective == "report_only":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "blocked" if gate_blocking else "ready",
            "allowed_runner": "report_only",
            "workspace_mode": "readonly",
            "allowed_write_paths": [],
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Report-only clarification result; no execution side effects.",
            "experiment_decision_gate": decision_gate,
            "experiment_gate_status": gate_status,
            "evidence_retrieval": retrieval,
        }
    if objective == "bounded_cpu_eval":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "blocked" if gate_blocking else "ready",
            "allowed_runner": "cpu",
            "workspace_mode": "readonly",
            "allowed_write_paths": ["runs/<task_id>/", "agent/status/", "agent/reports/"],
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Bounded CPU evaluation or smoke-check task."
            if not gate_blocking
            else "Bounded CPU evaluation draft exists, but experiment decisions are still unresolved.",
            "experiment_decision_gate": decision_gate,
            "experiment_gate_status": gate_status,
            "evidence_retrieval": retrieval,
        }
    if objective == "local_workspace_copy":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "blocked" if gate_blocking else "ready",
            "allowed_runner": "cpu",
            "workspace_mode": "project_local_copy",
            "allowed_write_paths": contract.get("write_scope", []),
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Project-local copy task; shared files remain protected."
            if not gate_blocking
            else "Project-local copy draft exists, but experiment decisions are still unresolved.",
            "experiment_decision_gate": decision_gate,
            "experiment_gate_status": gate_status,
            "evidence_retrieval": retrieval,
        }
    return {
        "schema_version": 1,
        "intake_id": contract["intake_id"],
        "status": "blocked",
        "allowed_runner": "none",
        "workspace_mode": "none",
        "allowed_write_paths": [],
        "blocked_actions": contract.get("blocked_actions", []),
        "summary": "High-risk or nondelegable task; requires human approval before execution.",
        "experiment_decision_gate": decision_gate,
        "experiment_gate_status": gate_status,
        "evidence_retrieval": retrieval,
    }


def make_policy_preflight(
    project: Any,
    contract: JsonObject,
    taskbox: JsonObject,
    questions: list[str],
    evidence_retrieval: JsonObject,
) -> JsonObject:
    objective = str(contract.get("objective") or "")
    risk_class = str(contract.get("risk_class") or "low")
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    blocked_by: list[str] = []
    reasons: list[str] = []
    if questions:
        blocked_by.append("clarification_required")
        reasons.append("Task intent still has unresolved gray areas.")
    if decision_gate.get("required") and decision_gate.get("blocking"):
        blocked_by.append("experiment_decision_gate_required")
        unresolved = ", ".join(str(item) for item in decision_gate.get("unresolved_items", []))
        reasons.append(f"Experiment decision gate is still unresolved: {unresolved}.")
    if risk_class == "high":
        blocked_by.append("human_review_required")
        reasons.append(f"Objective {objective} is intentionally held for human approval.")
    if str(contract.get("mode") or "") not in project.allowed_modes:
        blocked_by.append("workspace_mode_not_allowed")
        reasons.append(f"Workspace {project.name} does not allow mode={contract.get('mode')}.")
    if objective not in {"report_only", "bounded_cpu_eval", "local_workspace_copy"} and risk_class != "high":
        blocked_by.append("unsupported_objective")
        reasons.append(f"Objective {objective} is not yet supported by the prepare pipeline.")
    retrieval_decision = evidence_retrieval.get("decision")
    retrieval_warnings = evidence_retrieval.get("warnings") if isinstance(evidence_retrieval.get("warnings"), list) else []
    if evidence_retrieval.get("required"):
        if evidence_retrieval.get("consulted") and retrieval_decision and retrieval_decision != "safe_to_answer":
            reasons.append(
                f"Evidence retrieval returned decision={retrieval_decision}; keep formal conclusion claims bounded until the referenced evidence is reviewed."
            )
        elif not evidence_retrieval.get("consulted"):
            reasons.append("Evidence retrieval was expected for this request but is not currently available for the selected workspace.")
    ok = not blocked_by
    decision = "ready" if ok else "blocked"
    required_action = "run" if ok else ("reply_to_questions" if "clarification_required" in blocked_by else "human_review")
    return {
        "schema_version": 1,
        "intake_id": contract["intake_id"],
        "ok": ok,
        "decision": decision,
        "blocked_by": blocked_by,
        "required_action": required_action,
        "reasons": reasons,
        "allowed_runner": taskbox.get("allowed_runner"),
        "workspace_mode": taskbox.get("workspace_mode"),
        "experiment_decision_gate_required": bool(decision_gate.get("required")),
        "evidence_retrieval_required": bool(evidence_retrieval.get("required")),
        "evidence_retrieval_consulted": bool(evidence_retrieval.get("consulted")),
        "evidence_retrieval_available": bool(evidence_retrieval.get("available")),
        "evidence_retrieval_decision": retrieval_decision,
        "evidence_retrieval_warnings": retrieval_warnings,
    }


def intake_summary_markdown(contract: JsonObject, questions: list[str], preflight: JsonObject) -> str:
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    retrieval = contract.get("evidence_retrieval") if isinstance(contract.get("evidence_retrieval"), dict) else {}
    lines = [
        "# Task Contract Summary",
        "",
        f"- intake_id: {contract.get('intake_id')}",
        f"- workspace: {contract.get('workspace')}",
        f"- objective: {contract.get('objective')}",
        f"- risk_class: {contract.get('risk_class')}",
        f"- decision_source: {contract.get('decision_source')}",
        f"- status: {contract.get('status')}",
        f"- preflight_ok: {'true' if preflight.get('ok') else 'false'}",
        f"- experiment_decision_gate_required: {'true' if decision_gate.get('required') else 'false'}",
        f"- evidence_retrieval_required: {'true' if retrieval.get('required') else 'false'}",
        f"- evidence_retrieval_consulted: {'true' if retrieval.get('consulted') else 'false'}",
        f"- evidence_retrieval_decision: {retrieval.get('decision') or 'none'}",
        "",
        "## Prompt",
        "",
        str(contract.get("prompt") or ""),
        "",
    ]
    answers = str(contract.get("answers_summary") or "")
    if answers:
        lines.extend(["## Answers", "", answers, ""])
    if questions:
        lines.append("## Pending Questions")
        lines.append("")
        for idx, question in enumerate(questions, start=1):
            lines.append(f"{idx}. {question}")
        lines.append("")
    if decision_gate.get("required"):
        lines.append("## Experiment Decision Gate")
        lines.append("")
        lines.append(f"- resolved_count: {decision_gate.get('resolved_count', 0)} / {decision_gate.get('decision_count', 0)}")
        lines.append(f"- blocking: {'true' if decision_gate.get('blocking') else 'false'}")
        for item in decision_gate.get("decisions", []):
            lines.append(
                f"- {item.get('decision_id')}: {item.get('title')} -> {'resolved' if item.get('resolved') else 'missing'}"
            )
        lines.append("")
    if retrieval.get("required"):
        lines.append("## Evidence Retrieval")
        lines.append("")
        lines.append(f"- decision: {retrieval.get('decision') or 'none'}")
        lines.append(f"- available: {'true' if retrieval.get('available') else 'false'}")
        lines.append(f"- consulted: {'true' if retrieval.get('consulted') else 'false'}")
        for warning in retrieval.get("warnings", []):
            lines.append(f"- warning: {warning}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def persist_intake_artifacts(
    *,
    config: Any,
    project: Any,
    intake_id: str,
    intent: JsonObject,
    gray_areas: list[str],
    questions: list[str],
    contract: JsonObject,
    taskbox: JsonObject,
    preflight: JsonObject,
    evidence_retrieval: JsonObject,
    answers: str,
    event_type: str,
    utc_now: Callable[[], dt.datetime],
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> None:
    root = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory)
    research_program = load_research_program_snapshot(project.root, workspace=project.name, intake_id=intake_id)
    hypothesis_registry = build_hypothesis_registry(contract, evidence_retrieval, research_program)
    experiment_spec = build_experiment_spec(
        contract,
        taskbox,
        preflight,
        evidence_retrieval,
        research_program,
        hypothesis_registry,
    )
    operator_summary = build_prepare_operator_summary(
        intent,
        contract,
        taskbox,
        preflight,
        evidence_retrieval,
        questions,
    )
    write_json_atomic(root / "INTENT_DRAFT.json", intent)
    write_json_atomic(root / "GRAY_AREAS.json", {"schema_version": 1, "intake_id": intake_id, "items": gray_areas})
    write_json_atomic(root / "QUESTIONS.json", {"schema_version": 1, "intake_id": intake_id, "items": questions})
    write_text_atomic(
        root / "QUESTIONS.md",
        "\n".join(
            ["# Clarification Questions", ""]
            + (
                [f"{idx}. {question}" for idx, question in enumerate(questions, start=1)]
                if questions
                else ["No pending clarification questions."]
            )
        ).rstrip()
        + "\n",
    )
    if answers:
        append_jsonl(root / "ANSWERS.jsonl", {"received_at": utc_now().isoformat().replace("+00:00", "Z"), "text": answers})
    write_json_atomic(root / "TASK_CONTRACT.json", contract)
    write_json_atomic(root / "TASKBOX_DRAFT.json", taskbox)
    write_json_atomic(root / "POLICY_PREFLIGHT.json", preflight)
    write_json_atomic(root / "DECISION_GATE.json", contract.get("experiment_decision_gate", {}))
    write_json_atomic(root / "EVIDENCE_RETRIEVAL.json", evidence_retrieval)
    write_json_atomic(root / "RESEARCH_PROGRAM.json", research_program)
    write_json_atomic(root / "HYPOTHESIS_REGISTRY.json", hypothesis_registry)
    write_json_atomic(root / "EXPERIMENT_SPEC.json", experiment_spec)
    write_json_atomic(root / "OPERATOR_SUMMARY.json", operator_summary)
    write_text_atomic(root / "READ_PLAN.md", read_plan_markdown(evidence_retrieval))
    write_text_atomic(root / "OPERATOR_SUMMARY.md", operator_summary_markdown(operator_summary))
    write_text_atomic(
        root / "ASSUMPTIONS.md",
        "\n".join(
            [
                "# Assumptions",
                "",
                f"- objective_guess: {contract.get('objective')}",
                f"- risk_class: {contract.get('risk_class')}",
                f"- workspace_mode: {taskbox.get('workspace_mode')}",
                f"- experiment_decision_gate_required: {'true' if (contract.get('experiment_decision_gate') or {}).get('required') else 'false'}",
                f"- evidence_retrieval_decision: {(evidence_retrieval.get('decision') or 'none')}",
            ]
        ).rstrip()
        + "\n",
    )
    write_text_atomic(root / f"TASK_CONTRACT_{intake_id}.md", intake_summary_markdown(contract, questions, preflight))
    append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": event_type,
            "intake_id": intake_id,
            "status": contract.get("status"),
            "objective": contract.get("objective"),
            "risk_class": contract.get("risk_class"),
            "preflight_ok": preflight.get("ok"),
            "evidence_retrieval_decision": evidence_retrieval.get("decision"),
            "timestamp": utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
