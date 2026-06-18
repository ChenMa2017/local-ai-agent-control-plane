from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable
from urllib.parse import urlparse

from http_routes import HttpRouteDependencies, dispatch_get, dispatch_post
from result_streaming import StreamLoopDependencies

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class HandlerDependencies:
    bridge_error_type: type[Exception]
    api_error_payload: Callable[[Exception], JsonObject]
    mattermost_response: Callable[[str], JsonObject]
    max_body_bytes: int
    redact_log_text: Callable[[str], str]
    validate_task_id: Callable[[str], str]
    principal_from_stream_token: Callable[[str, str], Any]
    authorize_task: Callable[[Any, Any, str], tuple[Any, JsonObject]]
    stream_task_events: Callable[[Any, str, Any, StreamLoopDependencies], None]
    stream_loop_dependencies: Callable[[Any], StreamLoopDependencies]
    http_route_dependencies: Callable[[], HttpRouteDependencies]


def build_stream_loop_dependencies(
    handler: Any,
    *,
    authorize_task: Callable[[Any, Any, str], tuple[Any, JsonObject]],
    safe_log_snapshot: Callable[[Any, str], JsonObject],
    has_safe_result: Callable[[Any], bool],
    task_snapshot: Callable[[JsonObject], JsonObject],
    remaining_seconds: Callable[[JsonObject], int | None],
    utc_now: Callable[[], Any],
    final_statuses: set[str] | frozenset[str],
    heartbeat_seconds: float,
    poll_seconds: float,
    log_event_max_chars: int,
) -> StreamLoopDependencies:
    return StreamLoopDependencies(
        authorize_task=authorize_task,
        safe_log_snapshot=safe_log_snapshot,
        has_safe_result=has_safe_result,
        send_sse_event=handler.send_sse_event,
        task_snapshot=task_snapshot,
        remaining_seconds=remaining_seconds,
        utc_now=utc_now,
        monotonic=time.monotonic,
        sleep=time.sleep,
        final_statuses=final_statuses,
        heartbeat_seconds=heartbeat_seconds,
        poll_seconds=poll_seconds,
        log_event_max_chars=log_event_max_chars,
    )


def build_http_route_dependencies(
    *,
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
    mattermost_response: Callable[[str], JsonObject],
    bridge_error_type: type[Exception],
) -> HttpRouteDependencies:
    return HttpRouteDependencies(
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
    )


def build_watchdog_bridge_handler(deps: HandlerDependencies) -> type[BaseHTTPRequestHandler]:
    class WatchdogBridgeHandler(BaseHTTPRequestHandler):
        config: Any

        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), deps.redact_log_text(fmt % args)))

        def send_json(self, status: int, payload: JsonObject) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_api_error(self, exc: Exception, status: int | None = None) -> None:
            if isinstance(exc, deps.bridge_error_type):
                self.send_json(status or getattr(exc, "status", 400), deps.api_error_payload(exc))
            else:
                self.send_json(status or 500, deps.api_error_payload(exc))

        def send_html(self, status: int, text: str) -> None:
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_sse_event(self, event: str, payload: JsonObject) -> None:
            data = json.dumps(payload, ensure_ascii=False)
            self.wfile.write(f"event: {event}\n".encode("utf-8"))
            for line in data.splitlines() or [""]:
                self.wfile.write(f"data: {line}\n".encode("utf-8"))
            self.wfile.write(b"\n")
            self.wfile.flush()

        def handle_codex_events(self, payload: dict[str, str]) -> None:
            task_id = deps.validate_task_id(payload.get("task_id", ""))
            principal = deps.principal_from_stream_token(task_id, payload.get("stream_token", ""))
            deps.authorize_task(self.config, principal, task_id)

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            try:
                deps.stream_task_events(
                    self.config,
                    task_id,
                    principal,
                    deps.stream_loop_dependencies(self),
                )
            except (BrokenPipeError, ConnectionResetError):
                return
            except deps.bridge_error_type as exc:
                self.send_sse_event("error", {"message": str(exc), "status": getattr(exc, "status", 400)})
            except Exception as exc:
                self.send_sse_event("error", {"message": f"bridge error: {exc}", "status": 500})

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            dispatch_get(
                self,
                path=parsed.path,
                query=parsed.query,
                authorization=self.headers.get("Authorization", ""),
                config=self.config,
                deps=deps.http_route_dependencies(),
            )

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            route = parsed.path.rstrip("/") or "/"
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length > deps.max_body_bytes:
                if route.startswith("/codex"):
                    self.send_api_error(deps.bridge_error_type("request body too large", 413, "payload_too_large"))
                else:
                    self.send_json(413, deps.mattermost_response("request body too large"))
                return
            raw = self.rfile.read(length)
            dispatch_post(
                self,
                route=route,
                content_type=self.headers.get("Content-Type", ""),
                raw=raw,
                authorization=self.headers.get("Authorization", ""),
                config=self.config,
                deps=deps.http_route_dependencies(),
            )

    return WatchdogBridgeHandler
