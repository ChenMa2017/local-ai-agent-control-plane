import datetime as dt
import json
import tempfile
import threading
import unittest
from dataclasses import dataclass
from pathlib import Path

import codex_runtime
import result_streaming


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class FakePrincipal:
    user: str
    role: str = "admin"


@dataclass(frozen=True)
class FakeProject:
    name: str
    root: Path
    default_mode: str = "readonly"
    allowed_modes: tuple[str, ...] = ("readonly",)


class CodexRuntimeTests(unittest.TestCase):
    def error_factory(self, message: str, status: int, code: str | None) -> FakeBridgeError:
        return FakeBridgeError(message, status, code)

    def test_handle_codex_run_records_intake_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            intake_root = root / "intake_demo"
            principal = FakePrincipal("chenma", "admin")
            project = FakeProject("demo", root)
            response = codex_runtime.handle_codex_run(
                {"workspace": "demo", "intake_id": "intake_demo"},
                object(),
                principal,
                deps=codex_runtime.CodexRunDependencies(
                    reject_frontend_identity=lambda _payload: None,
                    validate_intake_id=lambda intake_id: intake_id,
                    load_prepared_run_context=lambda _config, intake_id, _principal: {
                        "intake_id": intake_id,
                        "intent": {"workspace": "demo"},
                        "contract": {"mode": "readonly"},
                        "taskbox": {"status": "ready", "workspace_mode": "readonly"},
                        "preflight": {"ok": True},
                        "evidence_retrieval": {"decision": "stale_conclusion"},
                    },
                    prepared_run_summary=lambda _bundle: {
                        "objective": "report_only",
                        "workspace_mode": "readonly",
                        "evidence_retrieval_decision": "stale_conclusion",
                    },
                    safe_intake_text=lambda text, _max_chars: text.strip(),
                    validate_project=lambda _config, _project: project,
                    safe_adapter_source=lambda value: value or "web",
                    safe_idempotency_key=lambda value: value,
                    parse_adapter_metadata=lambda _value: {},
                    validate_task_id=lambda value: value,
                    authorize_task=lambda _config, _principal, _task_id: (Path("."), {}),
                    prepared_run_prompt=lambda _bundle, _note, _safe_text, _max_chars: "prepared prompt",
                    compact_adapter_metadata_object=lambda data: json.dumps(data, ensure_ascii=False, separators=(",", ":")) if data else "",
                    bool_from_payload=lambda value: value.lower() in {"1", "true", "yes", "on"},
                    run_codex_bridge=lambda _config, _args: "queued task_20260618_120000_demo01",
                    require_success=lambda output: output,
                    parse_queued_task_id=lambda _output: "task_20260618_120000_demo01",
                    parse_run_receipt=lambda _output: {"idempotent_replay": False},
                    append_jsonl=lambda path, event: path.parent.mkdir(parents=True, exist_ok=True)
                    or path.write_text(
                        ((path.read_text() if path.exists() else "") + json.dumps(event, ensure_ascii=False) + "\n"),
                        encoding="utf-8",
                    ),
                    intake_dir=lambda _config, _intake_id: intake_root,
                    utc_now=lambda: dt.datetime(2026, 6, 18, 12, 0, tzinfo=dt.timezone.utc),
                    error_factory=self.error_factory,
                ),
                max_task_chars=4000,
            )

            events = (intake_root / "TASK_INTAKE.events.jsonl").read_text().strip().splitlines()

        self.assertTrue(response["ok"])
        self.assertEqual(response["task_id"], "task_20260618_120000_demo01")
        self.assertEqual(response["intake_id"], "intake_demo")
        self.assertEqual(response["prepare_context"]["objective"], "report_only")
        self.assertTrue(any(json.loads(line).get("event") == "run_queued" for line in events))

    def test_handle_codex_run_rejects_non_runnable_prepare(self):
        principal = FakePrincipal("chenma", "admin")
        with self.assertRaises(FakeBridgeError) as ctx:
            codex_runtime.handle_codex_run(
                {"workspace": "demo", "intake_id": "intake_demo"},
                object(),
                principal,
                deps=codex_runtime.CodexRunDependencies(
                    reject_frontend_identity=lambda _payload: None,
                    validate_intake_id=lambda intake_id: intake_id,
                    load_prepared_run_context=lambda _config, intake_id, _principal: {
                        "intake_id": intake_id,
                        "intent": {"workspace": "demo"},
                        "contract": {"mode": "readonly"},
                        "taskbox": {"status": "blocked"},
                        "preflight": {"ok": False, "required_action": "reply_to_questions", "reasons": ["need scope"]},
                        "evidence_retrieval": {},
                    },
                    prepared_run_summary=lambda _bundle: {},
                    safe_intake_text=lambda text, _max_chars: text.strip(),
                    validate_project=lambda _config, _project: FakeProject("demo", Path(".")),
                    safe_adapter_source=lambda value: value or "web",
                    safe_idempotency_key=lambda value: value,
                    parse_adapter_metadata=lambda _value: {},
                    validate_task_id=lambda value: value,
                    authorize_task=lambda _config, _principal, _task_id: (Path("."), {}),
                    prepared_run_prompt=lambda _bundle, _note, _safe_text, _max_chars: "prepared prompt",
                    compact_adapter_metadata_object=lambda _data: "",
                    bool_from_payload=lambda _value: False,
                    run_codex_bridge=lambda _config, _args: "",
                    require_success=lambda output: output,
                    parse_queued_task_id=lambda _output: "",
                    parse_run_receipt=lambda _output: {"idempotent_replay": False},
                    append_jsonl=lambda _path, _event: None,
                    intake_dir=lambda _config, _intake_id: Path("."),
                    utc_now=lambda: dt.datetime(2026, 6, 18, 12, 0, tzinfo=dt.timezone.utc),
                    error_factory=self.error_factory,
                ),
                max_task_chars=4000,
            )

        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.code, "prepare_not_runnable")

    def test_handle_codex_result_page_rejects_raw_output(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            codex_runtime.handle_codex_result_page(
                {"task_id": "task_1"},
                object(),
                FakePrincipal("chenma"),
                deps=codex_runtime.ResultPageDependencies(
                    handle_codex_query=lambda _payload, _config, _command, _principal: {"raw": True, "text": "abc"},
                    error_factory=self.error_factory,
                ),
                default_page_size=10,
                max_page_size=50,
            )

        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, "permission_denied")

    def test_stream_token_issue_and_resolution_round_trip(self):
        tokens: dict[str, dict[str, object]] = {}
        lock = threading.Lock()
        now = dt.datetime(2026, 6, 18, 12, 0, tzinfo=dt.timezone.utc)
        response = codex_runtime.handle_stream_token(
            {"task_id": "task_20260618_120000_demo01"},
            object(),
            FakePrincipal("chenma", "admin"),
            deps=codex_runtime.StreamTokenDependencies(
                reject_frontend_identity=lambda _payload: None,
                validate_task_id=lambda value: value,
                authorize_task=lambda _config, _principal, _task_id: (Path("."), {}),
                cleanup_stream_tokens=lambda: result_streaming.cleanup_stream_tokens(tokens, lock, lambda: now),
                issue_stream_token=lambda task_id, user, role: result_streaming.issue_stream_token(
                    task_id,
                    user,
                    role,
                    tokens,
                    lock,
                    lambda: now,
                    300,
                ),
                resolve_stream_principal=lambda task_id, stream_token: result_streaming.resolve_stream_principal(
                    task_id,
                    stream_token,
                    tokens,
                    lock,
                    lambda: now,
                    lambda message, status: FakeBridgeError(message, status),
                ),
            ),
        )

        user, role = codex_runtime.principal_from_stream_token(
            "task_20260618_120000_demo01",
            response["stream_token"],
            resolve_stream_principal=lambda task_id, stream_token: result_streaming.resolve_stream_principal(
                task_id,
                stream_token,
                tokens,
                lock,
                lambda: now,
                lambda message, status: FakeBridgeError(message, status),
            ),
        )

        self.assertTrue(response["ok"])
        self.assertEqual(user, "chenma")
        self.assertEqual(role, "admin")
