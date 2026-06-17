from __future__ import annotations

import datetime as dt
import json
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Callable

JsonObject = dict[str, Any]
ErrorFactory = Callable[[str, int], Exception]


@dataclass(frozen=True)
class StreamLoopDependencies:
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    safe_log_snapshot: Callable[[Any, str], JsonObject]
    has_safe_result: Callable[[Path], bool]
    send_sse_event: Callable[[str, JsonObject], None]
    task_snapshot: Callable[[JsonObject], JsonObject]
    remaining_seconds: Callable[[JsonObject], int | None]
    utc_now: Callable[[], dt.datetime]
    monotonic: Callable[[], float]
    sleep: Callable[[float], None]
    final_statuses: set[str] | frozenset[str]
    heartbeat_seconds: float
    poll_seconds: float
    log_event_max_chars: int


def cleanup_stream_tokens(
    tokens: dict[str, JsonObject],
    lock: Lock,
    utc_now: Callable[[], dt.datetime],
) -> None:
    now = utc_now()
    with lock:
        expired = [
            token
            for token, record in tokens.items()
            if record.get("expires_at_dt") and record["expires_at_dt"] <= now
        ]
        for token in expired:
            tokens.pop(token, None)


def issue_stream_token(
    task_id: str,
    user: str,
    role: str,
    tokens: dict[str, JsonObject],
    lock: Lock,
    utc_now: Callable[[], dt.datetime],
    ttl_seconds: int,
) -> dict[str, Any]:
    token = secrets.token_urlsafe(32)
    expires_at = utc_now() + dt.timedelta(seconds=ttl_seconds)
    with lock:
        tokens[token] = {
            "task_id": task_id,
            "user": user,
            "role": role,
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
            "expires_at_dt": expires_at,
        }
    return {
        "stream_token": token,
        "expires_in": ttl_seconds,
        "events_url": f"/codex/events?task_id={task_id}&stream_token={token}",
    }


def resolve_stream_principal(
    task_id: str,
    stream_token: str,
    tokens: dict[str, JsonObject],
    lock: Lock,
    utc_now: Callable[[], dt.datetime],
    error_factory: ErrorFactory,
) -> tuple[str, str]:
    cleanup_stream_tokens(tokens, lock, utc_now)
    if not stream_token:
        raise error_factory("unauthorized: stream token required", 401)
    with lock:
        record = tokens.get(stream_token)
    if not record:
        raise error_factory("unauthorized: invalid or expired stream token", 401)
    if record.get("task_id") != task_id:
        raise error_factory("unauthorized: stream token is not valid for this task", 403)
    return str(record.get("user", "")), str(record.get("role", "user"))


def remaining_seconds(
    task: JsonObject,
    parse_iso_datetime: Callable[[Any], dt.datetime | None],
    utc_now: Callable[[], dt.datetime],
) -> int | None:
    deadline = parse_iso_datetime(task.get("deadline_at"))
    if not deadline:
        return None
    return max(0, int((deadline - utc_now()).total_seconds()))


def task_snapshot(
    task: JsonObject,
    remaining_seconds_fn: Callable[[JsonObject], int | None],
) -> dict[str, Any]:
    return {
        "task_id": str(task.get("task_id", "")),
        "project": str(task.get("project", "")),
        "status": str(task.get("status", "")),
        "created_at": str(task.get("created_at", "")),
        "started_at": str(task.get("started_at", "")),
        "updated_at": str(task.get("updated_at", "")),
        "timeout_seconds": task.get("timeout_seconds"),
        "remaining_sec": remaining_seconds_fn(task),
        "exit_code": task.get("exit_code") if isinstance(task.get("exit_code"), int) else None,
    }


def safe_log_snapshot(
    config: Any,
    task_id: str,
    run_codex_bridge: Callable[[Any, list[str], int], Any],
    require_success: Callable[[Any], str],
    *,
    tail_lines: int,
    max_chars: int,
    timeout: int,
    error_factory: ErrorFactory,
) -> JsonObject:
    args = [
        "logs",
        task_id,
        "--json-output",
        "--tail",
        str(tail_lines),
        "--max-chars",
        str(max_chars),
    ]
    output = require_success(run_codex_bridge(config, args, timeout=timeout))
    try:
        data = json.loads(output)
    except json.JSONDecodeError as exc:
        raise error_factory(f"codex-bridge logs returned invalid JSON: {exc}", 500) from exc
    return data if isinstance(data, dict) else {}


def redact_url_secrets(text: str) -> str:
    text = re.sub(r"(stream_token=)[^&\s]+", r"\1[REDACTED]", text)
    text = re.sub(r"([?&]token=)[^&\s]+", r"\1[REDACTED]", text)
    return text


def stream_task_events(
    config: Any,
    task_id: str,
    principal: Any,
    deps: StreamLoopDependencies,
) -> None:
    last_status = ""
    last_log_text = ""
    sent_snapshot = False
    sent_result = False
    last_heartbeat = 0.0

    while True:
        task_dir, task = deps.authorize_task(config, principal, task_id)
        status = str(task.get("status", ""))

        if not sent_snapshot:
            deps.send_sse_event("snapshot", deps.task_snapshot(task))
            sent_snapshot = True
            last_status = status
        elif status != last_status:
            deps.send_sse_event(
                "status",
                {
                    "task_id": task_id,
                    "status": status,
                    "updated_at": str(task.get("updated_at", "")),
                    "remaining_sec": deps.remaining_seconds(task),
                },
            )
            last_status = status

        logs = deps.safe_log_snapshot(config, task_id)
        log_text = str(logs.get("text", ""))
        if log_text != last_log_text:
            if log_text.startswith(last_log_text):
                delta = log_text[len(last_log_text) :]
            else:
                delta = "[log snapshot refreshed]\n" + log_text[-deps.log_event_max_chars :]
            if len(delta) > deps.log_event_max_chars:
                delta = "[log event trimmed]\n" + delta[-deps.log_event_max_chars :]
            if delta.strip():
                deps.send_sse_event(
                    "log",
                    {
                        "task_id": task_id,
                        "source": "safe logs",
                        "text": delta,
                        "redacted": bool(logs.get("redacted", True)),
                        "truncated": bool(logs.get("truncated", False)),
                    },
                )
            last_log_text = log_text

        if not sent_result and deps.has_safe_result(task_dir):
            deps.send_sse_event(
                "result",
                {
                    "task_id": task_id,
                    "has_result": True,
                    "safe": True,
                },
            )
            sent_result = True

        if status in deps.final_statuses:
            deps.send_sse_event(
                "done",
                {
                    "task_id": task_id,
                    "status": status,
                    "exit_code": task.get("exit_code") if isinstance(task.get("exit_code"), int) else None,
                },
            )
            return

        now = deps.monotonic()
        if now - last_heartbeat >= deps.heartbeat_seconds:
            deps.send_sse_event("heartbeat", {"ts": deps.utc_now().isoformat().replace("+00:00", "Z")})
            last_heartbeat = now
        deps.sleep(deps.poll_seconds)
