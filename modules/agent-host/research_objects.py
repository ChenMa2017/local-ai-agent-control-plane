from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from experiment_contracts import build_experiment_contract_fields, build_structural_experiment_result
from post_run_artifacts import claim_boundary_for_evaluation
from research_store import write_json_atomic

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


def derive_hypothesis_record_status(
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
) -> str:
    if not bool(experiment_spec.get("required")):
        return "proposed"
    if not evaluation.get("result_available") or str(evaluation.get("task_status") or "") != "done":
        return "testing"
    evaluation_result = (
        str((experiment_result or {}).get("result") or "").strip()
        if isinstance(experiment_result, dict)
        else ""
    )
    evaluation_validity = (
        str((experiment_result or {}).get("validity") or "").strip()
        if isinstance(experiment_result, dict)
        else ""
    )
    if evaluation_validity == "invalid" or evaluation_result == "invalid":
        return "invalid"
    if isinstance(experiment_result, dict) and experiment_result and not bool(experiment_result.get("promotion_eligible")):
        return "testing"
    final_result = (
        str((experiment_result or {}).get("final_result") or "").strip()
        if isinstance(experiment_result, dict)
        else ""
    )
    if final_result in {"supported", "refuted", "inconclusive"}:
        return final_result
    if evaluation_result in {"supported", "refuted", "inconclusive"}:
        return evaluation_result
    return "testing"


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
    success_criteria = experiment_spec.get("success_criteria") if isinstance(experiment_spec.get("success_criteria"), list) else []
    experiment_success_criteria_resolved = True
    if bool(experiment_spec.get("required")):
        experiment_success_criteria_resolved = not any(
            isinstance(item, dict) and str(item.get("status") or "") == "missing"
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
        "runner_metrics_artifact_trusted": (
            bool(((experiment_result or {}).get("runner_metrics_artifact") or {}).get("trusted"))
            if isinstance(experiment_result, dict)
            else False
        ),
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


def evaluation_report_fingerprint(report: JsonObject) -> str:
    stable = {
        "intake_id": report.get("intake_id"),
        "task_id": report.get("task_id"),
        "workspace": report.get("workspace"),
        "objective": report.get("objective"),
        "research_program_id": report.get("research_program_id"),
        "task_status": report.get("task_status"),
        "execution_decision": report.get("execution_decision"),
        "recommended_next_action": report.get("recommended_next_action"),
        "summary": report.get("summary"),
        "claim_boundary": report.get("claim_boundary"),
        "safe_result_excerpt": report.get("safe_result_excerpt"),
        "created_by": report.get("created_by"),
        "assessment_basis": report.get("assessment_basis"),
        "machine_checks": report.get("machine_checks"),
        "validity": report.get("validity"),
        "experiment_result": report.get("experiment_result"),
        "hypothesis_assessment": report.get("hypothesis_assessment"),
        "experiment_assessment": report.get("experiment_assessment"),
        "conclusion_assessment": report.get("conclusion_assessment"),
        "warnings": report.get("warnings"),
        "evidence_retrieval_decision": report.get("evidence_retrieval_decision"),
        "read_plan": report.get("read_plan"),
        "hypothesis_promotion_state": report.get("hypothesis_promotion_state"),
        "experiment_required": report.get("experiment_required"),
        "experiment_promotion_state": report.get("experiment_promotion_state"),
        "review_scope": report.get("review_scope"),
        "requires_human_review": report.get("requires_human_review"),
        "current_conclusions_promotion_state": report.get("current_conclusions_promotion_state"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


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


def normalize_current_conclusions_item(update: JsonObject) -> JsonObject:
    return {
        "topic_id": str(update.get("topic_id") or "").strip(),
        "topic": str(update.get("topic") or "").strip(),
        "conclusion_status": str(update.get("conclusion_status") or "").strip(),
        "claim": str(update.get("claim") or "").strip(),
        "evidence_scope": str(update.get("evidence_scope") or "").strip(),
        "supporting_docs": [str(item) for item in (update.get("supporting_docs") or []) if str(item or "").strip()],
        "supporting_experiments": [
            str(item) for item in (update.get("supporting_experiments") or []) if str(item or "").strip()
        ],
        "last_reviewed_at": update.get("last_reviewed_at"),
        "stale_after_days": update.get("stale_after_days"),
        "stale_severity": update.get("stale_severity"),
        "owner": update.get("owner"),
        "invalidated_by": update.get("invalidated_by"),
        "risk_flags": [str(item) for item in (update.get("risk_flags") or []) if str(item or "").strip()],
    }


def upsert_current_conclusions_document(
    current_conclusions: JsonObject,
    update: JsonObject,
    updated_at: str,
) -> JsonObject:
    items = current_conclusions.get("items") if isinstance(current_conclusions.get("items"), list) else []
    normalized_update = normalize_current_conclusions_item(update)
    topic_id = str(normalized_update.get("topic_id") or "").strip()
    replaced = False
    next_items: list[JsonObject] = []
    for item in items:
        if isinstance(item, dict) and str(item.get("topic_id") or "").strip() == topic_id:
            next_items.append(normalized_update)
            replaced = True
        elif isinstance(item, dict):
            next_items.append(item)
    if not replaced:
        next_items.append(normalized_update)
    return {
        "schema_version": "current_conclusions.v0.1",
        "updated_at": updated_at,
        "items": next_items,
    }


def sync_project_current_conclusion(
    project_root: Path,
    promotion: JsonObject,
) -> JsonObject:
    update = promotion.get("current_conclusion_update") if isinstance(promotion.get("current_conclusion_update"), dict) else {}
    topic_id = str(update.get("topic_id") or "")
    source_task_id = str(promotion.get("source_task_id") or "")
    promotion_state = str(promotion.get("promotion_state") or "")
    updated_at = str(promotion.get("updated_at") or utc_now().isoformat().replace("+00:00", "Z"))
    if not update:
        return {
            "status": "no_update",
            "target_path": None,
            "topic_id": topic_id or None,
        }
    if promotion_state == "candidate_ready":
        current_path = project_root / "project_index" / "current_conclusions.json"
        current = read_json_object_if_exists(current_path)
        updated = upsert_current_conclusions_document(current, update, updated_at)
        if current != updated:
            write_json_atomic(current_path, updated)
        return {
            "status": "applied",
            "target_path": "project_index/current_conclusions.json",
            "topic_id": topic_id or None,
            "source_task_id": source_task_id or None,
        }
    if promotion_state in {"review_required", "human_review_required"}:
        proposal_dir = project_root / "research" / "proposals" / "current_conclusions"
        proposal_name = f"{safe_topic_slug(topic_id or source_task_id, 'current_conclusion')}.json"
        proposal_path = proposal_dir / proposal_name
        proposal_payload = {
            "schema_version": 1,
            "generated_at": updated_at,
            "research_program_id": promotion.get("research_program_id"),
            "publish_only_after_review": bool(promotion.get("publish_only_after_review")),
            "current_conclusion_update": update,
            "current_conclusion_evidence_search": promotion.get("current_conclusion_evidence_search"),
            "source_task_id": source_task_id or None,
            "promotion_state": promotion_state,
        }
        existing = read_json_object_if_exists(proposal_path)
        if existing != proposal_payload:
            write_json_atomic(proposal_path, proposal_payload)
        return {
            "status": "review_bundle_written",
            "target_path": f"research/proposals/current_conclusions/{proposal_name}",
            "topic_id": topic_id or None,
            "source_task_id": source_task_id or None,
        }
    return {
        "status": promotion_state or "not_ready",
        "target_path": None,
        "topic_id": topic_id or None,
        "source_task_id": source_task_id or None,
    }


def read_jsonl_records_if_exists(path: Path) -> list[JsonObject]:
    if not path.exists():
        return []
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    records: list[JsonObject] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            item = json.loads(stripped)
        except json.JSONDecodeError:
            return []
        if isinstance(item, dict):
            records.append(item)
    return records


def write_jsonl_records_atomic(path: Path, records: list[JsonObject]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "\n".join(json.dumps(item, ensure_ascii=False) for item in records)
    path.write_text((text + "\n") if text else "")


def normalize_experiment_index_record(update: JsonObject) -> JsonObject:
    return {
        "experiment_id": str(update.get("experiment_id") or "").strip(),
        "experiment_type": str(update.get("experiment_type") or "").strip(),
        "status": str(update.get("status") or "").strip(),
        "evidence_scope": str(update.get("evidence_scope") or "").strip(),
        "name": str(update.get("name") or "").strip(),
        "purpose": str(update.get("purpose") or "").strip(),
        "model": update.get("model"),
        "baseline_model": update.get("baseline_model"),
        "baseline_spec": update.get("baseline_spec") if isinstance(update.get("baseline_spec"), dict) else {},
        "train_data": update.get("train_data"),
        "test_data": update.get("test_data"),
        "eval_protocol": update.get("eval_protocol"),
        "with_definition": update.get("with_definition"),
        "without_definition": update.get("without_definition"),
        "metric_definitions": list(update.get("metric_definitions") or []),
        "success_criteria": list(update.get("success_criteria") or []),
        "primary_metrics": list(update.get("primary_metrics") or []),
        "primary_metric_name": update.get("primary_metric_name"),
        "assessment_basis": update.get("assessment_basis"),
        "experiment_result": update.get("experiment_result"),
        "experiment_validity": update.get("experiment_validity"),
        "reproducibility": update.get("reproducibility") if isinstance(update.get("reproducibility"), dict) else {},
        "best_epoch": update.get("best_epoch"),
        "primary_eval_path": update.get("primary_eval_path"),
        "config_path": update.get("config_path"),
        "code_commit": update.get("code_commit"),
        "run_id": update.get("run_id"),
        "official_conclusion_doc": update.get("official_conclusion_doc"),
    }


def upsert_experiment_index_records(
    existing_records: list[JsonObject],
    update: JsonObject,
) -> list[JsonObject]:
    normalized_update = normalize_experiment_index_record(update)
    experiment_id = str(normalized_update.get("experiment_id") or "").strip()
    replaced = False
    next_records: list[JsonObject] = []
    for record in existing_records:
        if isinstance(record, dict) and str(record.get("experiment_id") or "").strip() == experiment_id:
            next_records.append(normalized_update)
            replaced = True
        elif isinstance(record, dict):
            next_records.append(record)
    if not replaced:
        next_records.append(normalized_update)
    return next_records


def validate_status_transition(
    *,
    current_status: str | None,
    proposed_status: str,
    allowed_transitions: dict[str, set[str]],
    known_statuses: set[str],
    existing_record_present: bool,
) -> JsonObject:
    normalized_proposed = str(proposed_status or "").strip()
    normalized_current = str(current_status or "").strip() or None
    if not normalized_proposed:
        return {
            "status": "review_required",
            "reason": "missing_proposed_status",
            "current_status": normalized_current,
            "proposed_status": None,
        }
    if normalized_proposed not in known_statuses:
        return {
            "status": "review_required",
            "reason": "unknown_proposed_status",
            "current_status": normalized_current,
            "proposed_status": normalized_proposed,
        }
    transition_key = "__new__"
    if existing_record_present:
        if normalized_current is None:
            return {
                "status": "review_required",
                "reason": "missing_current_status",
                "current_status": None,
                "proposed_status": normalized_proposed,
            }
        if normalized_current not in known_statuses:
            return {
                "status": "review_required",
                "reason": "unknown_current_status",
                "current_status": normalized_current,
                "proposed_status": normalized_proposed,
            }
        transition_key = normalized_current
    allowed_next = allowed_transitions.get(transition_key, set())
    if normalized_proposed not in allowed_next:
        return {
            "status": "review_required",
            "reason": "transition_not_allowed",
            "current_status": normalized_current,
            "proposed_status": normalized_proposed,
            "allowed_next_statuses": sorted(allowed_next),
        }
    return {
        "status": "valid",
        "reason": "ok",
        "current_status": normalized_current,
        "proposed_status": normalized_proposed,
        "allowed_next_statuses": sorted(allowed_next),
    }


def validate_experiment_index_transition(
    existing_record: JsonObject | None,
    update: JsonObject,
) -> JsonObject:
    known_statuses = {"draft", "active", "superseded", "deprecated", "archived", "invalidated"}
    allowed_transitions = {
        "__new__": set(known_statuses),
        "draft": set(known_statuses),
        "active": {"active", "superseded", "deprecated", "archived", "invalidated"},
        "superseded": {"superseded", "archived"},
        "deprecated": {"deprecated", "archived"},
        "invalidated": {"invalidated", "archived"},
        "archived": {"archived"},
    }
    return validate_status_transition(
        current_status=(
            existing_record.get("status")
            if isinstance(existing_record, dict)
            else None
        ),
        proposed_status=str(update.get("status") or ""),
        allowed_transitions=allowed_transitions,
        known_statuses=known_statuses,
        existing_record_present=isinstance(existing_record, dict),
    )


def write_experiment_review_bundle(
    project_root: Path,
    promotion: JsonObject,
    update: JsonObject,
    *,
    updated_at: str,
    promotion_state: str,
    source_task_id: str,
    experiment_id: str,
    transition_validation: JsonObject | None = None,
    existing_record: JsonObject | None = None,
) -> tuple[str, str]:
    proposal_dir = project_root / "research" / "proposals" / "experiments"
    proposal_name = f"{safe_topic_slug(experiment_id or source_task_id, 'experiment')}.json"
    proposal_path = proposal_dir / proposal_name
    proposal_payload = {
        "schema_version": 1,
        "generated_at": updated_at,
        "research_program_id": promotion.get("research_program_id"),
        "publish_only_after_review": bool(promotion.get("publish_only_after_review")),
        "experiment_index_update": update,
        "source_task_id": source_task_id or None,
        "promotion_state": promotion_state,
        "experiment_hypothesis_ids": promotion.get("experiment_hypothesis_ids"),
    }
    if transition_validation is not None:
        proposal_payload["transition_validation"] = transition_validation
    if isinstance(existing_record, dict) and existing_record:
        proposal_payload["existing_record"] = existing_record
    existing = read_json_object_if_exists(proposal_path)
    if existing != proposal_payload:
        write_json_atomic(proposal_path, proposal_payload)
    return proposal_name, f"research/proposals/experiments/{proposal_name}"


def sync_project_experiment_index(
    project_root: Path,
    promotion: JsonObject,
) -> JsonObject:
    update = promotion.get("experiment_index_update") if isinstance(promotion.get("experiment_index_update"), dict) else {}
    experiment_id = str(update.get("experiment_id") or "")
    source_task_id = str(promotion.get("source_task_id") or "")
    promotion_state = str(promotion.get("promotion_state") or "")
    updated_at = str(promotion.get("updated_at") or utc_now().isoformat().replace("+00:00", "Z"))
    if not update:
        return {
            "status": promotion_state or "no_update",
            "target_path": None,
            "experiment_id": experiment_id or None,
            "source_task_id": source_task_id or None,
        }
    if promotion_state == "candidate_ready":
        index_path = project_root / "project_index" / "experiment_index.jsonl"
        existing_records = read_jsonl_records_if_exists(index_path)
        existing_record = next(
            (
                record
                for record in existing_records
                if isinstance(record, dict) and str(record.get("experiment_id") or "").strip() == experiment_id
            ),
            None,
        )
        transition_validation = validate_experiment_index_transition(existing_record, update)
        if transition_validation.get("status") != "valid":
            proposal_name, target_path = write_experiment_review_bundle(
                project_root,
                promotion,
                update,
                updated_at=updated_at,
                promotion_state=promotion_state,
                source_task_id=source_task_id,
                experiment_id=experiment_id,
                transition_validation=transition_validation,
                existing_record=existing_record,
            )
            return {
                "status": "transition_review_required",
                "target_path": target_path,
                "experiment_id": experiment_id or None,
                "source_task_id": source_task_id or None,
                "proposal_name": proposal_name,
                "transition_validation": transition_validation,
            }
        updated_records = upsert_experiment_index_records(existing_records, update)
        if existing_records != updated_records:
            write_jsonl_records_atomic(index_path, updated_records)
        return {
            "status": "applied",
            "target_path": "project_index/experiment_index.jsonl",
            "experiment_id": experiment_id or None,
            "source_task_id": source_task_id or None,
            "transition_validation": transition_validation,
        }
    if promotion_state in {"review_required", "human_review_required"}:
        proposal_name, target_path = write_experiment_review_bundle(
            project_root,
            promotion,
            update,
            updated_at=updated_at,
            promotion_state=promotion_state,
            source_task_id=source_task_id,
            experiment_id=experiment_id,
        )
        return {
            "status": "review_bundle_written",
            "target_path": target_path,
            "experiment_id": experiment_id or None,
            "source_task_id": source_task_id or None,
        }
    return {
        "status": promotion_state or "not_ready",
        "target_path": None,
        "experiment_id": experiment_id or None,
        "source_task_id": source_task_id or None,
    }


def normalize_hypothesis_record(update: JsonObject) -> JsonObject:
    return {
        "schema_version": "hypothesis_record.v0.1",
        "hypothesis_id": str(update.get("hypothesis_id") or "").strip(),
        "revision": update.get("revision"),
        "created_at": update.get("created_at"),
        "updated_at": update.get("updated_at"),
        "created_by": update.get("created_by"),
        "program_id": update.get("program_id"),
        "source": update.get("source") if isinstance(update.get("source"), dict) else {},
        "claim": str(update.get("claim") or "").strip(),
        "mechanism": str(update.get("mechanism") or "").strip(),
        "prediction": list(update.get("prediction") or []),
        "falsification_criteria": list(update.get("falsification_criteria") or []),
        "required_experiments": list(update.get("required_experiments") or []),
        "scope": update.get("scope") if isinstance(update.get("scope"), dict) else {},
        "supporting_evidence": list(update.get("supporting_evidence") or []),
        "contradicting_evidence": list(update.get("contradicting_evidence") or []),
        "confidence": update.get("confidence") if isinstance(update.get("confidence"), dict) else {},
        "evaluation_result": update.get("evaluation_result"),
        "evaluation_validity": update.get("evaluation_validity"),
        "assessment_basis": update.get("assessment_basis"),
        "status": str(update.get("status") or "").strip(),
        "supersedes": list(update.get("supersedes") or []),
        "superseded_by": update.get("superseded_by"),
        "archival_reason": update.get("archival_reason"),
    }


def upsert_hypothesis_registry_records(
    existing_records: list[JsonObject],
    update: JsonObject,
    updated_at: str,
) -> list[JsonObject]:
    normalized_update = normalize_hypothesis_record(update)
    hypothesis_id = str(normalized_update.get("hypothesis_id") or "").strip()
    existing_record: JsonObject | None = None
    next_records: list[JsonObject] = []
    for record in existing_records:
        if isinstance(record, dict) and str(record.get("hypothesis_id") or "").strip() == hypothesis_id:
            existing_record = record
            continue
        if isinstance(record, dict):
            next_records.append(record)
    normalized_update["created_at"] = (
        existing_record.get("created_at")
        if isinstance(existing_record, dict) and existing_record.get("created_at")
        else updated_at
    )
    previous_revision = existing_record.get("revision") if isinstance(existing_record, dict) else None
    normalized_update["revision"] = previous_revision + 1 if isinstance(previous_revision, int) else 1
    normalized_update["updated_at"] = updated_at
    next_records.append(normalized_update)
    return next_records


def validate_hypothesis_registry_transition(
    existing_record: JsonObject | None,
    update: JsonObject,
) -> JsonObject:
    known_statuses = {
        "proposed",
        "testing",
        "active",
        "supported",
        "refuted",
        "inconclusive",
        "invalid",
        "superseded",
        "archived",
    }
    allowed_transitions = {
        "__new__": set(known_statuses),
        "proposed": {"proposed", "testing", "active", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
        "testing": {"testing", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
        # Keep `active` as a legacy-compatible state for older project registries.
        "active": {"active", "testing", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
        "supported": {"supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
        "refuted": {"refuted", "supported", "inconclusive", "invalid", "superseded", "archived"},
        "inconclusive": {"testing", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
        "invalid": {"testing", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
        "superseded": {"superseded", "archived"},
        "archived": {"archived"},
    }
    return validate_status_transition(
        current_status=(
            existing_record.get("status")
            if isinstance(existing_record, dict)
            else None
        ),
        proposed_status=str(update.get("status") or ""),
        allowed_transitions=allowed_transitions,
        known_statuses=known_statuses,
        existing_record_present=isinstance(existing_record, dict),
    )


def write_hypothesis_review_bundle(
    project_root: Path,
    promotion: JsonObject,
    update: JsonObject,
    *,
    updated_at: str,
    promotion_state: str,
    source_task_id: str,
    hypothesis_id: str,
    transition_validation: JsonObject | None = None,
    existing_record: JsonObject | None = None,
) -> tuple[str, str]:
    proposal_dir = project_root / "research" / "proposals" / "hypotheses"
    proposal_name = f"{safe_topic_slug(hypothesis_id or source_task_id, 'hypothesis')}.json"
    proposal_path = proposal_dir / proposal_name
    proposal_payload = {
        "schema_version": 1,
        "generated_at": updated_at,
        "research_program_id": promotion.get("research_program_id"),
        "hypothesis_update": update,
        "source_task_id": source_task_id or None,
        "promotion_state": promotion_state,
    }
    if transition_validation is not None:
        proposal_payload["transition_validation"] = transition_validation
    if isinstance(existing_record, dict) and existing_record:
        proposal_payload["existing_record"] = existing_record
    existing = read_json_object_if_exists(proposal_path)
    if existing != proposal_payload:
        write_json_atomic(proposal_path, proposal_payload)
    return proposal_name, f"research/proposals/hypotheses/{proposal_name}"


def sync_project_hypothesis_registry(
    project_root: Path,
    promotion: JsonObject,
) -> JsonObject:
    update = promotion.get("hypothesis_update") if isinstance(promotion.get("hypothesis_update"), dict) else {}
    hypothesis_id = str(update.get("hypothesis_id") or "")
    source_task_id = str(promotion.get("source_task_id") or "")
    promotion_state = str(promotion.get("promotion_state") or "")
    updated_at = str(promotion.get("updated_at") or utc_now().isoformat().replace("+00:00", "Z"))
    if not update:
        return {
            "status": promotion_state or "no_update",
            "target_path": None,
            "hypothesis_id": hypothesis_id or None,
            "source_task_id": source_task_id or None,
        }
    if promotion_state == "candidate_ready":
        registry_path = project_root / "research" / "HYPOTHESIS_REGISTRY.jsonl"
        existing_records = read_jsonl_records_if_exists(registry_path)
        existing_record = next(
            (
                record
                for record in existing_records
                if isinstance(record, dict) and str(record.get("hypothesis_id") or "").strip() == hypothesis_id
            ),
            None,
        )
        transition_validation = validate_hypothesis_registry_transition(existing_record, update)
        if transition_validation.get("status") != "valid":
            proposal_name, target_path = write_hypothesis_review_bundle(
                project_root,
                promotion,
                update,
                updated_at=updated_at,
                promotion_state=promotion_state,
                source_task_id=source_task_id,
                hypothesis_id=hypothesis_id,
                transition_validation=transition_validation,
                existing_record=existing_record,
            )
            return {
                "status": "transition_review_required",
                "target_path": target_path,
                "hypothesis_id": hypothesis_id or None,
                "source_task_id": source_task_id or None,
                "proposal_name": proposal_name,
                "transition_validation": transition_validation,
            }
        updated_records = upsert_hypothesis_registry_records(existing_records, update, updated_at)
        if existing_records != updated_records:
            write_jsonl_records_atomic(registry_path, updated_records)
        return {
            "status": "applied",
            "target_path": "research/HYPOTHESIS_REGISTRY.jsonl",
            "hypothesis_id": hypothesis_id or None,
            "source_task_id": source_task_id or None,
            "transition_validation": transition_validation,
        }
    if promotion_state in {"review_required", "human_review_required"}:
        proposal_name, target_path = write_hypothesis_review_bundle(
            project_root,
            promotion,
            update,
            updated_at=updated_at,
            promotion_state=promotion_state,
            source_task_id=source_task_id,
            hypothesis_id=hypothesis_id,
        )
        return {
            "status": "review_bundle_written",
            "target_path": target_path,
            "hypothesis_id": hypothesis_id or None,
            "source_task_id": source_task_id or None,
        }
    return {
        "status": promotion_state or "not_ready",
        "target_path": None,
        "hypothesis_id": hypothesis_id or None,
        "source_task_id": source_task_id or None,
    }


def current_conclusions_fingerprint(current_conclusions: JsonObject) -> str:
    stable = {
        "intake_id": current_conclusions.get("intake_id"),
        "source_task_id": current_conclusions.get("source_task_id"),
        "workspace": current_conclusions.get("workspace"),
        "research_program_id": current_conclusions.get("research_program_id"),
        "promotion_state": current_conclusions.get("promotion_state"),
        "proposed_conclusion_status": current_conclusions.get("proposed_conclusion_status"),
        "requires_human_review": current_conclusions.get("requires_human_review"),
        "publish_only_after_review": current_conclusions.get("publish_only_after_review"),
        "review_scope": current_conclusions.get("review_scope"),
        "target_path_hint": current_conclusions.get("target_path_hint"),
        "claim_boundary": current_conclusions.get("claim_boundary"),
        "candidate": current_conclusions.get("candidate"),
        "notes": current_conclusions.get("notes"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def current_conclusion_update_fingerprint(update: JsonObject) -> str:
    stable = {
        "source_task_id": update.get("source_task_id"),
        "topic_id": update.get("topic_id"),
        "topic": update.get("topic"),
        "conclusion_status": update.get("conclusion_status"),
        "claim": update.get("claim"),
        "evidence_scope": update.get("evidence_scope"),
        "supporting_docs": update.get("supporting_docs"),
        "supporting_experiments": update.get("supporting_experiments"),
        "risk_flags": update.get("risk_flags"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def current_conclusion_promotion_fingerprint(promotion: JsonObject) -> str:
    stable = {
        "intake_id": promotion.get("intake_id"),
        "source_task_id": promotion.get("source_task_id"),
        "workspace": promotion.get("workspace"),
        "research_program_id": promotion.get("research_program_id"),
        "promotion_state": promotion.get("promotion_state"),
        "current_conclusion_update_status": promotion.get("current_conclusion_update_status"),
        "decision": promotion.get("decision"),
        "requires_human_review": promotion.get("requires_human_review"),
        "publish_only_after_review": promotion.get("publish_only_after_review"),
        "target_path_hint": promotion.get("target_path_hint"),
        "review_proposal_path_hint": promotion.get("review_proposal_path_hint"),
        "current_conclusion_query": promotion.get("current_conclusion_query"),
        "current_conclusion_evidence_search": promotion.get("current_conclusion_evidence_search"),
        "current_conclusion_update": promotion.get("current_conclusion_update"),
        "project_sync": promotion.get("project_sync"),
        "notes": promotion.get("notes"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def hypothesis_update_fingerprint(update: JsonObject) -> str:
    stable = {
        "intake_id": update.get("intake_id"),
        "source_task_id": update.get("source_task_id"),
        "workspace": update.get("workspace"),
        "program_id": update.get("program_id"),
        "hypothesis_id": update.get("hypothesis_id"),
        "claim": update.get("claim"),
        "mechanism": update.get("mechanism"),
        "prediction": update.get("prediction"),
        "falsification_criteria": update.get("falsification_criteria"),
        "required_experiments": update.get("required_experiments"),
        "supporting_evidence": update.get("supporting_evidence"),
        "contradicting_evidence": update.get("contradicting_evidence"),
        "confidence": update.get("confidence"),
        "evaluation_result": update.get("evaluation_result"),
        "evaluation_validity": update.get("evaluation_validity"),
        "assessment_basis": update.get("assessment_basis"),
        "status": update.get("status"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def experiment_result_fingerprint(result: JsonObject) -> str:
    stable = {
        "intake_id": result.get("intake_id"),
        "source_task_id": result.get("source_task_id"),
        "workspace": result.get("workspace"),
        "experiment_id": result.get("experiment_id"),
        "hypothesis_ids": result.get("hypothesis_ids"),
        "assessment_basis": result.get("assessment_basis"),
        "validity": result.get("validity"),
        "provisional_result": result.get("provisional_result"),
        "result": result.get("result"),
        "final_result": result.get("final_result"),
        "adjudication_status": result.get("adjudication_status"),
        "promotion_eligible": result.get("promotion_eligible"),
        "evidence_strength": result.get("evidence_strength"),
        "metrics": result.get("metrics"),
        "baseline_comparison": result.get("baseline_comparison"),
        "success_criteria": result.get("success_criteria"),
        "limitations": result.get("limitations"),
        "runner_metrics_artifact": result.get("runner_metrics_artifact"),
        "reproducibility": result.get("reproducibility"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def hypothesis_promotion_fingerprint(promotion: JsonObject) -> str:
    stable = {
        "intake_id": promotion.get("intake_id"),
        "source_task_id": promotion.get("source_task_id"),
        "workspace": promotion.get("workspace"),
        "research_program_id": promotion.get("research_program_id"),
        "promotion_state": promotion.get("promotion_state"),
        "hypothesis_update_status": promotion.get("hypothesis_update_status"),
        "decision": promotion.get("decision"),
        "requires_human_review": promotion.get("requires_human_review"),
        "target_path_hint": promotion.get("target_path_hint"),
        "review_proposal_path_hint": promotion.get("review_proposal_path_hint"),
        "hypothesis_update": promotion.get("hypothesis_update"),
        "project_sync": promotion.get("project_sync"),
        "notes": promotion.get("notes"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def experiment_index_update_fingerprint(update: JsonObject) -> str:
    stable = {
        "intake_id": update.get("intake_id"),
        "source_task_id": update.get("source_task_id"),
        "workspace": update.get("workspace"),
        "research_program_id": update.get("research_program_id"),
        "hypothesis_ids": update.get("hypothesis_ids"),
        "experiment_id": update.get("experiment_id"),
        "experiment_type": update.get("experiment_type"),
        "status": update.get("status"),
        "evidence_scope": update.get("evidence_scope"),
        "name": update.get("name"),
        "purpose": update.get("purpose"),
        "baseline_model": update.get("baseline_model"),
        "baseline_spec": update.get("baseline_spec"),
        "eval_protocol": update.get("eval_protocol"),
        "with_definition": update.get("with_definition"),
        "without_definition": update.get("without_definition"),
        "metric_definitions": update.get("metric_definitions"),
        "success_criteria": update.get("success_criteria"),
        "primary_metrics": update.get("primary_metrics"),
        "primary_metric_name": update.get("primary_metric_name"),
        "assessment_basis": update.get("assessment_basis"),
        "experiment_result": update.get("experiment_result"),
        "experiment_validity": update.get("experiment_validity"),
        "reproducibility": update.get("reproducibility"),
        "run_id": update.get("run_id"),
        "official_conclusion_doc": update.get("official_conclusion_doc"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)


def experiment_promotion_fingerprint(promotion: JsonObject) -> str:
    stable = {
        "intake_id": promotion.get("intake_id"),
        "source_task_id": promotion.get("source_task_id"),
        "workspace": promotion.get("workspace"),
        "research_program_id": promotion.get("research_program_id"),
        "experiment_required": promotion.get("experiment_required"),
        "experiment_hypothesis_ids": promotion.get("experiment_hypothesis_ids"),
        "promotion_state": promotion.get("promotion_state"),
        "experiment_index_update_status": promotion.get("experiment_index_update_status"),
        "decision": promotion.get("decision"),
        "requires_human_review": promotion.get("requires_human_review"),
        "publish_only_after_review": promotion.get("publish_only_after_review"),
        "target_path_hint": promotion.get("target_path_hint"),
        "review_proposal_path_hint": promotion.get("review_proposal_path_hint"),
        "experiment_index_update": promotion.get("experiment_index_update"),
        "project_sync": promotion.get("project_sync"),
        "notes": promotion.get("notes"),
    }
    return json.dumps(stable, ensure_ascii=False, sort_keys=True)
