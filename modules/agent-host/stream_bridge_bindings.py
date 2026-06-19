from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from codex_runtime import (
    principal_from_stream_token as resolve_stream_session_principal,
)
from result_streaming import (
    cleanup_stream_tokens as cleanup_stream_token_records,
    issue_stream_token,
    remaining_seconds as compute_remaining_seconds,
    resolve_stream_principal,
    safe_log_snapshot as load_safe_log_snapshot,
    task_snapshot as build_task_snapshot,
)
from web_ui import render_index_html

JsonObject = dict[str, Any]
StatusErrorFactory = Callable[[str, int], Exception]


@dataclass(frozen=True)
class StreamBridgeBindings:
    cleanup_stream_tokens: Callable[[], None]
    create_stream_token_payload: Callable[[str, str, str], JsonObject]
    resolve_active_stream_principal: Callable[[str, str], tuple[str, str]]
    principal_from_stream_token: Callable[[str, str], Any]
    remaining_seconds: Callable[[JsonObject], int | None]
    task_snapshot: Callable[[JsonObject], JsonObject]
    safe_log_snapshot: Callable[[Any, str], JsonObject]
    has_safe_result: Callable[[Path], bool]
    index_html: Callable[[Any], str]


def build_stream_bridge_bindings(
    *,
    stream_tokens: dict[str, JsonObject],
    stream_token_lock: Any,
    utc_now: Callable[[], Any],
    stream_token_ttl_seconds: int,
    auth_principal_factory: Callable[..., Any],
    parse_iso_datetime: Callable[[Any], Any],
    run_codex_bridge: Callable[[Any, list[str], int], Any],
    require_success: Callable[[Any], str],
    sse_log_tail_lines: int,
    sse_log_max_chars: int,
    status_error_factory: StatusErrorFactory,
) -> StreamBridgeBindings:
    def cleanup_stream_tokens() -> None:
        cleanup_stream_token_records(stream_tokens, stream_token_lock, utc_now)

    def create_stream_token_payload(task_id: str, user: str, role: str) -> JsonObject:
        return issue_stream_token(
            task_id,
            user,
            role,
            stream_tokens,
            stream_token_lock,
            utc_now,
            stream_token_ttl_seconds,
        )

    def resolve_active_stream_principal(task_id: str, stream_token: str) -> tuple[str, str]:
        return resolve_stream_principal(
            task_id,
            stream_token,
            stream_tokens,
            stream_token_lock,
            utc_now,
            status_error_factory,
        )

    def principal_from_stream_token(task_id: str, stream_token: str) -> Any:
        user, role = resolve_stream_session_principal(
            task_id,
            stream_token,
            resolve_stream_principal=resolve_active_stream_principal,
        )
        return auth_principal_factory(user=user, role=role)

    def remaining_seconds(task: JsonObject) -> int | None:
        return compute_remaining_seconds(task, parse_iso_datetime, utc_now)

    def task_snapshot(task: JsonObject) -> JsonObject:
        return build_task_snapshot(task, remaining_seconds)

    def safe_log_snapshot(config: Any, task_id: str) -> JsonObject:
        return load_safe_log_snapshot(
            config,
            task_id,
            run_codex_bridge,
            require_success,
            tail_lines=sse_log_tail_lines,
            max_chars=sse_log_max_chars,
            timeout=10,
            error_factory=status_error_factory,
        )

    def has_safe_result(task_dir: Path) -> bool:
        return (task_dir / "result.safe.md").exists() or (task_dir / "result.md").exists()

    def index_html(config: Any) -> str:
        return render_index_html(list(getattr(config, "projects", {})))

    return StreamBridgeBindings(
        cleanup_stream_tokens=cleanup_stream_tokens,
        create_stream_token_payload=create_stream_token_payload,
        resolve_active_stream_principal=resolve_active_stream_principal,
        principal_from_stream_token=principal_from_stream_token,
        remaining_seconds=remaining_seconds,
        task_snapshot=task_snapshot,
        safe_log_snapshot=safe_log_snapshot,
        has_safe_result=has_safe_result,
        index_html=index_html,
    )
