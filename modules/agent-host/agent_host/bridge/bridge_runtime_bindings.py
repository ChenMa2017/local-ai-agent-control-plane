from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .bridge_handler import (
    HandlerDependencies,
    build_http_route_dependencies,
    build_stream_loop_dependencies,
    build_watchdog_bridge_handler,
)
from .result_streaming import redact_url_secrets, stream_task_events

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class BridgeRuntimeBindings:
    build_handler_dependencies: Callable[[], HandlerDependencies]
    watchdog_bridge_handler: type[Any]


def build_bridge_runtime_bindings(
    *,
    bridge_error_type: type[Exception],
    api_error_payload: Callable[[Exception], JsonObject],
    mattermost_response: Callable[[str], JsonObject],
    max_body_bytes: int,
    validate_task_id: Callable[[str], str],
    principal_from_stream_token: Callable[[str, str], Any],
    authorize_task: Callable[[Any, Any, str], tuple[Any, JsonObject]],
    safe_log_snapshot: Callable[[Any, str], JsonObject],
    has_safe_result: Callable[[Path], bool],
    task_snapshot: Callable[[JsonObject], JsonObject],
    remaining_seconds: Callable[[JsonObject], int | None],
    utc_now: Callable[[], Any],
    final_statuses: set[str] | frozenset[str],
    heartbeat_seconds: float,
    poll_seconds: float,
    log_event_max_chars: int,
    authenticate_bearer: Callable[[str, Any], Any],
    handle_health_summary: Callable[[Any, Any], JsonObject],
    handle_codex_workspaces: Callable[[Any, Any], JsonObject],
    handle_codex_capabilities: Callable[[Any, Any], JsonObject],
    handle_codex_tasks: Callable[[dict[str, str], Any, Any], JsonObject],
    handle_codex_intake: Callable[[dict[str, str], Any, Any], JsonObject],
    handle_codex_result_page: Callable[[dict[str, str], Any, Any], JsonObject],
    handle_codex_query: Callable[[dict[str, str], Any, str, Any], JsonObject],
    handle_watchdog: Callable[[dict[str, str], Any], JsonObject],
    handle_codex_prepare: Callable[[dict[str, str], Any, Any], JsonObject],
    handle_codex_run: Callable[[dict[str, str], Any, Any], JsonObject],
    handle_stream_token: Callable[[dict[str, str], Any, Any], JsonObject],
    index_html: Callable[[Any], str],
    parse_body: Callable[[str, bytes], dict[str, str]],
) -> BridgeRuntimeBindings:
    def build_handler_dependencies() -> HandlerDependencies:
        return HandlerDependencies(
            bridge_error_type=bridge_error_type,
            api_error_payload=api_error_payload,
            mattermost_response=mattermost_response,
            max_body_bytes=max_body_bytes,
            redact_log_text=redact_url_secrets,
            validate_task_id=validate_task_id,
            principal_from_stream_token=principal_from_stream_token,
            authorize_task=authorize_task,
            stream_task_events=stream_task_events,
            stream_loop_dependencies=lambda handler: build_stream_loop_dependencies(
                handler,
                authorize_task=authorize_task,
                safe_log_snapshot=safe_log_snapshot,
                has_safe_result=has_safe_result,
                task_snapshot=task_snapshot,
                remaining_seconds=remaining_seconds,
                utc_now=utc_now,
                final_statuses=final_statuses,
                heartbeat_seconds=heartbeat_seconds,
                poll_seconds=poll_seconds,
                log_event_max_chars=log_event_max_chars,
            ),
            http_route_dependencies=lambda: build_http_route_dependencies(
                authenticate_bearer=authenticate_bearer,
                handle_health_summary=handle_health_summary,
                handle_codex_workspaces=handle_codex_workspaces,
                handle_codex_capabilities=handle_codex_capabilities,
                handle_codex_tasks=handle_codex_tasks,
                handle_codex_intake=handle_codex_intake,
                handle_codex_result_page=handle_codex_result_page,
                handle_codex_query=handle_codex_query,
                handle_watchdog=handle_watchdog,
                handle_codex_prepare=handle_codex_prepare,
                handle_codex_run=handle_codex_run,
                handle_stream_token=handle_stream_token,
                index_html=index_html,
                parse_body=parse_body,
                mattermost_response=mattermost_response,
                bridge_error_type=bridge_error_type,
            ),
        )

    return BridgeRuntimeBindings(
        build_handler_dependencies=build_handler_dependencies,
        watchdog_bridge_handler=build_watchdog_bridge_handler(build_handler_dependencies()),
    )
