from __future__ import annotations

import json
from typing import Any

JsonObject = dict[str, Any]


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
