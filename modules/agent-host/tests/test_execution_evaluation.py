import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import execution_evaluation


class ExecutionEvaluationTests(unittest.TestCase):
    def make_deps(self, root: Path) -> execution_evaluation.ExecutionEvaluationDependencies:
        def utc_now() -> dt.datetime:
            return dt.datetime(2026, 6, 17, 12, 0, 0, tzinfo=dt.timezone.utc)

        def intake_dir(_config: object, intake_id: str) -> Path:
            return root / ".codex-bridge" / "intake" / intake_id

        def read_json_object_if_exists(path: Path) -> dict[str, object]:
            if not path.exists():
                return {}
            return json.loads(path.read_text())

        def write_json_atomic(path: Path, data: dict[str, object]) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

        def write_text_atomic(path: Path, text: str) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

        def append_jsonl(path: Path, event: dict[str, object]) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")

        def task_intake_id(task: dict[str, object]) -> str:
            metadata = task.get("adapter_metadata")
            if not isinstance(metadata, dict):
                return ""
            return str(metadata.get("intake_id") or "")

        return execution_evaluation.ExecutionEvaluationDependencies(
            utc_now=utc_now,
            intake_dir=intake_dir,
            read_json_object_if_exists=read_json_object_if_exists,
            write_json_atomic=write_json_atomic,
            write_text_atomic=write_text_atomic,
            append_jsonl=append_jsonl,
            task_intake_id=task_intake_id,
        )

    def test_build_execution_evaluation_warns_when_prepare_artifacts_are_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            evaluation = execution_evaluation.build_execution_evaluation(
                object(),
                root / "task_20260617_120000_missing",
                {
                    "task_id": "task_20260617_120000_missing",
                    "project": "demo",
                    "status": "done",
                    "mode": "readonly",
                    "adapter_metadata": {"intake_id": "intake_missing"},
                },
                {"text": "safe result summary"},
                deps,
            )

        self.assertEqual(evaluation["intake_id"], "intake_missing")
        self.assertTrue(evaluation["result_available"])
        self.assertIn("Prepared intake artifacts are missing", evaluation["warnings"][-1])

    def test_maybe_attach_execution_evaluation_persists_artifacts_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            intake_id = "intake_eval"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "report_only",
                        "mode": "readonly",
                        "prompt": "What is the current best candidate?",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "decision": "stale_conclusion",
                        "read_plan": [
                            {"path": "formal/current_best.md", "reason": "primary source"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )

            task = {
                "task_id": "task_20260617_120000_eval",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            result_data = {"text": "safe result summary"}
            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                object(),
                root / "task_20260617_120000_eval",
                task,
                result_data,
                deps,
            )
            repeat = execution_evaluation.maybe_attach_execution_evaluation(
                object(),
                root / "task_20260617_120000_eval",
                task,
                result_data,
                deps,
            )
            self.assertEqual(attachments["execution_evaluation"]["execution_decision"], "result_ready_for_review")
            self.assertEqual(attachments["followup_task_draft"]["recommended_next_action"], "review_result")
            self.assertEqual(attachments["ledger_note_draft"]["source_task_id"], "task_20260617_120000_eval")
            self.assertEqual(attachments["review_proposal_draft"]["review_scope"], "report_only")
            self.assertEqual(repeat["execution_evaluation"]["task_id"], "task_20260617_120000_eval")
            self.assertTrue((intake_root / "EXECUTION_EVALUATION.json").exists())
            self.assertTrue((intake_root / "FOLLOWUP_TASK_DRAFT.json").exists())
            self.assertTrue((intake_root / "LEDGER_NOTE_DRAFT.json").exists())
            self.assertTrue((intake_root / "REVIEW_PROPOSAL_DRAFT.json").exists())
            events = [
                json.loads(line)
                for line in (intake_root / "TASK_INTAKE.events.jsonl").read_text().strip().splitlines()
            ]
            self.assertEqual(len(events), 4)
            self.assertEqual(events[0]["event"], "execution_evaluated")
            self.assertEqual(events[-1]["event"], "review_proposal_drafted")


if __name__ == "__main__":
    unittest.main()
