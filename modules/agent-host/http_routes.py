from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import parse_qs

JsonObject = dict[str, Any]
Payload = dict[str, str]

POST_ROUTES = {
    "/mattermost/watchdog",
    "/codex/prepare",
    "/codex/intake",
    "/codex/run",
    "/codex/status",
    "/codex/result",
    "/codex/logs",
    "/codex/cancel",
    "/codex/result-page",
    "/codex/stream-token",
}


@dataclass(frozen=True)
class HttpRouteDependencies:
    authenticate_bearer: Callable[[str, Any], Any]
    handle_health_summary: Callable[[Any, Any], JsonObject]
    handle_codex_workspaces: Callable[[Any, Any], JsonObject]
    handle_codex_capabilities: Callable[[Any, Any], JsonObject]
    handle_codex_tasks: Callable[[Payload, Any, Any], JsonObject]
    handle_codex_intake: Callable[[Payload, Any, Any], JsonObject]
    handle_codex_result_page: Callable[[Payload, Any, Any], JsonObject]
    handle_codex_query: Callable[[Payload, Any, str, Any], JsonObject]
    handle_watchdog: Callable[[Payload, Any], JsonObject]
    handle_codex_prepare: Callable[[Payload, Any, Any], JsonObject]
    handle_codex_run: Callable[[Payload, Any, Any], JsonObject]
    handle_stream_token: Callable[[Payload, Any, Any], JsonObject]
    index_html: Callable[[Any], str]
    parse_body: Callable[[str, bytes], Payload]
    mattermost_response: Callable[[str], JsonObject]
    bridge_error_type: type[Exception]


def query_payload(query: str) -> Payload:
    return {key: values[-1] if values else "" for key, values in parse_qs(query).items()}


def dispatch_get(
    handler: Any,
    *,
    path: str,
    query: str,
    authorization: str,
    config: Any,
    deps: HttpRouteDependencies,
) -> None:
    path = path.rstrip("/") or "/"
    if path == "/health":
        handler.send_json(200, {"ok": True})
        return
    if path == "/health/summary":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, deps.handle_health_summary(config, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path == "/whoami":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, {"ok": True, "user": principal.user, "role": principal.role})
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path in {"/", "/codex"}:
        handler.send_html(200, deps.index_html(config))
        return
    if path == "/codex/events":
        try:
            handler.handle_codex_events(query_payload(query))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path == "/codex/workspaces":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, deps.handle_codex_workspaces(config, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path == "/codex/capabilities":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, deps.handle_codex_capabilities(config, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path == "/codex/tasks":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, deps.handle_codex_tasks(query_payload(query), config, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path == "/codex/intake":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, deps.handle_codex_intake(query_payload(query), config, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path == "/codex/result-page":
        try:
            principal = deps.authenticate_bearer(authorization, config)
            handler.send_json(200, deps.handle_codex_result_page(query_payload(query), config, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path in {"/codex/status", "/codex/result", "/codex/logs", "/codex/cancel"}:
        try:
            principal = deps.authenticate_bearer(authorization, config)
            command = path.rsplit("/", 1)[-1]
            handler.send_json(200, deps.handle_codex_query(query_payload(query), config, command, principal))
        except Exception as exc:
            handler.send_api_error(exc)
        return
    if path.startswith("/codex"):
        handler.send_api_error(deps.bridge_error_type("not found", 404, "invalid_request"))
    else:
        handler.send_json(404, deps.mattermost_response("not found"))


def dispatch_post(
    handler: Any,
    *,
    route: str,
    content_type: str,
    raw: bytes,
    authorization: str,
    config: Any,
    deps: HttpRouteDependencies,
) -> None:
    route = route.rstrip("/") or "/"
    if route not in POST_ROUTES:
        if route.startswith("/codex"):
            handler.send_api_error(deps.bridge_error_type("not found", 404, "invalid_request"))
        else:
            handler.send_json(404, deps.mattermost_response("not found"))
        return

    try:
        payload = deps.parse_body(content_type, raw)
        if route == "/mattermost/watchdog":
            response = deps.handle_watchdog(payload, config)
        else:
            principal = deps.authenticate_bearer(authorization, config)
            if route == "/codex/prepare":
                handler.send_json(200, deps.handle_codex_prepare(payload, config, principal))
                return
            if route == "/codex/intake":
                handler.send_json(200, deps.handle_codex_intake(payload, config, principal))
                return
            if route == "/codex/run":
                handler.send_json(200, deps.handle_codex_run(payload, config, principal))
                return
            if route == "/codex/stream-token":
                handler.send_json(200, deps.handle_stream_token(payload, config, principal))
                return
            if route == "/codex/result-page":
                handler.send_json(200, deps.handle_codex_result_page(payload, config, principal))
                return
            command = route.rsplit("/", 1)[-1]
            response = deps.handle_codex_query(payload, config, command, principal)
        handler.send_json(200, response)
    except Exception as exc:
        if route == "/mattermost/watchdog":
            if isinstance(exc, deps.bridge_error_type):
                handler.send_json(getattr(exc, "status", 400), deps.mattermost_response(str(exc)))
            else:
                handler.send_json(500, {"ok": False, "text": f"bridge error: {exc}"})
        else:
            handler.send_api_error(exc)
