import json
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from agent_host.runtime import codex_bridge_runtime


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class FakeProject:
    name: str
    root: Path
    default_mode: str = "readonly"
    allowed_modes: tuple[str, ...] = ("readonly",)


@dataclass(frozen=True)
class FakeConfig:
    codex_bridge_root: Path
    codex_bridge_node_bin: str
    allowed_users: tuple[str, ...]
    projects: dict[str, FakeProject]


class CodexBridgeRuntimeTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def test_write_codex_bridge_config_mirrors_projects_and_users(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                allowed_users=("chenma",),
                projects={
                    "demo": FakeProject(name="demo", root=root / "demo"),
                },
            )

            out = codex_bridge_runtime.write_codex_bridge_config(config)
            data = json.loads(out.read_text())

        self.assertEqual(data["users"], ["chenma"])
        self.assertIn("demo", data["projects"])
        self.assertEqual(data["projects"]["demo"]["mode"], "readonly")
        self.assertEqual(data["projects"]["demo"]["allowedModes"], ["readonly"])
        self.assertTrue(data["redaction"]["enabled"])

    def test_bool_from_payload_and_parse_queued_task_id(self):
        self.assertTrue(codex_bridge_runtime.bool_from_payload("true"))
        self.assertFalse(codex_bridge_runtime.bool_from_payload("0"))
        task_id = codex_bridge_runtime.parse_queued_task_id(
            "hello\nqueued task_20260618_120000_demo01\n",
            error_factory=self.error_factory,
        )
        self.assertEqual(task_id, "task_20260618_120000_demo01")

    def test_require_success_returns_stdout_or_raises(self):
        ok = subprocess.CompletedProcess(args=["demo"], returncode=0, stdout="queued task_1\n", stderr="")
        self.assertEqual(
            codex_bridge_runtime.require_success(ok, error_factory=self.error_factory),
            "queued task_1",
        )

        failed = subprocess.CompletedProcess(args=["demo"], returncode=1, stdout="", stderr="boom")
        with self.assertRaises(FakeBridgeError) as ctx:
            codex_bridge_runtime.require_success(failed, error_factory=self.error_factory)
        self.assertEqual(ctx.exception.status, 500)

    def test_reconcile_codex_tasks_is_noop_when_script_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                allowed_users=(),
                projects={},
            )
            seen: list[str] = []

            codex_bridge_runtime.reconcile_codex_tasks(
                config,
                run_bridge=lambda _config, _args, _timeout: seen.append("called"),  # type: ignore[return-value]
                error_factory=self.error_factory,
            )

        self.assertEqual(seen, [])
