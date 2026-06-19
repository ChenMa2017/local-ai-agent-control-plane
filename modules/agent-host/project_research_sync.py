from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from hypothesis_state import validate_hypothesis_registry_transition, validate_status_transition
from research_store import write_json_atomic

JsonObject = dict[str, Any]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def safe_topic_slug(text: Any, fallback: str) -> str:
    parts = re.findall(r"[A-Za-z0-9]+", str(text or "").lower())
    if not parts:
        return fallback
    return "_".join(parts[:8]) or fallback


def read_json_object_if_exists(path: Path) -> JsonObject:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


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
        "imported_from_history": bool(update.get("imported_from_history")),
        "import_review_id": str(update.get("import_review_id") or "").strip() or None,
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
