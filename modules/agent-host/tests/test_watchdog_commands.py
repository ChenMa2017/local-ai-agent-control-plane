import datetime as dt
import json
import os
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from agent_host.runtime import watchdog_commands


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class FakeProject:
    name: str
    root: Path


class WatchdogCommandsTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def payload(self, text: str = "") -> dict[str, str]:
        return {
            "team_id": "t1",
            "channel_id": "c1",
            "channel_name": "codex-control",
            "user_id": "u1",
            "user_name": "chenma",
            "command": "/watchdog",
            "text": text,
        }

    def test_get_project_requires_project_when_multiple_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            root.mkdir(exist_ok=True)
            projects = {
                "a": FakeProject("a", root),
                "b": FakeProject("b", root),
            }
            with self.assertRaises(FakeBridgeError) as ctx:
                watchdog_commands.get_project(
                    None,
                    projects=projects,
                    error_factory=self.error_factory,
                )

        self.assertEqual(ctx.exception.status, 400)

    def test_parse_project_token_supports_project_prefix(self):
        project, rest = watchdog_commands.parse_project_token(["task", "project=demo", "analyze", "logs"])

        self.assertEqual(project, "demo")
        self.assertEqual(rest, ["analyze", "logs"])

    def test_brief_text_falls_back_to_latest_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            latest = root / "agent" / "reports" / "latest.md"
            latest.parent.mkdir(parents=True)
            latest.write_text("# Latest\nready\n")

            text = watchdog_commands.brief_text(FakeProject("demo", root))

        self.assertIn("Latest report for `demo`", text)
        self.assertIn("# Latest", text)

    def test_inbox_text_lists_most_recent_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inbox = root / "agent" / "inbox"
            inbox.mkdir(parents=True)
            newer = inbox / "002.json"
            older = inbox / "001.json"
            older.write_text("{}\n")
            newer.write_text("{}\n")
            os.utime(older, (1000, 1000))
            os.utime(newer, (2000, 2000))

            text = watchdog_commands.inbox_text(FakeProject("demo", root))

        self.assertIn("Latest inbox items for `demo`", text)
        self.assertLess(text.index("002.json"), text.index("001.json"))

    def test_write_task_persists_json_without_running_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = FakeProject("demo", root)
            task_id, out = watchdog_commands.write_task(
                project,
                self.payload("task demo inspect queue"),
                "inspect queue",
                "task_request",
                now=dt.datetime(2026, 6, 17, 12, 0, tzinfo=dt.timezone.utc),
                task_id_suffix_factory=lambda: "fixed1234",
                error_factory=self.error_factory,
            )

            task = json.loads(out.read_text())

        self.assertEqual(task_id, "20260617T120000Z_fixed1234")
        self.assertEqual(task["project"], "demo")
        self.assertEqual(task["request"], "inspect queue")
        self.assertFalse(task["safety"]["bridge_executed_shell"])
        self.assertEqual(task["safety"]["bridge_modified_project_files"], [f"agent/inbox/{out.name}"])

    def test_help_text_includes_project_names(self):
        text = watchdog_commands.help_text(["beta", "alpha"])

        self.assertIn("Projects: alpha, beta", text)


if __name__ == "__main__":
    unittest.main()
