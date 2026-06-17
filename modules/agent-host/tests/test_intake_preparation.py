import datetime as dt
import json
import re
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

import intake_preparation


PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
INTAKE_ID_RE = re.compile(r"^intake_[A-Za-z0-9_.-]+$")


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
    projects: dict[str, FakeProject]


@dataclass(frozen=True)
class FakePrincipal:
    user: str
    role: str = "admin"


class IntakePreparationTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def test_validate_codex_project_and_new_intake_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(root, {"demo": FakeProject("demo", root)})

            project = intake_preparation.validate_codex_project(
                config,
                "demo",
                project_name_re=PROJECT_NAME_RE,
                error_factory=self.error_factory,
            )
            intake_id = intake_preparation.new_intake_id(
                utc_now=lambda: dt.datetime(2026, 6, 17, 12, 0, tzinfo=dt.timezone.utc),
                token_hex_factory=lambda _size: "abc123",
            )

        self.assertEqual(project.name, "demo")
        self.assertEqual(intake_id, "intake_20260617_120000_abc123")

    def test_persist_and_load_prepared_run_context_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(root, {"demo": FakeProject("demo", root)})
            intake_id = "intake_20260617_demo01"
            intake_preparation.persist_intake_artifacts(
                config=config,
                intake_id=intake_id,
                intent={"workspace": "demo", "user": "chenma", "prompt": "hello"},
                gray_areas=["scope_missing"],
                questions=["Which file?"],
                contract={"intake_id": intake_id, "objective": "report_only", "status": "compiled", "experiment_decision_gate": {}},
                taskbox={"intake_id": intake_id, "status": "ready", "workspace_mode": "readonly"},
                preflight={"ok": False},
                evidence_retrieval={"required": False, "available": False, "consulted": False, "decision": None, "warnings": []},
                answers="constraints",
                event_type="intake_created",
                utc_now=lambda: dt.datetime(2026, 6, 17, 12, 0, tzinfo=dt.timezone.utc),
                intake_id_re=INTAKE_ID_RE,
                error_factory=self.error_factory,
            )

            bundle = intake_preparation.load_prepared_run_context(
                config,
                intake_id,
                FakePrincipal("chenma"),
                can_access_intake=lambda intent, principal: intent.get("user") == principal.user,
                intake_id_re=INTAKE_ID_RE,
                error_factory=self.error_factory,
            )

        self.assertEqual(bundle["intake_id"], intake_id)
        self.assertEqual(bundle["intent"]["workspace"], "demo")
        self.assertEqual(bundle["contract"]["objective"], "report_only")
        self.assertEqual(bundle["taskbox"]["workspace_mode"], "readonly")

    def test_handle_codex_intake_counts_events_and_ready_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(root, {"demo": FakeProject("demo", root)})
            intake_id = "intake_20260617_demo02"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True)
            for name, payload in {
                "INTENT_DRAFT.json": {"workspace": "demo", "user": "chenma"},
                "TASK_CONTRACT.json": {"objective": "report_only"},
                "TASKBOX_DRAFT.json": {"status": "ready"},
                "POLICY_PREFLIGHT.json": {"ok": True},
                "EVIDENCE_RETRIEVAL.json": {"required": False},
                "QUESTIONS.json": {"items": []},
            }.items():
                (intake_root / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            (intake_root / "TASK_INTAKE.events.jsonl").write_text('{"event":"a"}\n{"event":"b"}\n')

            response = intake_preparation.handle_codex_intake(
                {"intake_id": intake_id},
                config,
                FakePrincipal("chenma"),
                deps=intake_preparation.IntakePreparationDependencies(
                    utc_now=lambda: dt.datetime(2026, 6, 17, 12, 0, tzinfo=dt.timezone.utc),
                    reject_frontend_identity=lambda _payload: None,
                    can_access_intake=lambda intent, principal: intent.get("user") == principal.user,
                    validate_task_id=lambda task_id: task_id,
                    authorize_task=lambda _config, _principal, _task_id: (Path("."), {}),
                    task_intake_id=lambda _task: "",
                    safe_adapter_source=lambda value: value,
                    prompt_preview=lambda value: str(value),
                    project_name_re=PROJECT_NAME_RE,
                    error_factory=self.error_factory,
                ),
                intake_id_re=INTAKE_ID_RE,
            )

        self.assertTrue(response["ok"])
        self.assertEqual(response["event_count"], 2)
        self.assertTrue(response["ready_to_run"])

    def test_load_followup_prepare_seed_filters_mismatched_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = FakeConfig(root, {"demo": FakeProject("demo", root)})
            intake_id = "intake_20260617_demo03"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True)
            (intake_root / "FOLLOWUP_TASK_DRAFT.json").write_text(
                json.dumps({"source_task_id": "task_20260617_follow01", "workspace": "demo"}, ensure_ascii=False, indent=2) + "\n"
            )
            (intake_root / "EXECUTION_EVALUATION.json").write_text(
                json.dumps({"task_id": "task_20260617_follow01", "execution_decision": "ok"}, ensure_ascii=False, indent=2) + "\n"
            )
            (intake_root / "LEDGER_NOTE_DRAFT.json").write_text(
                json.dumps({"source_task_id": "other_task", "note": "ignore"}, ensure_ascii=False, indent=2) + "\n"
            )

            seed = intake_preparation.load_followup_prepare_seed(
                config,
                "task_20260617_follow01",
                FakePrincipal("chenma"),
                authorize_task=lambda _config, _principal, task_id: (
                    Path("."),
                    {"task_id": task_id, "project": "demo", "adapter_metadata": {"intake_id": intake_id}},
                ),
                task_intake_id=lambda task: str((task.get("adapter_metadata") or {}).get("intake_id") or ""),
                intake_id_re=INTAKE_ID_RE,
                error_factory=self.error_factory,
            )

        self.assertEqual(seed["source_intake_id"], intake_id)
        self.assertEqual(seed["execution_evaluation"]["task_id"], "task_20260617_follow01")
        self.assertEqual(seed["ledger_note_draft"], {})
