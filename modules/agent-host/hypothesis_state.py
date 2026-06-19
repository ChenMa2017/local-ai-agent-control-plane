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

HYPOTHESIS_ALLOWED_TRANSITIONS = {
    # New hypotheses must enter the registry as open candidates first; final-like
    # states require either an existing testing record or a review bundle.
    "__new__": {"proposed", "testing"},
    "proposed": {"proposed", "testing", "superseded", "archived"},
    "testing": {"testing", "supported", "refuted", "inconclusive", "invalid", "superseded", "archived"},
    # Keep `active` readable for older project registries, but route new evidence
    # back through testing before writing another final-like status.
    "active": {"active", "testing", "inconclusive", "superseded", "archived"},
    "supported": {"supported", "testing", "superseded", "archived"},
    "refuted": {"refuted", "testing", "superseded", "archived"},
    "inconclusive": {"testing", "inconclusive", "superseded", "archived"},
    "invalid": {"testing", "invalid", "superseded", "archived"},
    "superseded": {"superseded", "archived"},
    "archived": {"archived"},
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
    return validate_status_transition(
        current_status=(
            existing_record.get("status")
            if isinstance(existing_record, dict)
            else None
        ),
        proposed_status=str(update.get("status") or ""),
        allowed_transitions=HYPOTHESIS_ALLOWED_TRANSITIONS,
        known_statuses=KNOWN_HYPOTHESIS_STATUSES,
        existing_record_present=isinstance(existing_record, dict),
    )


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
