from __future__ import annotations

from typing import Any

JsonObject = dict[str, Any]

KNOWN_HYPOTHESIS_STATUSES = {
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

HYPOTHESIS_FINAL_STATUSES = {
    "supported",
    "refuted",
    "inconclusive",
    "invalid",
}

HYPOTHESIS_ALLOWED_TRANSITIONS = {
    # New hypotheses must enter the registry as open candidates first; final-like
    # states require either an existing testing record or a review bundle.
    "__new__": {"proposed", "testing"},
    "proposed": {"proposed", "testing", "superseded", "archived"},
    "testing": {"testing", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
    # Keep `active` readable for older project registries, but force the next
    # machine-authored revision back through testing before any newer outcome is
    # published.
    "active": {"testing", "superseded", "archived"},
    "supported": {"supported", "testing", "superseded", "archived"},
    "refuted": {"refuted", "testing", "superseded", "archived"},
    "inconclusive": {"testing", "inconclusive", "superseded", "archived"},
    "invalid": {"testing", "invalid", "superseded", "archived"},
    "superseded": {"superseded", "archived"},
    "archived": {"archived"},
}


def _historical_import_transition_validation(update: JsonObject, proposed_status: str) -> JsonObject | None:
    if proposed_status not in HYPOTHESIS_FINAL_STATUSES:
        return None
    source = update.get("source") if isinstance(update.get("source"), dict) else {}
    source_origin = str(source.get("origin") or "").strip()
    import_review_id = str(update.get("import_review_id") or "").strip()
    imported_from_history = bool(update.get("imported_from_history"))
    historical_import_attempt = (
        imported_from_history
        or bool(import_review_id)
        or source_origin == "historical_import"
    )
    if not historical_import_attempt:
        return None
    supporting_evidence = update.get("supporting_evidence")
    missing_requirements: list[str] = []
    if not imported_from_history:
        missing_requirements.append("imported_from_history")
    if not import_review_id:
        missing_requirements.append("import_review_id")
    if source_origin != "historical_import":
        missing_requirements.append("source.origin=historical_import")
    if not isinstance(supporting_evidence, list) or not supporting_evidence:
        missing_requirements.append("supporting_evidence")
    if missing_requirements:
        return {
            "status": "review_required",
            "reason": "historical_import_metadata_required",
            "current_status": None,
            "proposed_status": proposed_status,
            "missing_requirements": missing_requirements,
        }
    return {
        "status": "valid",
        "reason": "historical_import_ok",
        "current_status": None,
        "proposed_status": proposed_status,
        "allowed_next_statuses": [proposed_status],
    }


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


def validate_hypothesis_registry_transition(
    existing_record: JsonObject | None,
    update: JsonObject,
) -> JsonObject:
    existing_record_present = isinstance(existing_record, dict)
    proposed_status = str(update.get("status") or "").strip()
    if not existing_record_present:
        historical_import_validation = _historical_import_transition_validation(update, proposed_status)
        if historical_import_validation is not None:
            return historical_import_validation
    return validate_status_transition(
        current_status=(
            existing_record.get("status")
            if existing_record_present
            else None
        ),
        proposed_status=proposed_status,
        allowed_transitions=HYPOTHESIS_ALLOWED_TRANSITIONS,
        known_statuses=KNOWN_HYPOTHESIS_STATUSES,
        existing_record_present=existing_record_present,
    )


def derive_hypothesis_status_resolution(
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
) -> JsonObject:
    if not bool(experiment_spec.get("required")):
        return {
            "status": "proposed",
            "reason": "analysis_only_hypothesis",
            "blockers": [],
        }
    if not evaluation.get("result_available") or str(evaluation.get("task_status") or "") != "done":
        return {
            "status": "testing",
            "reason": "awaiting_experiment_completion",
            "blockers": [],
        }
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
        return {
            "status": "invalid",
            "reason": "experiment_invalid",
            "blockers": [],
        }
    if isinstance(experiment_result, dict) and experiment_result and not bool(experiment_result.get("promotion_eligible")):
        blockers = [
            str(item).strip()
            for item in (experiment_result.get("limitations") or [])
            if str(item or "").strip()
        ]
        adjudication_status = str(experiment_result.get("adjudication_status") or "").strip()
        if not blockers and adjudication_status and adjudication_status != "accepted":
            blockers.append(f"adjudication_status:{adjudication_status}")
        return {
            "status": "testing",
            "reason": "experiment_not_promotion_eligible",
            "blockers": blockers,
        }
    final_result = (
        str((experiment_result or {}).get("final_result") or "").strip()
        if isinstance(experiment_result, dict)
        else ""
    )
    if final_result in {"supported", "refuted", "inconclusive"}:
        return {
            "status": final_result,
            "reason": "experiment_final_result",
            "blockers": [],
        }
    if evaluation_result in {"supported", "refuted", "inconclusive"}:
        return {
            "status": evaluation_result,
            "reason": "experiment_evaluation_result",
            "blockers": [],
        }
    return {
        "status": "testing",
        "reason": "no_conclusive_experiment_result",
        "blockers": [],
    }


def derive_hypothesis_record_status(
    evaluation: JsonObject,
    experiment_spec: JsonObject,
    experiment_result: JsonObject | None,
) -> str:
    return str(
        derive_hypothesis_status_resolution(
            evaluation,
            experiment_spec,
            experiment_result,
        ).get("status")
        or "testing"
    )
