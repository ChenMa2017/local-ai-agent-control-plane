import datetime as dt
import json
import re
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

import codex_tasking


TASK_ID_RE = re.compile(r"^task_[A-Za-z0-9_.-]+$")
INTAKE_ID_RE = re.compile(r"^intake_[A-Za-z0-9_.-]+$")


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class FakePrincipal:
    user: str
    role: str = "user"


@dataclass(frozen=True)
class FakeProject:
    name: str
    root: Path


@dataclass(frozen=True)
class FakeConfig:
    codex_bridge_root: Path
    projects: dict[str, FakeProject]


class CodexTaskingTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def write_task(
        self,
        root: Path,
        task_id: str,
        *,
        user: str = "chenma",
        project: str = "demo",
        status: str = "done",
        prompt: str = "hello",
        updated_at: str = "2026-06-17T12:01:00Z",
        adapter_metadata: dict | str | None = None,
    ) -> Path:
        task_dir = root / ".codex-bridge" / "tasks" / task_id
        task_dir.mkdir(parents=True)
        task = {
            "task_id": task_id,
            "user": user,
            "project": project,
            "status": status,
            "prompt": prompt,
            "created_at": "2026-06-17T12:00:00Z",
            "updated_at": updated_at,
            "source": "web",
            "mode": "readonly",
        }
        if adapter_metadata is not None:
            task["adapter_metadata"] = adapter_metadata
        (task_dir / "task.json").write_text(json.dumps(task, ensure_ascii=False, indent=2))
        (task_dir / "result.md").write_text("result")
        (task_dir / "bridge.log").write_text("log")
        return task_dir

    def test_read_visible_task_summaries_filters_owner_and_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(root, {"demo": FakeProject("demo", root)})
            self.write_task(root, "task_20260617_120000_a", user="chenma", updated_at="2026-06-17T12:01:00Z")
            self.write_task(root, "task_20260617_130000_b", user="alice", updated_at="2026-06-17T13:01:00Z")

            items = codex_tasking.read_visible_task_summaries(
                config,
                FakePrincipal("chenma", "user"),
                can_access_task=lambda task, principal: task.get("user") == principal.user or principal.role == "admin",
                task_id_re=TASK_ID_RE,
                utc_now=lambda: dt.datetime(2026, 6, 17, 14, 0, tzinfo=dt.timezone.utc),
                prompt_preview_chars=40,
            )

        self.assertEqual([item["task_id"] for item in items], ["task_20260617_120000_a"])
        self.assertNotIn("adapter_metadata", items[0])

    def test_handle_codex_tasks_validates_filters_and_returns_summaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(root, {"demo": FakeProject("demo", root)})
            self.write_task(root, "task_20260617_120000_a", status="running", prompt="one " * 40)

            response = codex_tasking.handle_codex_tasks(
                {"limit": "5", "status": "running", "project": "demo"},
                config,
                FakePrincipal("chenma", "admin"),
                deps=codex_tasking.CodexTaskListDependencies(
                    reject_frontend_identity=lambda _payload: None,
                    validate_project=lambda _config, project: project,
                    reconcile_tasks=lambda _config: None,
                    can_access_task=lambda _task, _principal: True,
                    utc_now=lambda: dt.datetime(2026, 6, 17, 14, 0, tzinfo=dt.timezone.utc),
                    error_factory=self.error_factory,
                ),
                task_id_re=TASK_ID_RE,
                default_limit=50,
                max_limit=200,
                prompt_preview_chars=32,
            )

        self.assertTrue(response["ok"])
        self.assertEqual(len(response["tasks"]), 1)
        self.assertEqual(response["tasks"][0]["status"], "running")
        self.assertLessEqual(len(response["tasks"][0]["prompt_preview"]), 32)

    def test_task_intake_id_accepts_json_string_metadata(self):
        intake_id = codex_tasking.task_intake_id(
            {"adapter_metadata": '{"intake_id":"intake_20260617_demo"}'},
            intake_id_re=INTAKE_ID_RE,
        )

        self.assertEqual(intake_id, "intake_20260617_demo")

    def test_handle_codex_query_rejects_raw_for_non_admin(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            codex_tasking.handle_codex_query(
                {"task_id": "task_20260617_120000_a", "raw": "true"},
                object(),
                "result",
                FakePrincipal("chenma", "user"),
                deps=codex_tasking.CodexTaskQueryDependencies(
                    reject_frontend_identity=lambda _payload: None,
                    authorize_task=lambda _config, _principal, _task_id: (Path("."), {"status": "done"}),
                    bool_from_payload=lambda value: value == "true",
                    is_admin=lambda principal: principal.role == "admin",
                    run_codex_bridge=lambda _config, _args: object(),
                    require_success=lambda _result: "{}",
                    task_intake_id=lambda _task: "",
                    attach_execution_evaluation=lambda _config, _task_dir, _task, _rendered: {},
                    safe_status_text=lambda _config, _task, text: text,
                    error_factory=self.error_factory,
                ),
                task_id_re=TASK_ID_RE,
                final_statuses={"done", "failed"},
            )

        self.assertEqual(ctx.exception.status, 403)

    def test_handle_codex_query_attaches_evaluation_and_intake(self):
        with tempfile.TemporaryDirectory() as tmp:
            task_dir = Path(tmp)
            response = codex_tasking.handle_codex_query(
                {"task_id": "task_20260617_120000_a"},
                object(),
                "result",
                FakePrincipal("chenma", "admin"),
                deps=codex_tasking.CodexTaskQueryDependencies(
                    reject_frontend_identity=lambda _payload: None,
                    authorize_task=lambda _config, _principal, task_id: (
                        task_dir,
                        {"task_id": task_id, "status": "done", "adapter_metadata": {"intake_id": "intake_20260617_demo"}},
                    ),
                    bool_from_payload=lambda value: value == "true",
                    is_admin=lambda principal: principal.role == "admin",
                    run_codex_bridge=lambda _config, _args: object(),
                    require_success=lambda _result: json.dumps({"text": "safe result", "raw": False, "redacted": True}),
                    task_intake_id=lambda task: codex_tasking.task_intake_id(
                        task,
                        intake_id_re=INTAKE_ID_RE,
                    ),
                    attach_execution_evaluation=lambda _config, _task_dir, _task, _rendered: {
                        "execution_evaluation": {"execution_decision": "result_ready_for_review"}
                    },
                    safe_status_text=lambda _config, _task, text: text,
                    error_factory=self.error_factory,
                ),
                task_id_re=TASK_ID_RE,
                final_statuses={"done", "failed"},
            )

        self.assertTrue(response["ok"])
        self.assertEqual(response["intake_id"], "intake_20260617_demo")
        self.assertEqual(response["execution_evaluation"]["execution_decision"], "result_ready_for_review")
