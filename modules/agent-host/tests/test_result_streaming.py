import datetime as dt
import tempfile
import threading
import unittest
from pathlib import Path

import result_streaming


class ResultStreamingTests(unittest.TestCase):
    def test_issue_and_resolve_stream_token(self):
        now = dt.datetime(2026, 6, 17, 12, 0, 0, tzinfo=dt.timezone.utc)
        tokens: dict[str, dict[str, object]] = {}
        lock = threading.Lock()

        payload = result_streaming.issue_stream_token(
            "task_20260617_120000_stream",
            "chenma",
            "admin",
            tokens,
            lock,
            lambda: now,
            300,
        )

        token = payload["stream_token"]
        user, role = result_streaming.resolve_stream_principal(
            "task_20260617_120000_stream",
            token,
            tokens,
            lock,
            lambda: now,
            lambda message, status: ValueError(f"{status}:{message}"),
        )
        self.assertEqual(user, "chenma")
        self.assertEqual(role, "admin")

        with self.assertRaisesRegex(ValueError, "403:unauthorized: stream token is not valid for this task"):
            result_streaming.resolve_stream_principal(
                "task_20260617_130000_other",
                token,
                tokens,
                lock,
                lambda: now,
                lambda message, status: ValueError(f"{status}:{message}"),
            )

    def test_stream_task_events_emits_snapshot_log_result_and_done(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            task_dir = root / "task_20260617_120000_stream"
            task_dir.mkdir()
            (task_dir / "result.md").write_text("safe result")
            events: list[tuple[str, dict[str, object]]] = []

            def authorize_task(_config: object, _principal: object, _task_id: str) -> tuple[Path, dict[str, object]]:
                return task_dir, {
                    "task_id": "task_20260617_120000_stream",
                    "project": "demo",
                    "status": "done",
                    "created_at": "2026-06-17T12:00:00Z",
                    "started_at": "2026-06-17T12:00:05Z",
                    "updated_at": "2026-06-17T12:01:00Z",
                    "exit_code": 0,
                }

            deps = result_streaming.StreamLoopDependencies(
                authorize_task=authorize_task,
                safe_log_snapshot=lambda _config, _task_id: {
                    "text": "first log line\n",
                    "redacted": True,
                    "truncated": False,
                },
                has_safe_result=lambda path: (path / "result.md").exists(),
                send_sse_event=lambda event, payload: events.append((event, payload)),
                task_snapshot=lambda task: result_streaming.task_snapshot(task, lambda _task: None),
                remaining_seconds=lambda _task: None,
                utc_now=lambda: dt.datetime(2026, 6, 17, 12, 1, 0, tzinfo=dt.timezone.utc),
                monotonic=lambda: 100.0,
                sleep=lambda _seconds: None,
                final_statuses={"done", "failed"},
                heartbeat_seconds=15.0,
                poll_seconds=0.1,
                log_event_max_chars=8000,
            )

            result_streaming.stream_task_events(object(), "task_20260617_120000_stream", object(), deps)

        self.assertEqual([event for event, _payload in events], ["snapshot", "log", "result", "done"])
        self.assertEqual(events[0][1]["task_id"], "task_20260617_120000_stream")
        self.assertEqual(events[1][1]["text"], "first log line\n")
        self.assertTrue(events[2][1]["has_result"])
        self.assertEqual(events[3][1]["status"], "done")


if __name__ == "__main__":
    unittest.main()
