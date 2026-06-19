from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from experiment_contracts import build_experiment_contract_fields, build_structural_experiment_result
from hypothesis_state import (
    derive_hypothesis_record_status,
    validate_hypothesis_registry_transition,
    validate_status_transition,
)
from post_run_artifacts import claim_boundary_for_evaluation
from project_research_sync import (
    sync_project_current_conclusion,
    sync_project_experiment_index,
    sync_project_hypothesis_registry,
)
from promotion_policy import (
    current_conclusions_promotion_state,
    experiment_promotion_state,
    hypothesis_promotion_state,
)
from research_assessment import (
    build_conclusion_assessment,
    build_evaluation_report,
    build_experiment_assessment,
    build_hypothesis_assessment,
    build_research_machine_checks,
    build_research_validity,
)
from research_fingerprints import (
    current_conclusion_promotion_fingerprint,
    current_conclusion_update_fingerprint,
    current_conclusions_fingerprint,
    evaluation_report_fingerprint,
    experiment_index_update_fingerprint,
    experiment_promotion_fingerprint,
    experiment_result_fingerprint,
    hypothesis_promotion_fingerprint,
    hypothesis_update_fingerprint,
)

JsonObject = dict[str, Any]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def read_json_object_if_exists(path: Path) -> JsonObject:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def safe_excerpt(text: Any, max_chars: int = 220) -> str:
    value = " ".join(str(text or "").split())
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 1].rstrip() + "…"


def safe_topic_slug(text: Any, fallback: str) -> str:
    parts = re.findall(r"[A-Za-z0-9]+", str(text or "").lower())
    if not parts:
        return fallback
    return "_".join(parts[:8]) or fallback


def objective_task_type(objective: str) -> str:
    return {
        "report_only": "analysis",
        "bounded_cpu_eval": "bounded_execution",
        "bounded_gpu_probe": "bounded_execution",
        "bounded_training_canary": "bounded_execution",
        "local_workspace_copy": "bounded_execution",
        "promotion_apply": "evidence_curation",
        "external_send": "analysis",
        "training": "bounded_execution",
        "gpu": "bounded_execution",
    }.get(str(objective or ""), "analysis")


