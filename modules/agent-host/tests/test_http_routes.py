import unittest

import http_routes


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class FakePrincipal:
    def __init__(self, user: str = "chenma", role: str = "admin"):
        self.user = user
        self.role = role


class FakeHandler:
    def __init__(self) -> None:
        self.json_calls: list[tuple[int, dict[str, object]]] = []
        self.html_calls: list[tuple[int, str]] = []
        self.api_error_calls: list[Exception] = []
        self.events_payloads: list[dict[str, str]] = []

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        self.json_calls.append((status, payload))

    def send_html(self, status: int, text: str) -> None:
        self.html_calls.append((status, text))

    def send_api_error(self, exc: Exception) -> None:
        self.api_error_calls.append(exc)

    def handle_codex_events(self, payload: dict[str, str]) -> None:
        self.events_payloads.append(payload)


def make_deps() -> http_routes.HttpRouteDependencies:
    return http_routes.HttpRouteDependencies(
        authenticate_bearer=lambda _authorization, _config: FakePrincipal(),
        handle_health_summary=lambda _config, _principal: {"ok": True, "summary": "healthy"},
        handle_codex_workspaces=lambda _config, _principal: {"ok": True, "workspaces": []},
        handle_codex_capabilities=lambda _config, _principal: {"ok": True, "features": {}},
        handle_codex_tasks=lambda payload, _config, _principal: {"ok": True, "payload": payload},
        handle_codex_intake=lambda payload, _config, _principal: {"ok": True, "intake": payload},
        handle_codex_result_page=lambda payload, _config, _principal: {"ok": True, "page": payload},
        handle_codex_query=lambda payload, _config, command, _principal: {"ok": True, "command": command, "payload": payload},
        handle_watchdog=lambda payload, _config: {"ok": True, "watchdog": payload},
        handle_codex_prepare=lambda payload, _config, _principal: {"ok": True, "prepare": payload},
        handle_codex_run=lambda payload, _config, _principal: {"ok": True, "run": payload},
        handle_stream_token=lambda payload, _config, _principal: {"ok": True, "stream": payload},
        index_html=lambda _config: "<html>/whoami</html>",
        parse_body=lambda _content_type, _raw: {"workspace": "demo"},
        mattermost_response=lambda text: {"ok": False, "text": text},
        bridge_error_type=FakeBridgeError,
    )


class HttpRoutesTests(unittest.TestCase):
    def test_query_payload_keeps_last_value(self):
        payload = http_routes.query_payload("task_id=one&task_id=two&mode=readonly")
        self.assertEqual(payload, {"task_id": "two", "mode": "readonly"})

    def test_dispatch_get_root_renders_html(self):
        handler = FakeHandler()
        http_routes.dispatch_get(
            handler,
            path="/",
            query="",
            authorization="Bearer token",
            config=object(),
            deps=make_deps(),
        )

        self.assertEqual(handler.html_calls, [(200, "<html>/whoami</html>")])

    def test_dispatch_get_codex_trailing_slash_renders_html(self):
        handler = FakeHandler()
        http_routes.dispatch_get(
            handler,
            path="/codex/",
            query="",
            authorization="Bearer token",
            config=object(),
            deps=make_deps(),
        )

        self.assertEqual(handler.html_calls, [(200, "<html>/whoami</html>")])

    def test_dispatch_get_events_passes_query_payload(self):
        handler = FakeHandler()
        http_routes.dispatch_get(
            handler,
            path="/codex/events",
            query="task_id=task_1&stream_token=secret",
            authorization="Bearer token",
            config=object(),
            deps=make_deps(),
        )

        self.assertEqual(handler.events_payloads, [{"task_id": "task_1", "stream_token": "secret"}])

    def test_dispatch_post_watchdog_formats_bridge_error_for_mattermost(self):
        handler = FakeHandler()
        deps = make_deps()
        deps = http_routes.HttpRouteDependencies(
            **{
                **deps.__dict__,
                "handle_watchdog": lambda _payload, _config: (_ for _ in ()).throw(FakeBridgeError("bad watchdog", 409)),
            }
        )

        http_routes.dispatch_post(
            handler,
            route="/mattermost/watchdog",
            content_type="application/json",
            raw=b"{}",
            authorization="Bearer token",
            config=object(),
            deps=deps,
        )

        self.assertEqual(handler.json_calls, [(409, {"ok": False, "text": "bad watchdog"})])

    def test_dispatch_post_run_uses_authenticated_handler(self):
        handler = FakeHandler()
        http_routes.dispatch_post(
            handler,
            route="/codex/run",
            content_type="application/json",
            raw=b"{}",
            authorization="Bearer token",
            config=object(),
            deps=make_deps(),
        )

        self.assertEqual(handler.json_calls, [(200, {"ok": True, "run": {"workspace": "demo"}})])

    def test_dispatch_post_run_trailing_slash_uses_authenticated_handler(self):
        handler = FakeHandler()
        http_routes.dispatch_post(
            handler,
            route="/codex/run/",
            content_type="application/json",
            raw=b"{}",
            authorization="Bearer token",
            config=object(),
            deps=make_deps(),
        )

        self.assertEqual(handler.json_calls, [(200, {"ok": True, "run": {"workspace": "demo"}})])


if __name__ == "__main__":
    unittest.main()
