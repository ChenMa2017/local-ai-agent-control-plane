import datetime as dt
import json
import re
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

import intake_preparation
import prepare_flow


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

    def test_followup_guidance_from_draft_normalizes_remediation_context(self):
        guidance = prepare_flow.followup_guidance_from_draft(
            {
                "recommended_next_action": "review_result",
                "reason": "Task completed successfully; review the safe result before any promotion.",
                "remediation": {"category": "result_review", "subject": "task_result"},
                "evidence_retrieval_decision": "stale_conclusion",
                "requires_prepare": True,
                "claim_boundary": "Keep conclusions bounded until the cited files are reviewed.",
            }
        )

        self.assertEqual(guidance["recommended_next_action"], "review_result")
        self.assertEqual(guidance["remediation"], {"category": "result_review", "subject": "task_result"})
        self.assertEqual(guidance["evidence_retrieval_decision"], "stale_conclusion")
        self.assertTrue(guidance["requires_prepare"])

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
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "research" / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "schema_version": "research_program.v0.1",
                        "program_id": "demo-program",
                        "domain": {"name": "demo-domain", "allowed_project_areas": ["analysis"]},
                        "autonomy_policy": {"mode": "domain_bounded"},
                        "baseline_policy": {"required": True},
                        "conclusion_policy": {
                            "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
                            "publish_only_after_review": True,
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            intake_preparation.persist_intake_artifacts(
                config=config,
                project=config.projects["demo"],
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
            self.assertTrue((root / ".codex-bridge" / "intake" / intake_id / "OPERATOR_SUMMARY.json").exists())

        self.assertEqual(bundle["intake_id"], intake_id)
        self.assertEqual(bundle["intent"]["workspace"], "demo")
        self.assertEqual(bundle["contract"]["objective"], "report_only")
        self.assertEqual(bundle["taskbox"]["workspace_mode"], "readonly")
        self.assertEqual(bundle["research_program"]["program_id"], "demo-program")
        self.assertEqual(bundle["hypothesis_registry"]["registry_status"], "analysis_only")
        self.assertEqual(bundle["experiment_spec"]["status"], "not_required")

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
                "RESEARCH_PROGRAM.json": {"program_id": "demo-program", "available": True},
                "HYPOTHESIS_REGISTRY.json": {"registry_status": "analysis_only"},
                "EXPERIMENT_SPEC.json": {"status": "not_required"},
                "OPERATOR_SUMMARY.json": {"overall_status": "ready_to_run", "phase": "prepare"},
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
        self.assertEqual(response["research_program"]["program_id"], "demo-program")
        self.assertEqual(response["hypothesis_registry"]["registry_status"], "analysis_only")
        self.assertEqual(response["experiment_spec"]["status"], "not_required")
        self.assertEqual(response["operator_summary"]["overall_status"], "ready_to_run")

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
            (intake_root / "HYPOTHESIS_UPDATE.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "hypothesis_id": "hypothesis_demo"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "HYPOTHESIS_PROMOTION.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "promotion_state": "candidate_ready"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EXPERIMENT_RESULT.json").write_text(
                json.dumps(
                    {
                        "source_task_id": "task_20260617_follow01",
                        "experiment_id": "experiment_demo",
                        "result": "inconclusive",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EXPERIMENT_INDEX_UPDATE.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "experiment_id": "experiment_demo"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EXPERIMENT_PROMOTION.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "promotion_state": "candidate_ready"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "CURRENT_CONCLUSION_UPDATE.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "topic_id": "demo_topic"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "CURRENT_CONCLUSION_PROMOTION.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "promotion_state": "review_required"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVALUATION_REPORT.json").write_text(
                json.dumps({"task_id": "task_20260617_follow01", "summary": "ok"}, ensure_ascii=False, indent=2) + "\n"
            )
            (intake_root / "CURRENT_CONCLUSIONS.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "promotion_state": "review_required"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "OPERATOR_SUMMARY.json").write_text(
                json.dumps(
                    {"source_task_id": "task_20260617_follow01", "overall_status": "review_required"},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
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
        self.assertEqual(seed["hypothesis_update"]["hypothesis_id"], "hypothesis_demo")
        self.assertEqual(seed["hypothesis_promotion"]["promotion_state"], "candidate_ready")
        self.assertEqual(seed["experiment_result"]["experiment_id"], "experiment_demo")
        self.assertEqual(seed["experiment_index_update"]["experiment_id"], "experiment_demo")
        self.assertEqual(seed["experiment_promotion"]["promotion_state"], "candidate_ready")
        self.assertEqual(seed["current_conclusion_update"]["topic_id"], "demo_topic")
        self.assertEqual(seed["current_conclusion_promotion"]["promotion_state"], "review_required")
        self.assertEqual(seed["evaluation_report"]["task_id"], "task_20260617_follow01")
        self.assertEqual(seed["current_conclusions"]["promotion_state"], "review_required")
        self.assertEqual(seed["operator_summary"]["overall_status"], "review_required")
