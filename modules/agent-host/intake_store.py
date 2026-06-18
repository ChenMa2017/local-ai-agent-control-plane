from __future__ import annotations

import datetime as dt
import json
import os
import re
import secrets
from pathlib import Path
from typing import Any, Callable

from prepared_context import load_intake_questions_from_sources

JsonObject = dict[str, Any]
ErrorFactory = Callable[[str, int, str | None], Exception]


def validate_intake_id(
    intake_id: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> str:
    if not intake_id_re.match(intake_id or ""):
        raise error_factory("invalid intake_id", 400, "invalid_request")
    return intake_id


def new_intake_id(
    *,
    utc_now: Callable[[], dt.datetime],
    token_hex_factory: Callable[[int], str] | None = None,
) -> str:
    token_hex_factory = token_hex_factory or secrets.token_hex
    stamp = utc_now().strftime("%Y%m%d_%H%M%S")
    return f"intake_{stamp}_{token_hex_factory(3)}"


def intake_root(config: Any) -> Path:
    return Path(getattr(config, "codex_bridge_root")) / ".codex-bridge" / "intake"


def intake_dir(
    config: Any,
    intake_id: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> Path:
    return intake_root(config) / validate_intake_id(intake_id, intake_id_re=intake_id_re, error_factory=error_factory)


def read_json_object_if_exists(path: Path) -> JsonObject:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json_atomic(path: Path, data: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(temp, path)


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temp.write_text(text)
    os.replace(temp, path)


def append_jsonl(path: Path, event: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def load_intake_intent(
    config: Any,
    intake_id: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> JsonObject:
    path = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory) / "INTENT_DRAFT.json"
    if not path.exists():
        raise error_factory(f"intake not found: {intake_id}", 404, "intake_not_found")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise error_factory(f"intake metadata is invalid: {intake_id}: {exc}", 500, None) from exc
    if not isinstance(data, dict):
        raise error_factory(f"intake metadata is invalid: {intake_id}", 500, None)
    return data


def load_intake_json_artifact(
    config: Any,
    intake_id: str,
    filename: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> JsonObject:
    path = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory) / filename
    if not path.exists():
        raise error_factory(f"intake artifact is missing: {intake_id}/{filename}", 409, "prepare_artifact_missing")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise error_factory(f"intake artifact is invalid: {intake_id}/{filename}: {exc}", 500, None) from exc
    if not isinstance(data, dict):
        raise error_factory(f"intake artifact is invalid: {intake_id}/{filename}", 500, None)
    return data


def load_optional_intake_json_artifact(
    config: Any,
    intake_id: str,
    filename: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> JsonObject | None:
    path = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory) / filename
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise error_factory(f"intake artifact is invalid: {intake_id}/{filename}: {exc}", 500, None) from exc
    if not isinstance(data, dict):
        raise error_factory(f"intake artifact is invalid: {intake_id}/{filename}", 500, None)
    return data


def load_intake_questions(
    config: Any,
    intake_id: str,
    *,
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> list[str]:
    questions_data = load_optional_intake_json_artifact(
        config,
        intake_id,
        "QUESTIONS.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    path = intake_dir(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory) / "QUESTIONS.md"
    questions_markdown = path.read_text() if path.exists() else ""
    return load_intake_questions_from_sources(questions_data, questions_markdown)


def load_prepared_run_context(
    config: Any,
    intake_id: str,
    principal: Any,
    *,
    can_access_intake: Callable[[JsonObject, Any], bool],
    intake_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> JsonObject:
    intent = load_intake_intent(config, intake_id, intake_id_re=intake_id_re, error_factory=error_factory)
    if not can_access_intake(intent, principal):
        raise error_factory(f"permission denied for intake: {intake_id}", 403, "permission_denied")
    contract = load_intake_json_artifact(
        config,
        intake_id,
        "TASK_CONTRACT.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    taskbox = load_intake_json_artifact(
        config,
        intake_id,
        "TASKBOX_DRAFT.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    preflight = load_intake_json_artifact(
        config,
        intake_id,
        "POLICY_PREFLIGHT.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    evidence = load_intake_json_artifact(
        config,
        intake_id,
        "EVIDENCE_RETRIEVAL.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    research_program = load_optional_intake_json_artifact(
        config,
        intake_id,
        "RESEARCH_PROGRAM.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    hypothesis_registry = load_optional_intake_json_artifact(
        config,
        intake_id,
        "HYPOTHESIS_REGISTRY.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    experiment_spec = load_optional_intake_json_artifact(
        config,
        intake_id,
        "EXPERIMENT_SPEC.json",
        intake_id_re=intake_id_re,
        error_factory=error_factory,
    )
    return {
        "intake_id": intake_id,
        "intent": intent,
        "contract": contract,
        "taskbox": taskbox,
        "preflight": preflight,
        "evidence_retrieval": evidence,
        "research_program": research_program or None,
        "hypothesis_registry": hypothesis_registry or None,
        "experiment_spec": experiment_spec or None,
    }