def load_research_program_snapshot(project_root: Path, *, workspace: str, intake_id: str) -> JsonObject:
    source_path = project_root / "research" / "RESEARCH_PROGRAM.json"
    program = read_json_object_if_exists(source_path)
    domain = program.get("domain") if isinstance(program.get("domain"), dict) else {}
    autonomy = program.get("autonomy_policy") if isinstance(program.get("autonomy_policy"), dict) else {}
    baseline = program.get("baseline_policy") if isinstance(program.get("baseline_policy"), dict) else {}
    conclusion = program.get("conclusion_policy") if isinstance(program.get("conclusion_policy"), dict) else {}
    return {
        "schema_version": "research_program_snapshot.v0.1",
        "intake_id": intake_id,
        "workspace": workspace,
        "source_path": "research/RESEARCH_PROGRAM.json",
        "available": bool(program),
        "program_schema_version": str(program.get("schema_version") or ""),
        "program_id": str(program.get("program_id") or ""),
        "domain_name": str(domain.get("name") or ""),
        "primary_question": str(domain.get("primary_question") or ""),
        "allowed_project_areas": list(domain.get("allowed_project_areas") or []),
        "autonomy_mode": str(autonomy.get("mode") or ""),
        "allowed_task_types": list(autonomy.get("allowed_task_types") or []),
        "baseline_required": baseline.get("required") if isinstance(baseline.get("required"), bool) else None,
        "allowed_conclusion_statuses": list(conclusion.get("allowed_conclusion_statuses") or []),
        "publish_only_after_review": bool(conclusion.get("publish_only_after_review")),
        "program": program,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_hypothesis_registry(
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
) -> JsonObject:
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    unresolved_items = list(decision_gate.get("unresolved_items") or [])
    prompt = str(contract.get("prompt") or "")
    summary = str(contract.get("summary") or "") or safe_excerpt(prompt)
    objective = str(contract.get("objective") or "")
    experiment_required = bool(decision_gate.get("required"))
    if unresolved_items:
        registry_status = "needs_clarification"
        hypothesis_status = "needs_clarification"
    elif experiment_required:
        registry_status = "active"
        hypothesis_status = "proposed"
    else:
        registry_status = "analysis_only"
        hypothesis_status = "analysis_only"
    prediction_statement = (
        f"Bounded evidence should clarify whether {summary.lower()}."
        if summary
        else "Bounded evidence should clarify the prepared request claim."
    )
    falsification = (
        "Prepared bounded execution or follow-up evidence does not support the prepared claim."
        if experiment_required
        else "Prepared bounded analysis does not produce evidence that supports the prepared claim."
    )
    return {
        "schema_version": "hypothesis_registry.v0.1",
        "intake_id": contract.get("intake_id"),
        "workspace": contract.get("workspace"),
        "objective": objective,
        "research_program_id": str(research_program.get("program_id") or ""),
        "registry_status": registry_status,
        "primary_question": summary or safe_excerpt(prompt, 400),
        "evidence_retrieval_decision": evidence_retrieval.get("decision"),
        "unresolved_items": unresolved_items,
        "hypotheses": [
            {
                "hypothesis_id": f"hypothesis_{contract.get('intake_id') or 'unknown'}",
                "type": "experiment" if experiment_required else "analysis",
                "status": hypothesis_status,
                "summary": summary or "Prepared request hypothesis placeholder.",
                "statement": prompt,
                "claim": summary or safe_excerpt(prompt, 280),
                "mechanism": (
                    "Prepared task suggests a bounded experiment should test this claim."
                    if experiment_required
                    else "Prepared task suggests a bounded analysis should inspect this claim."
                ),
                "prediction": [
                    {
                        "prediction_id": f"prediction_{contract.get('intake_id') or 'unknown'}",
                        "statement": prediction_statement,
                        "metric": None,
                        "expected_direction": None,
                        "minimum_effect": None,
                    }
                ],
                "falsification_criteria": [falsification],
                "required_experiments": (
                    [
                        {
                            "experiment_type": objective_task_type(objective),
                            "purpose": summary or safe_excerpt(prompt, 180),
                            "status": "missing" if unresolved_items else "candidate_ready",
                        }
                    ]
                    if experiment_required
                    else []
                ),
                "supporting_evidence": [
                    {
                        "kind": "read_plan_path",
                        "path": str(item.get("path") or ""),
                    }
                    for item in (evidence_retrieval.get("read_plan") or [])
                    if isinstance(item, dict) and str(item.get("path") or "").strip()
                ],
                "contradicting_evidence": [],
                "confidence": {
                    "value": 0.2 if unresolved_items else (0.35 if experiment_required else 0.1),
                    "method": "prepare_prior",
                    "calibration": "low",
                },
                "claim_scope": "bounded_review_only"
                if str(evidence_retrieval.get("decision") or "") not in {"", "safe_to_answer"}
                else "candidate_for_review",
                "supporting_read_plan_paths": [
                    str(item.get("path") or "")
                    for item in (evidence_retrieval.get("read_plan") or [])
                    if isinstance(item, dict) and str(item.get("path") or "").strip()
                ],
            }
        ],
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_experiment_spec(
    contract: JsonObject,
    taskbox: JsonObject,
    preflight: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    hypothesis_registry: JsonObject,
) -> JsonObject:
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    objective = str(contract.get("objective") or "")
    experiment_required = bool(decision_gate.get("required")) or objective in {
        "bounded_cpu_eval",
        "bounded_gpu_probe",
        "bounded_training_canary",
        "training",
        "gpu",
    }
    status = "not_required"
    if experiment_required:
        status = "blocked" if not preflight.get("ok") else "ready"
    baseline_policy = (
        research_program.get("program", {}).get("baseline_policy")
        if isinstance(research_program.get("program"), dict)
        else {}
    )
    baseline_entities = (
        [str(item) for item in (baseline_policy.get("baseline_entities") or []) if str(item or "").strip()]
        if isinstance(baseline_policy, dict)
        else []
    )
    summary = str(contract.get("summary") or contract.get("prompt") or objective or "")
    read_plan = list(evidence_retrieval.get("read_plan") or [])
    experiment_id = None
    if experiment_required:
        experiment_id = safe_topic_slug(
            f"experiment_{contract.get('intake_id') or objective}_{summary}",
            "experiment_candidate",
        )
    contract_fields = build_experiment_contract_fields(
        objective=objective,
        task_type=objective_task_type(objective),
        summary=summary,
        decision_gate=decision_gate,
        taskbox=taskbox,
        preflight=preflight,
        read_plan=read_plan,
        baseline_required=research_program.get("baseline_required"),
        baseline_entities=baseline_entities,
        experiment_required=experiment_required,
    )
    return {
        "schema_version": "experiment_spec.v0.1",
        "intake_id": contract.get("intake_id"),
        "workspace": contract.get("workspace"),
        "objective": objective,
        "task_type": objective_task_type(objective),
        "required": experiment_required,
        "status": status,
        "research_program_id": str(research_program.get("program_id") or ""),
        "baseline_required": research_program.get("baseline_required"),
        "experiment_id": experiment_id,
        "allowed_runner": taskbox.get("allowed_runner"),
        "workspace_mode": taskbox.get("workspace_mode"),
        "hypothesis_ids": [
            str(item.get("hypothesis_id") or "")
            for item in (hypothesis_registry.get("hypotheses") or [])
            if isinstance(item, dict) and str(item.get("hypothesis_id") or "").strip()
        ],
        "decision_gate": decision_gate,
        "blocked_by": list(preflight.get("blocked_by") or []),
        "evidence_retrieval_decision": evidence_retrieval.get("decision"),
        "read_plan": read_plan,
        **contract_fields,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_experiment_result(
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    review_proposal_draft: JsonObject,
    research_program: JsonObject | None = None,
    runner_metrics: JsonObject | None = None,
    runner_metrics_status: JsonObject | None = None,
) -> JsonObject | None:
    if not bool(experiment_spec.get("required")):
        return None
    return build_structural_experiment_result(
        evaluation=evaluation,
        experiment_spec=experiment_spec,
        review_required=bool(
            review_proposal_draft.get("requires_human_review")
            or bool((research_program or {}).get("publish_only_after_review"))
        ),
        runner_metrics=runner_metrics,
        runner_metrics_status=runner_metrics_status,
    )


def experiment_evidence_scope(evaluation: JsonObject) -> str:
    if not evaluation.get("result_available"):
        return "none"
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    if evidence_decision == "safe_to_answer":
        return "primary_only"
    if evidence_decision:
        return "auxiliary_only"
    return "mixed"


def build_experiment_index_update(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    hypothesis_registry: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
    review_proposal_draft: JsonObject,
) -> JsonObject | None:
    promotion_state = experiment_promotion_state(
        evaluation,
        experiment_spec,
        research_program,
        review_proposal_draft,
        experiment_result,
    )
    if promotion_state == "not_required" or not evaluation.get("result_available"):
        return None
    objective = str(experiment_spec.get("objective") or contract.get("objective") or evaluation.get("objective") or "")
    experiment_type = str(experiment_spec.get("task_type") or objective_task_type(objective) or "bounded_execution")
    summary = str(contract.get("summary") or contract.get("prompt") or objective or "")
    baseline_policy = (
        research_program.get("program", {}).get("baseline_policy")
        if isinstance(research_program.get("program"), dict)
        else {}
    )
    baseline_entities = (
        list(baseline_policy.get("baseline_entities") or [])
        if isinstance(baseline_policy, dict)
        else []
    )
    doc_ids, _experiment_ids, _topic_id = evidence_support_ids(evidence_retrieval)
    hypothesis_ids = [
        str(item.get("hypothesis_id") or "")
        for item in (hypothesis_registry.get("hypotheses") or [])
        if isinstance(item, dict) and str(item.get("hypothesis_id") or "").strip()
    ]
    experiment_id = str(experiment_spec.get("experiment_id") or "").strip()
    if not experiment_id:
        experiment_id = safe_topic_slug(
            f"experiment_{evaluation.get('intake_id') or evaluation.get('task_id') or objective}",
            "experiment_candidate",
        )
    metrics = (
        list((experiment_result or {}).get("metrics") or [])
        if isinstance(experiment_result, dict)
        else []
    )
    preferred_metric = next(
        (
            item
            for item in metrics
            if isinstance(item, dict)
            and str(item.get("name") or "").strip()
            and str(item.get("name") or "").strip() != "safe_result_available"
            and item.get("value") is not None
        ),
        metrics[0] if metrics and isinstance(metrics[0], dict) else {},
    )
    primary_metric_name = str(preferred_metric.get("name") or "") if isinstance(preferred_metric, dict) else "safe_result_available"
    if not primary_metric_name:
        primary_metric_name = "safe_result_available"
    baseline_spec = experiment_spec.get("baseline_spec") if isinstance(experiment_spec.get("baseline_spec"), dict) else {}
    return {
        "schema_version": "experiment_index_update.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "research_program_id": str(research_program.get("program_id") or ""),
        "hypothesis_ids": hypothesis_ids,
        "experiment_id": experiment_id,
        "experiment_type": experiment_type,
        "status": "draft",
        "evidence_scope": experiment_evidence_scope(evaluation),
        "name": safe_excerpt(summary or f"Prepared experiment candidate for {objective}", 160),
        "purpose": safe_excerpt(
            contract.get("prompt") or summary or "Prepared experiment result index candidate.",
            280,
        ),
        "model": None,
        "baseline_model": str(baseline_entities[0]).strip() if baseline_entities else None,
        "baseline_spec": baseline_spec,
        "train_data": None,
        "test_data": None,
        "eval_protocol": f"prepared_{safe_topic_slug(objective or 'task', 'task')}_evaluation",
        "with_definition": safe_excerpt(
            summary or "Prepared experiment candidate produced a bounded result excerpt.",
            220,
        ),
        "without_definition": "No bounded result excerpt is available for this prepared experiment candidate.",
        "metric_definitions": list(experiment_spec.get("metric_definitions") or []),
        "success_criteria": list(experiment_spec.get("success_criteria") or []),
        "failure_criteria": (
            list((experiment_result or {}).get("failure_criteria") or [])
            if isinstance(experiment_result, dict) and list((experiment_result or {}).get("failure_criteria") or [])
            else list(experiment_spec.get("failure_criteria") or [])
        ),
        "primary_metrics": metrics
        or [
            {
                "name": primary_metric_name,
                "value": 1,
                "higher_is_better": True,
                "notes": "Execution result produced a non-empty safe excerpt for the prepared experiment candidate.",
            }
        ],
        "primary_metric_name": primary_metric_name,
        "assessment_basis": str((experiment_result or {}).get("assessment_basis") or "structural_only"),
        "experiment_result": (experiment_result or {}).get("result") if isinstance(experiment_result, dict) else None,
        "experiment_validity": (experiment_result or {}).get("validity") if isinstance(experiment_result, dict) else None,
        "reproducibility": (experiment_result or {}).get("reproducibility") if isinstance(experiment_result, dict) else {},
        "best_epoch": None,
        "primary_eval_path": None,
        "config_path": None,
        "code_commit": None,
        "run_id": str(evaluation.get("task_id") or "") or None,
        "official_conclusion_doc": doc_ids[0] if doc_ids else None,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_experiment_promotion(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    hypothesis_registry: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
    review_proposal_draft: JsonObject,
) -> JsonObject:
    promotion_state = experiment_promotion_state(
        evaluation,
        experiment_spec,
        research_program,
        review_proposal_draft,
        experiment_result,
    )
    experiment_index_update = build_experiment_index_update(
        evaluation,
        contract,
        evidence_retrieval,
        research_program,
        hypothesis_registry,
        experiment_spec,
        experiment_result,
        review_proposal_draft,
    )
    decision = {
        "not_required": "none",
        "not_ready": "none",
        "review_required": "prepare_review_bundle",
        "candidate_ready": "candidate_ready_for_apply",
        "human_review_required": "blocked_on_human_review",
    }.get(promotion_state, "none")
    notes: list[str] = []
    if promotion_state == "not_required":
        notes.append("Prepared intake marked this task as not requiring a formal experiment object.")
    if promotion_state == "not_ready":
        notes.append("Prepared intake requires an experiment object, but the task has not produced a promotable result yet.")
    if promotion_state == "review_required":
        notes.append("The experiment candidate is structurally ready, but project policy still requires review before publication.")
    if promotion_state == "candidate_ready":
        notes.append("The experiment candidate is structurally ready for a bounded project_index apply step.")
    if promotion_state == "human_review_required":
        notes.append("A human decision is required before any experiment promotion can proceed.")
    if experiment_index_update is None and promotion_state not in {"not_required", "not_ready"}:
        notes.append("No experiment index payload was generated from the current task result.")
    return {
        "schema_version": "experiment_promotion.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "research_program_id": str(research_program.get("program_id") or ""),
        "experiment_required": bool(experiment_spec.get("required")),
        "experiment_hypothesis_ids": [
            str(item.get("hypothesis_id") or "")
            for item in (hypothesis_registry.get("hypotheses") or [])
            if isinstance(item, dict) and str(item.get("hypothesis_id") or "").strip()
        ],
        "promotion_state": promotion_state,
        "experiment_index_update_status": promotion_state,
        "decision": decision,
        "requires_human_review": bool(
            review_proposal_draft.get("requires_human_review")
            or research_program.get("publish_only_after_review")
            or promotion_state in {"review_required", "human_review_required"}
        ),
        "publish_only_after_review": bool(research_program.get("publish_only_after_review")),
        "target_path_hint": "project_index/experiment_index.jsonl",
        "review_proposal_path_hint": "research/proposals/experiments/",
        "experiment_index_update": experiment_index_update,
        "notes": notes,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_hypothesis_update(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    hypothesis_registry: JsonObject,
    experiment_spec: JsonObject,
    review_proposal_draft: JsonObject,
    *,
    experiment_result: JsonObject | None = None,
    generated_supporting_experiments: list[str] | None = None,
) -> JsonObject | None:
    promotion_state = hypothesis_promotion_state(
        evaluation,
        hypothesis_registry,
        review_proposal_draft,
        experiment_spec,
        experiment_result,
    )
    hypotheses = hypothesis_registry.get("hypotheses") if isinstance(hypothesis_registry.get("hypotheses"), list) else []
    if promotion_state == "not_required" or not hypotheses:
        return None
    first = hypotheses[0] if isinstance(hypotheses[0], dict) else {}
    hypothesis_id = str(first.get("hypothesis_id") or "").strip()
    if not hypothesis_id:
        return None
    summary = str(first.get("summary") or contract.get("summary") or contract.get("prompt") or "")
    claim = str(first.get("claim") or summary or safe_excerpt(contract.get("prompt"), 280))
    mechanism = str(first.get("mechanism") or "").strip() or (
        "Prepared bounded execution should test whether this claim stays valid under the current task scope."
        if bool(experiment_spec.get("required"))
        else "Prepared bounded analysis should inspect whether this claim is useful enough to keep."
    )
    prediction = first.get("prediction") if isinstance(first.get("prediction"), list) and first.get("prediction") else [
        {
            "prediction_id": f"prediction_{hypothesis_id}",
            "statement": f"Bounded evidence should clarify whether {safe_excerpt(claim, 160).lower()}",
            "metric": None,
            "expected_direction": None,
            "minimum_effect": None,
        }
    ]
    falsification = (
        first.get("falsification_criteria")
        if isinstance(first.get("falsification_criteria"), list) and first.get("falsification_criteria")
        else ["Prepared bounded evidence does not support the claim."]
    )
    required_experiments = (
        first.get("required_experiments")
        if isinstance(first.get("required_experiments"), list)
        else []
    )
    if not required_experiments and bool(experiment_spec.get("required")):
        required_experiments = [
            {
                "experiment_type": experiment_spec.get("task_type") or objective_task_type(contract.get("objective")),
                "purpose": summary or "Prepared experiment candidate",
                "status": "candidate_ready" if generated_supporting_experiments else str(experiment_spec.get("status") or "missing"),
            }
        ]
    supporting_evidence = (
        list(first.get("supporting_evidence") or [])
        if isinstance(first.get("supporting_evidence"), list)
        else []
    )
    for item in (evidence_retrieval.get("read_plan") or []):
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        candidate = {"kind": "read_plan_path", "path": path}
        if candidate not in supporting_evidence:
            supporting_evidence.append(candidate)
    for experiment_id in generated_supporting_experiments or []:
        normalized = str(experiment_id or "").strip()
        if not normalized:
            continue
        candidate = {"kind": "experiment", "id": normalized}
        if candidate not in supporting_evidence:
            supporting_evidence.append(candidate)
    contradicting_evidence = (
        list(first.get("contradicting_evidence") or [])
        if isinstance(first.get("contradicting_evidence"), list)
        else []
    )
    confidence = first.get("confidence") if isinstance(first.get("confidence"), dict) else {}
    confidence_value = confidence.get("value")
    if not isinstance(confidence_value, (int, float)):
        confidence_value = 0.35 if promotion_state == "candidate_ready" else 0.2
    hypothesis_status = derive_hypothesis_record_status(
        evaluation,
        experiment_spec,
        experiment_result,
    )
    return {
        "schema_version": "hypothesis_record.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "program_id": str(research_program.get("program_id") or ""),
        "hypothesis_id": hypothesis_id,
        "created_by": "agent_host",
        "source": {
            "intake_id": evaluation.get("intake_id"),
            "source_task_id": evaluation.get("task_id"),
            "origin": "result_evaluation",
        },
        "claim": claim,
        "mechanism": mechanism,
        "prediction": prediction,
        "falsification_criteria": falsification,
        "required_experiments": required_experiments,
        "scope": {
            "applies_to": [str(contract.get("objective") or evaluation.get("objective") or "analysis")],
            "does_not_apply_to": ["unreviewed global conclusions"],
        },
        "supporting_evidence": supporting_evidence,
        "contradicting_evidence": contradicting_evidence,
        "confidence": {
            "value": round(float(confidence_value), 3),
            "method": str(confidence.get("method") or "prepare_prior"),
            "calibration": str(confidence.get("calibration") or "low"),
        },
        "evaluation_result": (
            str((experiment_result or {}).get("result") or "").strip()
            if isinstance(experiment_result, dict)
            else None
        ),
        "evaluation_validity": (
            str((experiment_result or {}).get("validity") or "").strip()
            if isinstance(experiment_result, dict)
            else None
        ),
        "assessment_basis": (
            str((experiment_result or {}).get("assessment_basis") or "").strip()
            if isinstance(experiment_result, dict)
            else None
        ),
        "imported_from_history": bool(first.get("imported_from_history")),
        "import_review_id": str(first.get("import_review_id") or "").strip() or None,
        "status": hypothesis_status,
        "supersedes": list(first.get("supersedes") or []) if isinstance(first.get("supersedes"), list) else [],
        "superseded_by": first.get("superseded_by"),
        "archival_reason": first.get("archival_reason"),
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_hypothesis_promotion(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    hypothesis_registry: JsonObject,
    experiment_spec: JsonObject,
    review_proposal_draft: JsonObject,
    *,
    experiment_result: JsonObject | None = None,
    generated_supporting_experiments: list[str] | None = None,
) -> JsonObject:
    promotion_state = hypothesis_promotion_state(
        evaluation,
        hypothesis_registry,
        review_proposal_draft,
        experiment_spec,
        experiment_result,
    )
    hypothesis_update = build_hypothesis_update(
        evaluation,
        contract,
        evidence_retrieval,
        research_program,
        hypothesis_registry,
        experiment_spec,
        review_proposal_draft,
        experiment_result=experiment_result,
        generated_supporting_experiments=generated_supporting_experiments,
    )
    decision = {
        "not_required": "none",
        "not_ready": "none",
        "review_required": "prepare_review_bundle",
        "candidate_ready": "candidate_ready_for_apply",
        "human_review_required": "blocked_on_human_review",
    }.get(promotion_state, "none")
    notes: list[str] = []
    if promotion_state == "not_required":
        notes.append("Prepared intake did not mark this task as hypothesis-bearing research work.")
    if promotion_state == "not_ready":
        notes.append("The hypothesis candidate exists, but the task has not produced a promotable result yet.")
    if promotion_state == "review_required":
        notes.append("The hypothesis candidate still has unresolved clarification or review requirements.")
    if promotion_state == "candidate_ready":
        notes.append("The hypothesis candidate is structurally ready for a bounded project-level registry apply step.")
    if promotion_state == "human_review_required":
        notes.append("A human decision is required before any hypothesis promotion can proceed.")
    return {
        "schema_version": "hypothesis_promotion.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "research_program_id": str(research_program.get("program_id") or ""),
        "promotion_state": promotion_state,
        "hypothesis_update_status": promotion_state,
        "decision": decision,
        "requires_human_review": bool(
            review_proposal_draft.get("requires_human_review")
            or promotion_state in {"review_required", "human_review_required"}
        ),
        "target_path_hint": "research/HYPOTHESIS_REGISTRY.jsonl",
        "review_proposal_path_hint": "research/proposals/hypotheses/",
        "hypothesis_update": hypothesis_update,
        "notes": notes,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def choose_conclusion_status(
    allowed_statuses: list[str],
    *,
    preferred: str,
    fallback: str | None = None,
) -> str | None:
    allowed = [str(item) for item in allowed_statuses if str(item or "").strip()]
    if not allowed:
        return preferred
    if preferred in allowed:
        return preferred
    if fallback and fallback in allowed:
        return fallback
    return allowed[0] if allowed else None


def evidence_support_ids(
    evidence_retrieval: JsonObject,
) -> tuple[list[str], list[str], str | None]:
    docs: list[str] = []
    experiments: list[str] = []
    topic_id: str | None = None
    hits = evidence_retrieval.get("hits") if isinstance(evidence_retrieval.get("hits"), list) else []
    for item in hits:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        hit_id = str(item.get("id") or "").strip()
        if not hit_id:
            continue
        if kind in {"document", "doc"} and hit_id not in docs:
            docs.append(hit_id)
        elif kind == "experiment" and hit_id not in experiments:
            experiments.append(hit_id)
        elif kind == "current_conclusion" and not topic_id:
            topic_id = hit_id
    return docs, experiments, topic_id


def current_conclusion_evidence_scope(evaluation: JsonObject) -> str:
    evidence_decision = str(evaluation.get("evidence_retrieval_decision") or "")
    if evidence_decision == "safe_to_answer":
        return "primary_only"
    if evidence_decision:
        return "auxiliary_only"
    return "none"


def build_current_conclusion_evidence_search(
    evaluation: JsonObject,
    evidence_retrieval: JsonObject,
) -> JsonObject | None:
    excerpt = str(evaluation.get("safe_result_excerpt") or "").strip()
    if not excerpt:
        return None
    read_plan_paths = [
        str(item.get("path") or "")
        for item in (evidence_retrieval.get("read_plan") or [])
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ]
    return {
        "schema_version": "current_conclusion_evidence_search.v0.1",
        "source_task_id": evaluation.get("task_id"),
        "query": str(evidence_retrieval.get("query") or ""),
        "decision": evaluation.get("evidence_retrieval_decision"),
        "warnings": list(evidence_retrieval.get("warnings") or []),
        "read_plan_paths": read_plan_paths,
    }


def build_current_conclusion_update(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    review_proposal_draft: JsonObject,
    *,
    generated_supporting_experiments: list[str] | None = None,
) -> JsonObject | None:
    promotion_state = current_conclusions_promotion_state(evaluation, review_proposal_draft, research_program)
    excerpt = str(evaluation.get("safe_result_excerpt") or "").strip()
    if not excerpt or promotion_state == "not_ready":
        return None
    allowed_statuses = list(research_program.get("allowed_conclusion_statuses") or [])
    summary = str(contract.get("summary") or contract.get("prompt") or contract.get("objective") or "")
    docs, experiments, existing_topic_id = evidence_support_ids(evidence_retrieval)
    for experiment_id in generated_supporting_experiments or []:
        normalized = str(experiment_id or "").strip()
        if normalized and normalized not in experiments:
            experiments.append(normalized)
    if promotion_state == "bounded_only":
        conclusion_status = choose_conclusion_status(allowed_statuses, preferred="auxiliary_only", fallback="tentative")
    else:
        conclusion_status = choose_conclusion_status(allowed_statuses, preferred="tentative", fallback="confirmed")
    evidence_scope = current_conclusion_evidence_scope(evaluation)
    risk_flags: list[str] = []
    if promotion_state == "bounded_only":
        risk_flags.append("bounded_only")
    if promotion_state == "review_required":
        risk_flags.append("review_required_before_publish")
    if bool(research_program.get("publish_only_after_review")):
        risk_flags.append("publish_only_after_review")
    if bool(review_proposal_draft.get("requires_human_review")):
        risk_flags.append("human_review_required")
    if str(evaluation.get("task_status") or "") != "done":
        risk_flags.append("non_terminal_result")
    return {
        "schema_version": "current_conclusion_update.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "topic_id": existing_topic_id or safe_topic_slug(summary, f"task_{evaluation.get('task_id') or 'unknown'}_conclusion"),
        "topic": safe_excerpt(summary or excerpt, 160),
        "conclusion_status": conclusion_status,
        "claim": excerpt,
        "evidence_scope": evidence_scope,
        "evidence_scope_note": (
            "Prepared evidence retrieval approved a safe answer for this bounded conclusion candidate."
            if evidence_scope == "primary_only"
            else "Prepared evidence retrieval did not approve a formal answer; keep this as an auxiliary-only candidate."
        ),
        "supporting_docs": docs,
        "supporting_experiments": experiments,
        "last_reviewed_at": evaluation.get("updated_at"),
        "stale_after_days": 7,
        "stale_severity": "warning",
        "owner": "agent_host",
        "invalidated_by": None,
        "risk_flags": risk_flags,
    }


def build_current_conclusions_candidate(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    review_proposal_draft: JsonObject,
) -> JsonObject:
    promotion_state = current_conclusions_promotion_state(evaluation, review_proposal_draft, research_program)
    allowed_statuses = list(research_program.get("allowed_conclusion_statuses") or [])
    proposed_status: str | None = None
    if promotion_state in {"candidate_ready", "review_required"}:
        proposed_status = choose_conclusion_status(allowed_statuses, preferred="tentative", fallback="confirmed")
    elif promotion_state == "bounded_only":
        proposed_status = choose_conclusion_status(allowed_statuses, preferred="auxiliary_only", fallback="tentative")

    notes: list[str] = []
    if not research_program.get("available"):
        notes.append("No project-level RESEARCH_PROGRAM.json snapshot was available during intake preparation.")
    if promotion_state == "bounded_only":
        notes.append("Evidence retrieval did not approve a safe formal answer, so this stays as a bounded-only candidate.")
    if bool(research_program.get("publish_only_after_review")):
        notes.append("Research program requires review before publication.")
    if review_proposal_draft:
        notes.append("A review proposal draft exists for this task outcome.")

    excerpt = str(evaluation.get("safe_result_excerpt") or "")
    read_plan_paths = [
        str(item.get("path") or "")
        for item in (evidence_retrieval.get("read_plan") or [])
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ]
    candidate = None
    if excerpt and promotion_state != "not_ready":
        candidate = {
            "topic": safe_excerpt(contract.get("summary") or contract.get("prompt") or contract.get("objective") or "", 160),
            "claim_text": excerpt,
            "proposed_conclusion_status": proposed_status,
            "supporting_read_plan_paths": read_plan_paths,
            "source_task_id": evaluation.get("task_id"),
        }
    return {
        "schema_version": "current_conclusions_candidate.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "research_program_id": str(research_program.get("program_id") or ""),
        "promotion_state": promotion_state,
        "proposed_conclusion_status": proposed_status,
        "requires_human_review": bool(review_proposal_draft.get("requires_human_review")),
        "publish_only_after_review": bool(research_program.get("publish_only_after_review")),
        "review_scope": str(review_proposal_draft.get("review_scope") or "none"),
        "target_path_hint": "project_index/current_conclusions.json",
        "claim_boundary": claim_boundary_for_evaluation(evaluation),
        "candidate": candidate,
        "notes": notes,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def build_current_conclusion_promotion(
    evaluation: JsonObject,
    contract: JsonObject,
    evidence_retrieval: JsonObject,
    research_program: JsonObject,
    review_proposal_draft: JsonObject,
    *,
    generated_supporting_experiments: list[str] | None = None,
) -> JsonObject:
    promotion_state = current_conclusions_promotion_state(evaluation, review_proposal_draft, research_program)
    current_conclusion_update = build_current_conclusion_update(
        evaluation,
        contract,
        evidence_retrieval,
        research_program,
        review_proposal_draft,
        generated_supporting_experiments=generated_supporting_experiments,
    )
    evidence_search = build_current_conclusion_evidence_search(evaluation, evidence_retrieval)
    decision = {
        "not_ready": "none",
        "bounded_only": "bounded_only_do_not_publish",
        "review_required": "prepare_review_bundle",
        "candidate_ready": "candidate_ready_for_apply",
        "human_review_required": "blocked_on_human_review",
    }.get(promotion_state, "none")
    notes: list[str] = []
    if current_conclusion_update is None:
        notes.append("No current conclusion update payload was generated from the current task result.")
    if promotion_state == "bounded_only":
        notes.append("The result remains auxiliary-only because evidence retrieval did not return safe_to_answer.")
    if promotion_state == "review_required":
        notes.append("The result is structurally ready for a conclusion update, but publication still requires review.")
    if promotion_state == "candidate_ready":
        notes.append("The result is structurally ready for a bounded current_conclusions apply step.")
    if promotion_state == "human_review_required":
        notes.append("A human decision is still required before any conclusion promotion.")
    return {
        "schema_version": "current_conclusion_promotion.v0.1",
        "intake_id": evaluation.get("intake_id"),
        "source_task_id": evaluation.get("task_id"),
        "workspace": evaluation.get("workspace"),
        "research_program_id": str(research_program.get("program_id") or ""),
        "promotion_state": promotion_state,
        "current_conclusion_update_status": promotion_state,
        "decision": decision,
        "requires_human_review": bool(
            review_proposal_draft.get("requires_human_review")
            or research_program.get("publish_only_after_review")
            or promotion_state in {"review_required", "human_review_required"}
        ),
        "publish_only_after_review": bool(research_program.get("publish_only_after_review")),
        "target_path_hint": "project_index/current_conclusions.json",
        "review_proposal_path_hint": "research/proposals/current_conclusions/",
        "current_conclusion_query": str(evidence_retrieval.get("query") or ""),
        "current_conclusion_evidence_search": evidence_search,
        "current_conclusion_update": current_conclusion_update,
        "notes": notes,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }
