from __future__ import annotations

import datetime as dt
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .experiment_contracts import validate_runner_metrics_payload
from ..reporting.post_run_artifacts import (
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
from ..reporting.operator_summary import (
    build_post_run_operator_summary,
    operator_summary_fingerprint,
    operator_summary_markdown,
)
from .research_objects import (
    build_experiment_index_update,
    build_experiment_promotion,
    build_experiment_result,
    build_hypothesis_promotion,
    build_hypothesis_update,
    build_current_conclusion_promotion,
    build_current_conclusion_update,
    build_current_conclusions_candidate,
    build_evaluation_report,
    experiment_result_fingerprint,
    experiment_index_update_fingerprint,
    experiment_promotion_fingerprint,
    hypothesis_promotion_fingerprint,
    hypothesis_update_fingerprint,
    current_conclusion_promotion_fingerprint,
    current_conclusion_update_fingerprint,
    current_conclusions_fingerprint,
    evaluation_report_fingerprint,
    sync_project_experiment_index,
    sync_project_hypothesis_registry,
    sync_project_current_conclusion,
)

JsonObject = dict[str, Any]
MAX_RUNNER_METRICS_BYTES = 256 * 1024
ALLOWED_RUNNER_METRICS_PRODUCERS = {("experiment_runner", "local-runner")}


@dataclass(frozen=True)
class ExecutionEvaluationDependencies:
    utc_now: Callable[[], dt.datetime]
    intake_dir: Callable[[Any, str], Path]
    read_json_object_if_exists: Callable[[Path], JsonObject]
    write_json_atomic: Callable[[Path, JsonObject], None]
    write_text_atomic: Callable[[Path, str], None]
    append_jsonl: Callable[[Path, JsonObject], None]
    task_intake_id: Callable[[JsonObject], str]


def _normalized_runner_metrics_producer(payload: JsonObject) -> tuple[str, str]:
    producer = payload.get("producer") if isinstance(payload.get("producer"), dict) else {}
    return (
        str(producer.get("kind") or "").strip().lower(),
        str(producer.get("id") or "").strip().lower(),
    )


def _runner_metrics_replay_rejection_reason(
    prior_experiment_result: JsonObject,
    *,
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    status: JsonObject,
) -> str | None:
    if not isinstance(prior_experiment_result, dict) or not prior_experiment_result:
        return None
    current_hash = str(status.get("sha256") or "").strip()
    if not current_hash:
        return None
    prior_artifact = (
        prior_experiment_result.get("runner_metrics_artifact")
        if isinstance(prior_experiment_result.get("runner_metrics_artifact"), dict)
        else {}
    )
    prior_hash = str(prior_artifact.get("sha256") or "").strip()
    if not prior_hash:
        return None
    prior_task_id = str(prior_experiment_result.get("source_task_id") or "").strip()
    current_task_id = str(evaluation.get("task_id") or "").strip()
    prior_experiment_id = str(prior_experiment_result.get("experiment_id") or "").strip()
    current_experiment_id = str(experiment_spec.get("experiment_id") or "").strip()
    same_experiment = (
        not prior_experiment_id
        or not current_experiment_id
        or prior_experiment_id == current_experiment_id
    )
    if prior_hash == current_hash and prior_task_id and current_task_id and prior_task_id != current_task_id and same_experiment:
        return f"artifact sha256 already consumed by task {prior_task_id}"
    if prior_task_id and current_task_id and prior_task_id == current_task_id and prior_hash != current_hash and same_experiment:
        return "artifact sha256 changed after prior evaluation for the same task"
    return None


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
        "research_program": deps.read_json_object_if_exists(root / "RESEARCH_PROGRAM.json"),
        "hypothesis_registry": deps.read_json_object_if_exists(root / "HYPOTHESIS_REGISTRY.json"),
        "experiment_spec": deps.read_json_object_if_exists(root / "EXPERIMENT_SPEC.json"),
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
        "task_created_at": str(task.get("created_at") or ""),
        "task_started_at": str(task.get("started_at") or ""),
        "task_updated_at": str(task.get("updated_at") or ""),
        "task_ended_at": str(task.get("ended_at") or ""),
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
    provenance = draft.get("provenance") if isinstance(draft.get("provenance"), dict) else {}
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
            "artifact_provenance_source": provenance.get("source"),
            "artifact_repair_origin": provenance.get("repair_origin"),
            "artifact_generated_by": provenance.get("generated_by"),
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
    provenance = draft.get("provenance") if isinstance(draft.get("provenance"), dict) else {}
    deps.write_json_atomic(root / "LEDGER_NOTE_DRAFT.json", draft)
    deps.write_text_atomic(root / "LEDGER_NOTE_DRAFT.md", ledger_note_draft_markdown(draft))
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "ledger_note_drafted",
            "intake_id": intake_id,
            "source_task_id": evaluation.get("task_id"),
            "recommended_next_action": draft.get("recommended_next_action"),
            "artifact_provenance_source": provenance.get("source"),
            "artifact_repair_origin": provenance.get("repair_origin"),
            "artifact_generated_by": provenance.get("generated_by"),
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
    provenance = draft.get("provenance") if isinstance(draft.get("provenance"), dict) else {}
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
            "artifact_provenance_source": provenance.get("source"),
            "artifact_repair_origin": provenance.get("repair_origin"),
            "artifact_generated_by": provenance.get("generated_by"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return draft


def persist_experiment_result(
    config: Any,
    experiment_result: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(experiment_result, dict) or not experiment_result:
        return None
    intake_id = str(experiment_result.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "EXPERIMENT_RESULT.json")
    if existing and experiment_result_fingerprint(existing) == experiment_result_fingerprint(experiment_result):
        return existing
    deps.write_json_atomic(root / "EXPERIMENT_RESULT.json", experiment_result)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "experiment_result_evaluated",
            "intake_id": intake_id,
            "source_task_id": experiment_result.get("source_task_id"),
            "experiment_id": experiment_result.get("experiment_id"),
            "validity": experiment_result.get("validity"),
            "result": experiment_result.get("result"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return experiment_result


def load_runner_metrics_artifact(
    task_dir: Path,
    *,
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    prior_experiment_result: JsonObject | None = None,
) -> tuple[JsonObject, JsonObject]:
    artifact_path = task_dir / "RUNNER_METRICS.json"
    status: JsonObject = {
        "present": False,
        "validated": False,
        "producer_allowed": False,
        "trusted": False,
        "sha256": None,
        "replay_detected": False,
        "prior_consumed_by_task_id": None,
        "rejection_reason": None,
    }
    if not artifact_path.exists():
        return {}, status
    status["present"] = True
    try:
        if artifact_path.is_symlink():
            status["rejection_reason"] = "symlinks are not allowed"
            return {}, status
        if not artifact_path.is_file():
            status["rejection_reason"] = "artifact is not a regular file"
            return {}, status
        if artifact_path.stat().st_size > MAX_RUNNER_METRICS_BYTES:
            status["rejection_reason"] = f"artifact exceeds {MAX_RUNNER_METRICS_BYTES} bytes"
            return {}, status
    except OSError as exc:
        status["rejection_reason"] = f"artifact metadata unreadable: {exc}"
        return {}, status
    try:
        raw_payload = artifact_path.read_bytes()
        status["sha256"] = "sha256:" + hashlib.sha256(raw_payload).hexdigest()
        payload = json.loads(raw_payload.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        status["rejection_reason"] = f"invalid JSON: {exc}"
        return {}, status
    if not isinstance(payload, dict):
        status["rejection_reason"] = "payload is not a JSON object"
        return {}, status
    validated_payload, rejection_reason = validate_runner_metrics_payload(
        payload,
        evaluation=evaluation,
        experiment_spec=experiment_spec,
    )
    if rejection_reason:
        status["rejection_reason"] = rejection_reason
        return {}, status
    status["validated"] = True
    producer_key = _normalized_runner_metrics_producer(validated_payload)
    status["producer_allowed"] = producer_key in ALLOWED_RUNNER_METRICS_PRODUCERS
    if not status["producer_allowed"]:
        producer_kind, producer_id = producer_key
        status["rejection_reason"] = (
            f"producer {producer_kind or '<unknown>'}:{producer_id or '<unknown>'} is not in the allowlist"
        )
        return validated_payload, status
    replay_rejection_reason = _runner_metrics_replay_rejection_reason(
        prior_experiment_result if isinstance(prior_experiment_result, dict) else {},
        evaluation=evaluation,
        experiment_spec=experiment_spec,
        status=status,
    )
    if replay_rejection_reason:
        status["replay_detected"] = True
        prior_task_id = (
            str(prior_experiment_result.get("source_task_id") or "").strip()
            if isinstance(prior_experiment_result, dict)
            else ""
        )
        status["prior_consumed_by_task_id"] = prior_task_id or None
        status["rejection_reason"] = replay_rejection_reason
        return validated_payload, status
    status["trusted"] = True
    return validated_payload, status


def persist_hypothesis_update(
    config: Any,
    hypothesis_update: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(hypothesis_update, dict) or not hypothesis_update:
        return None
    intake_id = str(hypothesis_update.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "HYPOTHESIS_UPDATE.json")
    if existing and hypothesis_update_fingerprint(existing) == hypothesis_update_fingerprint(hypothesis_update):
        return existing
    deps.write_json_atomic(root / "HYPOTHESIS_UPDATE.json", hypothesis_update)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "hypothesis_update_drafted",
            "intake_id": intake_id,
            "source_task_id": hypothesis_update.get("source_task_id"),
            "hypothesis_id": hypothesis_update.get("hypothesis_id"),
            "status": hypothesis_update.get("status"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return hypothesis_update


def persist_hypothesis_promotion(
    config: Any,
    promotion: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(promotion, dict) or not promotion:
        return None
    intake_id = str(promotion.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "HYPOTHESIS_PROMOTION.json")
    if existing and hypothesis_promotion_fingerprint(existing) == hypothesis_promotion_fingerprint(promotion):
        return existing
    deps.write_json_atomic(root / "HYPOTHESIS_PROMOTION.json", promotion)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "hypothesis_promotion_updated",
            "intake_id": intake_id,
            "source_task_id": promotion.get("source_task_id"),
            "promotion_state": promotion.get("promotion_state"),
            "decision": promotion.get("decision"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return promotion


def persist_experiment_index_update(
    config: Any,
    experiment_index_update: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(experiment_index_update, dict) or not experiment_index_update:
        return None
    intake_id = str(experiment_index_update.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "EXPERIMENT_INDEX_UPDATE.json")
    if existing and experiment_index_update_fingerprint(existing) == experiment_index_update_fingerprint(experiment_index_update):
        return existing
    deps.write_json_atomic(root / "EXPERIMENT_INDEX_UPDATE.json", experiment_index_update)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "experiment_index_update_drafted",
            "intake_id": intake_id,
            "source_task_id": experiment_index_update.get("source_task_id"),
            "experiment_id": experiment_index_update.get("experiment_id"),
            "status": experiment_index_update.get("status"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return experiment_index_update


def persist_experiment_promotion(
    config: Any,
    promotion: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(promotion, dict) or not promotion:
        return None
    intake_id = str(promotion.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "EXPERIMENT_PROMOTION.json")
    if existing and experiment_promotion_fingerprint(existing) == experiment_promotion_fingerprint(promotion):
        return existing
    deps.write_json_atomic(root / "EXPERIMENT_PROMOTION.json", promotion)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "experiment_promotion_updated",
            "intake_id": intake_id,
            "source_task_id": promotion.get("source_task_id"),
            "promotion_state": promotion.get("promotion_state"),
            "decision": promotion.get("decision"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return promotion


def persist_evaluation_report(
    config: Any,
    report: dict[str, Any],
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    intake_id = str(report.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "EVALUATION_REPORT.json")
    if existing and evaluation_report_fingerprint(existing) == evaluation_report_fingerprint(report):
        return existing
    deps.write_json_atomic(root / "EVALUATION_REPORT.json", report)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "evaluation_report_persisted",
            "intake_id": intake_id,
            "task_id": report.get("task_id"),
            "promotion_state": report.get("current_conclusions_promotion_state"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return report


def persist_current_conclusions(
    config: Any,
    current_conclusions: dict[str, Any],
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    intake_id = str(current_conclusions.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "CURRENT_CONCLUSIONS.json")
    if existing and current_conclusions_fingerprint(existing) == current_conclusions_fingerprint(current_conclusions):
        return existing
    deps.write_json_atomic(root / "CURRENT_CONCLUSIONS.json", current_conclusions)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "current_conclusions_updated",
            "intake_id": intake_id,
            "source_task_id": current_conclusions.get("source_task_id"),
            "promotion_state": current_conclusions.get("promotion_state"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return current_conclusions


def persist_current_conclusion_update(
    config: Any,
    current_conclusion_update: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(current_conclusion_update, dict) or not current_conclusion_update:
        return None
    intake_id = str(current_conclusion_update.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "CURRENT_CONCLUSION_UPDATE.json")
    if existing and current_conclusion_update_fingerprint(existing) == current_conclusion_update_fingerprint(current_conclusion_update):
        return existing
    deps.write_json_atomic(root / "CURRENT_CONCLUSION_UPDATE.json", current_conclusion_update)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "current_conclusion_update_drafted",
            "intake_id": intake_id,
            "source_task_id": current_conclusion_update.get("source_task_id"),
            "topic_id": current_conclusion_update.get("topic_id"),
            "conclusion_status": current_conclusion_update.get("conclusion_status"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return current_conclusion_update


def persist_current_conclusion_promotion(
    config: Any,
    promotion: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(promotion, dict) or not promotion:
        return None
    intake_id = str(promotion.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "CURRENT_CONCLUSION_PROMOTION.json")
    if existing and current_conclusion_promotion_fingerprint(existing) == current_conclusion_promotion_fingerprint(promotion):
        return existing
    deps.write_json_atomic(root / "CURRENT_CONCLUSION_PROMOTION.json", promotion)
    deps.append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": "current_conclusion_promotion_updated",
            "intake_id": intake_id,
            "source_task_id": promotion.get("source_task_id"),
            "promotion_state": promotion.get("promotion_state"),
            "decision": promotion.get("decision"),
            "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
        },
    )
    return promotion


def persist_operator_summary(
    config: Any,
    summary: dict[str, Any] | None,
    deps: ExecutionEvaluationDependencies,
) -> dict[str, Any] | None:
    if not isinstance(summary, dict) or not summary:
        return None
    intake_id = str(summary.get("intake_id") or "")
    if not intake_id:
        return None
    root = deps.intake_dir(config, intake_id)
    existing = deps.read_json_object_if_exists(root / "OPERATOR_SUMMARY.json")
    if existing and operator_summary_fingerprint(existing) == operator_summary_fingerprint(summary):
        return existing
    deps.write_json_atomic(root / "OPERATOR_SUMMARY.json", summary)
    deps.write_text_atomic(root / "OPERATOR_SUMMARY.md", operator_summary_markdown(summary))
    return summary


def workspace_project_root(config: Any, workspace: str) -> Path | None:
    projects = getattr(config, "projects", None)
    if not isinstance(projects, dict):
        return None
    project = projects.get(workspace)
    root = getattr(project, "root", None)
    return Path(root) if root else None


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
    contract = prepare_bundle.get("contract") if isinstance(prepare_bundle.get("contract"), dict) else {}
    evidence = prepare_bundle.get("evidence_retrieval") if isinstance(prepare_bundle.get("evidence_retrieval"), dict) else {}
    research_program = prepare_bundle.get("research_program") if isinstance(prepare_bundle.get("research_program"), dict) else {}
    hypothesis_registry = prepare_bundle.get("hypothesis_registry") if isinstance(prepare_bundle.get("hypothesis_registry"), dict) else {}
    experiment_spec = prepare_bundle.get("experiment_spec") if isinstance(prepare_bundle.get("experiment_spec"), dict) else {}
    prior_experiment_result = deps.read_json_object_if_exists(
        deps.intake_dir(config, intake_id) / "EXPERIMENT_RESULT.json"
    )
    runner_metrics, runner_metrics_status = load_runner_metrics_artifact(
        task_dir,
        evaluation=evaluation,
        experiment_spec=experiment_spec,
        prior_experiment_result=prior_experiment_result,
    )
    if runner_metrics_status.get("rejection_reason"):
        evaluation["warnings"] = list(evaluation.get("warnings") or []) + [
            f"Runner metrics artifact rejected: {runner_metrics_status.get('rejection_reason')}"
        ]
    evaluation = persist_execution_evaluation(config, evaluation, deps)
    followup_task_draft = persist_followup_task_draft(config, evaluation, contract, evidence, deps)
    ledger_note_draft = persist_ledger_note_draft(config, evaluation, contract, evidence, deps)
    review_proposal_draft = persist_review_proposal_draft(config, evaluation, contract, evidence, deps)
    experiment_result = persist_experiment_result(
        config,
        build_experiment_result(
            evaluation,
            experiment_spec,
            review_proposal_draft or {},
            research_program,
            runner_metrics=runner_metrics,
            runner_metrics_status=runner_metrics_status,
        ),
        deps,
    )
    experiment_index_update = persist_experiment_index_update(
        config,
        build_experiment_index_update(
            evaluation,
            contract,
            evidence,
            research_program,
            hypothesis_registry,
            experiment_spec,
            experiment_result,
            review_proposal_draft or {},
        ),
        deps,
    )
    project_root = workspace_project_root(config, str(evaluation.get("workspace") or ""))
    experiment_promotion_payload = build_experiment_promotion(
        evaluation,
        contract,
        evidence,
        research_program,
        hypothesis_registry,
        experiment_spec,
        experiment_result,
        review_proposal_draft or {},
    )
    if experiment_index_update:
        experiment_promotion_payload["experiment_index_update"] = experiment_index_update
        if experiment_index_update.get("updated_at"):
            experiment_promotion_payload["updated_at"] = experiment_index_update.get("updated_at")
    experiment_project_sync = (
        sync_project_experiment_index(project_root, experiment_promotion_payload)
        if project_root is not None
        else {
            "status": "workspace_unavailable",
            "target_path": None,
            "experiment_id": (
                experiment_index_update.get("experiment_id")
                if isinstance(experiment_index_update, dict)
                else None
            ),
            "source_task_id": evaluation.get("task_id"),
        }
    )
    experiment_promotion_payload["project_sync"] = experiment_project_sync
    experiment_promotion = persist_experiment_promotion(
        config,
        experiment_promotion_payload,
        deps,
    )
    generated_experiment_ids = (
        [str(experiment_index_update.get("experiment_id") or "")]
        if isinstance(experiment_index_update, dict) and str(experiment_index_update.get("experiment_id") or "").strip()
        else []
    )
    hypothesis_update = persist_hypothesis_update(
        config,
        build_hypothesis_update(
            evaluation,
            contract,
            evidence,
            research_program,
            hypothesis_registry,
            experiment_spec,
            review_proposal_draft or {},
            experiment_result=experiment_result,
            generated_supporting_experiments=generated_experiment_ids,
        ),
        deps,
    )
    hypothesis_promotion_payload = build_hypothesis_promotion(
        evaluation,
        contract,
        evidence,
        research_program,
        hypothesis_registry,
        experiment_spec,
        review_proposal_draft or {},
        experiment_result=experiment_result,
        generated_supporting_experiments=generated_experiment_ids,
    )
    if hypothesis_update:
        hypothesis_promotion_payload["hypothesis_update"] = hypothesis_update
        if hypothesis_update.get("updated_at"):
            hypothesis_promotion_payload["updated_at"] = hypothesis_update.get("updated_at")
    hypothesis_project_sync = (
        sync_project_hypothesis_registry(project_root, hypothesis_promotion_payload)
        if project_root is not None
        else {
            "status": "workspace_unavailable",
            "target_path": None,
            "hypothesis_id": (
                hypothesis_update.get("hypothesis_id")
                if isinstance(hypothesis_update, dict)
                else None
            ),
            "source_task_id": evaluation.get("task_id"),
        }
    )
    hypothesis_promotion_payload["project_sync"] = hypothesis_project_sync
    hypothesis_promotion = persist_hypothesis_promotion(
        config,
        hypothesis_promotion_payload,
        deps,
    )
    current_conclusion_update = persist_current_conclusion_update(
        config,
        build_current_conclusion_update(
            evaluation,
            contract,
            evidence,
            research_program,
            review_proposal_draft or {},
            generated_supporting_experiments=generated_experiment_ids,
        ),
        deps,
    )
    evaluation_report = persist_evaluation_report(
        config,
        build_evaluation_report(
            evaluation,
            contract,
            evidence,
            research_program,
            hypothesis_registry,
            experiment_spec,
            experiment_result,
            review_proposal_draft or {},
            hypothesis_promotion=hypothesis_promotion,
            experiment_promotion=experiment_promotion,
        ),
        deps,
    )
    current_conclusions = persist_current_conclusions(
        config,
        build_current_conclusions_candidate(
            evaluation,
            contract,
            evidence,
            research_program,
            review_proposal_draft or {},
        ),
        deps,
    )
    current_conclusion_promotion_payload = build_current_conclusion_promotion(
        evaluation,
        contract,
        evidence,
        research_program,
        review_proposal_draft or {},
        generated_supporting_experiments=generated_experiment_ids,
    )
    if current_conclusion_update:
        current_conclusion_promotion_payload["current_conclusion_update"] = current_conclusion_update
        if current_conclusion_update.get("last_reviewed_at"):
            current_conclusion_promotion_payload["updated_at"] = current_conclusion_update.get("last_reviewed_at")
    project_sync = (
        sync_project_current_conclusion(project_root, current_conclusion_promotion_payload)
        if project_root is not None
        else {"status": "workspace_unavailable", "target_path": None, "topic_id": None, "source_task_id": None}
    )
    current_conclusion_promotion_payload["project_sync"] = project_sync
    current_conclusion_promotion = persist_current_conclusion_promotion(
        config,
        current_conclusion_promotion_payload,
        deps,
    )
    operator_summary = persist_operator_summary(
        config,
        build_post_run_operator_summary(
            evaluation,
            followup_task_draft,
            review_proposal_draft,
            hypothesis_promotion,
            experiment_promotion,
            current_conclusion_promotion,
            evaluation_report,
            current_conclusions,
        ),
        deps,
    )
    attachments: dict[str, dict[str, Any]] = {"execution_evaluation": evaluation}
    if followup_task_draft:
        attachments["followup_task_draft"] = followup_task_draft
    if ledger_note_draft:
        attachments["ledger_note_draft"] = ledger_note_draft
    if review_proposal_draft:
        attachments["review_proposal_draft"] = review_proposal_draft
    if hypothesis_update:
        attachments["hypothesis_update"] = hypothesis_update
    if hypothesis_promotion:
        attachments["hypothesis_promotion"] = hypothesis_promotion
    if experiment_result:
        attachments["experiment_result"] = experiment_result
    if experiment_index_update:
        attachments["experiment_index_update"] = experiment_index_update
    if experiment_promotion:
        attachments["experiment_promotion"] = experiment_promotion
    if current_conclusion_update:
        attachments["current_conclusion_update"] = current_conclusion_update
    if evaluation_report:
        attachments["evaluation_report"] = evaluation_report
    if current_conclusions:
        attachments["current_conclusions"] = current_conclusions
    if current_conclusion_promotion:
        attachments["current_conclusion_promotion"] = current_conclusion_promotion
    if operator_summary:
        attachments["operator_summary"] = operator_summary
    return attachments
