import io
import unittest

import bridge_handler


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


def make_route_dependencies():
    return bridge_handler.build_http_route_dependencies(
        authenticate_bearer=lambda _authorization, _config: object(),
        handle_health_summary=lambda _config, _principal: {"ok": True},
        handle_codex_workspaces=lambda _config, _principal: {"ok": True, "workspaces": []},
        handle_codex_capabilities=lambda _config, _principal: {"ok": True, "features": {}},
        handle_codex_tasks=lambda payload, _config, _principal: {"ok": True, "tasks": payload},
        handle_codex_intake=lambda payload, _config, _principal: {"ok": True, "intake": payload},
        handle_codex_result_page=lambda payload, _config, _principal: {"ok": True, "page": payload},
        handle_codex_query=lambda payload, _config, command, _principal: {
            "ok": True,
            "command": command,
            "payload": payload,
        },
        handle_watchdog=lambda payload, _config: {"ok": True, "watchdog": payload},
        handle_codex_prepare=lambda payload, _config, _principal: {"ok": True, "prepare": payload},
        handle_codex_run=lambda payload, _config, _principal: {"ok": True, "run": payload},
        handle_stream_token=lambda payload, _config, _principal: {"ok": True, "stream": payload},
        index_html=lambda _config: "<html>ok</html>",
        parse_body=lambda _content_type, _raw: {"workspace": "demo"},
        mattermost_response=lambda text: {"ok": False, "text": text},
        bridge_error_type=FakeBridgeError,
    )


def make_handler_dependencies(**overrides):
    defaults = {
        "bridge_error_type": FakeBridgeError,
        "api_error_payload": lambda exc: {"ok": False, "error": str(exc)},
        "mattermost_response": lambda text: {"ok": False, "text": text},
        "max_body_bytes": 64,
        "redact_log_text": lambda text: text,
        "validate_task_id": lambda task_id: task_id,
        "principal_from_stream_token": lambda _task_id, _stream_token: object(),
        "authorize_task": lambda _config, _principal, _task_id: (None, {}),
        "stream_task_events": lambda _config, _task_id, _principal, _deps: None,
        "stream_loop_dependencies": lambda _handler: object(),
        "http_route_dependencies": make_route_dependencies,
    }
    defaults.update(overrides)
    return bridge_handler.HandlerDependencies(**defaults)


def make_handler_instance(handler_class, *, path: str, headers: dict[str, str] | None = None, body: bytes = b""):
    handler = object.__new__(handler_class)
    handler.config = object()
    handler.path = path
    handler.headers = headers or {}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler.response_status = None
    handler.response_headers = []
    handler.send_response = lambda status: setattr(handler, "response_status", status)
    handler.send_header = lambda name, value: handler.response_headers.append((name, value))
    handler.end_headers = lambda: None
    return handler


class BridgeHandlerTests(unittest.TestCase):
    def test_do_get_renders_root_html(self):
        handler_class = bridge_handler.build_watchdog_bridge_handler(make_handler_dependencies())
        handler = make_handler_instance(handler_class, path="/", headers={"Authorization": "Bearer token"})

        handler.do_GET()

        self.assertEqual(handler.response_status, 200)
        self.assertEqual(handler.wfile.getvalue().decode("utf-8"), "<html>ok</html>")

    def test_do_post_rejects_oversized_body(self):
        handler_class = bridge_handler.build_watchdog_bridge_handler(make_handler_dependencies(max_body_bytes=8))
        handler = make_handler_instance(
            handler_class,
            path="/mattermost/watchdog",
            headers={"Content-Length": "9", "Content-Type": "application/json"},
        )

        handler.do_POST()

        self.assertEqual(handler.response_status, 413)
        self.assertIn('"request body too large"', handler.wfile.getvalue().decode("utf-8"))

    def test_handle_codex_events_emits_bridge_error_event(self):
        handler_class = bridge_handler.build_watchdog_bridge_handler(
            make_handler_dependencies(
                stream_task_events=lambda _config, _task_id, _principal, _deps: (_ for _ in ()).throw(
                    FakeBridgeError("stream failed", 409)
                ),
            )
        )
        handler = make_handler_instance(handler_class, path="/codex/events")

        handler.handle_codex_events({"task_id": "task_1", "stream_token": "secret"})

        output = handler.wfile.getvalue().decode("utf-8")
        self.assertEqual(handler.response_status, 200)
        self.assertIn("event: error", output)
        self.assertIn('"message": "stream failed"', output)
        self.assertIn('"status": 409', output)


if __name__ == "__main__":
    unittest.main()
