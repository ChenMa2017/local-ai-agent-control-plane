from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import parse_qs


def parse_body(
    content_type: str,
    raw: bytes,
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> dict[str, str]:
    if "application/json" in content_type:
        data = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(data, dict):
            raise error_factory("JSON body must be an object", 400, None)
        parsed: dict[str, str] = {}
        for key, value in data.items():
            if value is None:
                continue
            if isinstance(value, (dict, list)):
                parsed[str(key)] = json.dumps(value, ensure_ascii=False)
            else:
                parsed[str(key)] = str(value)
        return parsed

    parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
    return {key: values[-1] if values else "" for key, values in parsed.items()}


def mattermost_response(
    text: str,
    *,
    max_response_chars: int,
    response_type: str = "ephemeral",
) -> dict[str, str]:
    if len(text) > max_response_chars:
        text = text[: max_response_chars - 80].rstrip() + "\n\n...(truncated)"
    return {"response_type": response_type, "text": text}


def error_code_for(exc: Exception) -> str:
    code = getattr(exc, "code", None)
    if code:
        return str(code)
    status = int(getattr(exc, "status", 500))
    message = str(exc).lower()
    if status == 401:
        return "unauthorized"
    if status == 403:
        return "permission_denied"
    if status == 404:
        return "task_not_found" if "task" in message else "workspace_not_found"
    if status == 409:
        return "task_already_finished"
    if status == 400:
        return "invalid_request"
    return "internal_error"


def api_error_payload(exc: Exception) -> dict[str, Any]:
    if hasattr(exc, "status"):
        code = error_code_for(exc)
        message = str(exc)
        details = getattr(exc, "details", {}) or {}
    else:
        code = "internal_error"
        message = f"bridge error: {exc}"
        details = {}
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "details": details,
        },
        "text": message,
    }


def safe_adapter_source(
    value: str,
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> str:
    source = (value or "web").strip() or "web"
    if not re.match(r"^[A-Za-z0-9_.-]{1,32}$", source):
        raise error_factory("source must be 1-32 safe characters", 400, "invalid_request")
    return source


def safe_idempotency_key(
    value: str,
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> str:
    key = (value or "").strip()
    if not key:
        return ""
    if not re.match(r"^[A-Za-z0-9_.:@/-]{1,160}$", key):
        raise error_factory("idempotency_key contains unsafe characters", 400, "invalid_request")
    return key


def parse_adapter_metadata(
    value: str,
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> dict[str, Any]:
    if not value:
        return {}
    try:
        data = json.loads(value)
    except json.JSONDecodeError as exc:
        raise error_factory(f"metadata must be a JSON object: {exc}", 400, "invalid_request") from exc
    if not isinstance(data, dict):
        raise error_factory("metadata must be a JSON object", 400, "invalid_request")
    return data


def compact_adapter_metadata_object(
    data: dict[str, Any],
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> str:
    if not data:
        return ""
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > 2000:
        raise error_factory("metadata is too large", 400, "invalid_request")
    return text


def compact_adapter_metadata(
    value: str,
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> str:
    data = parse_adapter_metadata(value, error_factory=error_factory)
    return compact_adapter_metadata_object(data, error_factory=error_factory)


def parse_run_receipt(output: str) -> dict[str, Any]:
    return {
        "idempotent_replay": bool(re.search(r"^idempotent=true$", output, re.MULTILINE)),
    }
