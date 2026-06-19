import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import execution_evaluation


class ExecutionEvaluationTests(unittest.TestCase):
    class Config:
        def __init__(self, root: Path):
            self.projects = {
                "demo": type("Project", (), {"root": root})(),
            }

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
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "program_id": "demo-program",
                        "available": True,
                        "publish_only_after_review": True,
                        "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
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
            self.assertEqual(
                attachments["followup_task_draft"]["provenance"]["artifact_role"],
                "followup_task_draft",
            )
            self.assertEqual(
                attachments["followup_task_draft"]["provenance"]["repair_origin"],
                "execution_evaluation.followup_task_draft",
            )
            self.assertEqual(
                attachments["ledger_note_draft"]["provenance"]["artifact_role"],
                "ledger_note_draft",
            )
            self.assertEqual(
                attachments["review_proposal_draft"]["provenance"]["artifact_role"],
                "review_proposal_draft",
            )
            self.assertEqual(
                attachments["review_proposal_draft"]["provenance"]["generated_by"],
                "agent_host_post_run_artifacts",
            )
            self.assertEqual(
                attachments["followup_task_draft"]["provenance"]["source"],
                "system_derived",
            )
            self.assertEqual(
                attachments["followup_task_draft"]["provenance"]["derivation_kind"],
                "post_run_evaluation",
            )
            self.assertFalse(attachments["followup_task_draft"]["provenance"]["fallback_synthesized"])
            self.assertEqual(attachments["hypothesis_promotion"]["promotion_state"], "not_required")
            self.assertEqual(attachments["hypothesis_promotion"]["project_sync"]["status"], "workspace_unavailable")
            self.assertEqual(attachments["experiment_promotion"]["promotion_state"], "not_required")
            self.assertEqual(attachments["experiment_promotion"]["project_sync"]["status"], "workspace_unavailable")
            self.assertEqual(attachments["current_conclusion_update"]["conclusion_status"], "auxiliary_only")
            self.assertEqual(attachments["current_conclusion_promotion"]["decision"], "bounded_only_do_not_publish")
            self.assertEqual(attachments["current_conclusion_promotion"]["project_sync"]["status"], "workspace_unavailable")
            self.assertEqual(attachments["evaluation_report"]["hypothesis_promotion_state"], "not_required")
            self.assertEqual(attachments["evaluation_report"]["experiment_promotion_state"], "not_required")
            self.assertEqual(attachments["evaluation_report"]["current_conclusions_promotion_state"], "bounded_only")
            self.assertEqual(attachments["evaluation_report"]["assessment_basis"], "structural_only")
            self.assertEqual(attachments["evaluation_report"]["validity"]["status"], "valid_with_limitations")
            self.assertFalse(attachments["evaluation_report"]["machine_checks"]["evidence_safe_to_answer"])
            self.assertEqual(attachments["evaluation_report"]["conclusion_assessment"]["assessment"], "bounded_only")
            self.assertEqual(attachments["current_conclusions"]["promotion_state"], "bounded_only")
            self.assertEqual(attachments["operator_summary"]["phase"], "post_run")
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertEqual(attachments["operator_summary"]["next_safe_action"]["kind"], "resolve_review_proposal")
            self.assertEqual(
                attachments["operator_summary"]["next_safe_action"]["target_path"],
                "research/proposals/current_conclusions/",
            )
            self.assertIn(
                "current conclusion reuse remains bounded",
                attachments["operator_summary"]["operator_message"],
            )
            self.assertEqual(repeat["execution_evaluation"]["task_id"], "task_20260617_120000_eval")
            self.assertTrue((intake_root / "EXECUTION_EVALUATION.json").exists())
            self.assertTrue((intake_root / "FOLLOWUP_TASK_DRAFT.json").exists())
            self.assertTrue((intake_root / "LEDGER_NOTE_DRAFT.json").exists())
            self.assertTrue((intake_root / "REVIEW_PROPOSAL_DRAFT.json").exists())
            self.assertTrue((intake_root / "HYPOTHESIS_PROMOTION.json").exists())
            self.assertTrue((intake_root / "EXPERIMENT_PROMOTION.json").exists())
            self.assertTrue((intake_root / "CURRENT_CONCLUSION_UPDATE.json").exists())
            self.assertTrue((intake_root / "CURRENT_CONCLUSION_PROMOTION.json").exists())
            self.assertTrue((intake_root / "EVALUATION_REPORT.json").exists())
            self.assertTrue((intake_root / "CURRENT_CONCLUSIONS.json").exists())
            self.assertTrue((intake_root / "OPERATOR_SUMMARY.json").exists())
            events = [
                json.loads(line)
                for line in (intake_root / "TASK_INTAKE.events.jsonl").read_text().strip().splitlines()
            ]
            event_names = [item["event"] for item in events]
            self.assertEqual(len(events), 10)
            self.assertEqual(event_names[0], "execution_evaluated")
            self.assertIn("hypothesis_promotion_updated", event_names)
            self.assertIn("experiment_promotion_updated", event_names)
            self.assertIn("current_conclusion_update_drafted", event_names)
            self.assertIn("evaluation_report_persisted", event_names)
            self.assertIn("current_conclusions_updated", event_names)
            self.assertEqual(event_names[-1], "current_conclusion_promotion_updated")
            followup_events = [item for item in events if item["event"] == "followup_task_drafted"]
            ledger_events = [item for item in events if item["event"] == "ledger_note_drafted"]
            review_events = [item for item in events if item["event"] == "review_proposal_drafted"]
            self.assertEqual(followup_events[0]["artifact_provenance_source"], "system_derived")
            self.assertEqual(followup_events[0]["artifact_generated_by"], "agent_host_post_run_artifacts")
            self.assertEqual(ledger_events[0]["artifact_repair_origin"], "execution_evaluation.ledger_note_draft")
            self.assertEqual(review_events[0]["artifact_repair_origin"], "execution_evaluation.review_proposal_draft")

    def test_maybe_attach_execution_evaluation_applies_project_current_conclusions_when_candidate_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_apply"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "report_only",
                        "mode": "readonly",
                        "prompt": "What is the current best candidate?",
                        "summary": "Current best candidate status",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "What is the current best candidate?",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/current_best.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "current_best_candidate", "score": 6.0}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "program_id": "demo-program",
                        "available": True,
                        "publish_only_after_review": False,
                        "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260618_120000_apply",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            result_data = {"text": "The current best candidate remains model A under the protected evaluation contract."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                root / "task_20260618_120000_apply",
                task,
                result_data,
                deps,
            )

            promotion = attachments["current_conclusion_promotion"]
            self.assertEqual(promotion["promotion_state"], "candidate_ready")
            self.assertEqual(promotion["project_sync"]["status"], "applied")
            current_conclusions_path = root / "project_index" / "current_conclusions.json"
            self.assertTrue(current_conclusions_path.exists())
            current_conclusions = json.loads(current_conclusions_path.read_text())
            self.assertEqual(current_conclusions["schema_version"], "current_conclusions.v0.1")
            self.assertEqual(current_conclusions["items"][0]["topic_id"], "current_best_candidate")
            self.assertEqual(current_conclusions["items"][0]["conclusion_status"], "tentative")

    def test_maybe_attach_execution_evaluation_applies_project_experiment_index_when_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_apply"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU latency probe and summarize the outcome.",
                        "summary": "Bounded CPU latency probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu latency probe status",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/latency_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "latency_probe_status", "score": 6.0}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "program_id": "demo-program",
                        "available": True,
                        "publish_only_after_review": False,
                        "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
                        "program": {
                            "baseline_policy": {
                                "baseline_entities": ["latency_baseline_v1"],
                            }
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "HYPOTHESIS_REGISTRY.json").write_text(
                json.dumps(
                    {
                        "registry_status": "active",
                        "hypotheses": [
                            {"hypothesis_id": "hypothesis_latency_probe", "summary": "Latency can be reduced"}
                        ]
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    {
                        "required": True,
                        "objective": "bounded_cpu_eval",
                        "task_type": "bounded_execution",
                        "hypothesis_ids": ["hypothesis_latency_probe"],
                        "experiment_id": "experiment_latency_probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260618_120000_expapply",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            result_data = {"text": "Latency stayed within the bounded target during the CPU probe."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                root / "task_20260618_120000_expapply",
                task,
                result_data,
                deps,
            )

            experiment_update = attachments["experiment_index_update"]
            experiment_promotion = attachments["experiment_promotion"]
            hypothesis_update = attachments["hypothesis_update"]
            hypothesis_promotion = attachments["hypothesis_promotion"]
            self.assertEqual(hypothesis_update["hypothesis_id"], "hypothesis_latency_probe")
            self.assertEqual(hypothesis_update["status"], "active")
            self.assertEqual(hypothesis_promotion["promotion_state"], "candidate_ready")
            self.assertEqual(hypothesis_promotion["project_sync"]["status"], "applied")
            self.assertEqual(hypothesis_promotion["project_sync"]["transition_validation"]["status"], "valid")
            self.assertEqual(experiment_update["experiment_id"], "experiment_latency_probe")
            self.assertEqual(experiment_update["status"], "draft")
            self.assertEqual(experiment_promotion["promotion_state"], "candidate_ready")
            self.assertEqual(experiment_promotion["project_sync"]["status"], "applied")
            self.assertEqual(experiment_promotion["project_sync"]["transition_validation"]["status"], "valid")
            self.assertEqual(attachments["evaluation_report"]["hypothesis_promotion_state"], "candidate_ready")
            self.assertEqual(attachments["evaluation_report"]["experiment_promotion_state"], "candidate_ready")
            self.assertEqual(attachments["evaluation_report"]["validity"]["status"], "valid_structural_only")
            self.assertEqual(attachments["evaluation_report"]["hypothesis_assessment"]["assessment"], "active_candidate")
            self.assertEqual(attachments["evaluation_report"]["experiment_assessment"]["assessment"], "candidate_recorded")
            self.assertEqual(attachments["evaluation_report"]["conclusion_assessment"]["assessment"], "candidate_ready")
            self.assertEqual(attachments["operator_summary"]["overall_status"], "promotion_ready")
            self.assertEqual(attachments["operator_summary"]["next_safe_action"]["kind"], "review_result")
            self.assertIn("experiment_latency_probe", attachments["current_conclusion_update"]["supporting_experiments"])

            hypothesis_registry_path = root / "research" / "HYPOTHESIS_REGISTRY.jsonl"
            self.assertTrue(hypothesis_registry_path.exists())
            hypothesis_records = [
                json.loads(line)
                for line in hypothesis_registry_path.read_text().strip().splitlines()
                if line.strip()
            ]
            self.assertEqual(hypothesis_records[0]["hypothesis_id"], "hypothesis_latency_probe")
            self.assertEqual(hypothesis_records[0]["revision"], 1)
            self.assertEqual(hypothesis_records[0]["status"], "active")

            experiment_index_path = root / "project_index" / "experiment_index.jsonl"
            self.assertTrue(experiment_index_path.exists())
            experiment_records = [
                json.loads(line)
                for line in experiment_index_path.read_text().strip().splitlines()
                if line.strip()
            ]
            self.assertEqual(experiment_records[0]["experiment_id"], "experiment_latency_probe")
            self.assertEqual(experiment_records[0]["status"], "draft")
            self.assertEqual(experiment_records[0]["run_id"], "task_20260618_120000_expapply")

            current_conclusions = json.loads((root / "project_index" / "current_conclusions.json").read_text())
            self.assertIn(
                "experiment_latency_probe",
                current_conclusions["items"][0]["supporting_experiments"],
            )

    def test_maybe_attach_execution_evaluation_writes_experiment_review_bundle_when_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_review"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU latency probe and summarize the outcome.",
                        "summary": "Bounded CPU latency probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu latency probe status",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/latency_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "latency_probe_status", "score": 6.0}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "program_id": "demo-program",
                        "available": True,
                        "publish_only_after_review": True,
                        "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "HYPOTHESIS_REGISTRY.json").write_text(
                json.dumps(
                    {
                        "registry_status": "needs_clarification",
                        "hypotheses": [{"hypothesis_id": "hypothesis_latency_probe"}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    {
                        "required": True,
                        "objective": "bounded_cpu_eval",
                        "task_type": "bounded_execution",
                        "hypothesis_ids": ["hypothesis_latency_probe"],
                        "experiment_id": "experiment_latency_probe_review",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260618_120000_expreview",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            result_data = {"text": "Latency stayed within the bounded target during the CPU probe."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                root / "task_20260618_120000_expreview",
                task,
                result_data,
                deps,
            )

            experiment_promotion = attachments["experiment_promotion"]
            hypothesis_promotion = attachments["hypothesis_promotion"]
            self.assertEqual(hypothesis_promotion["promotion_state"], "review_required")
            self.assertEqual(hypothesis_promotion["project_sync"]["status"], "review_bundle_written")
            self.assertEqual(experiment_promotion["promotion_state"], "review_required")
            self.assertEqual(experiment_promotion["project_sync"]["status"], "review_bundle_written")
            self.assertEqual(attachments["evaluation_report"]["validity"]["status"], "valid_with_limitations")
            self.assertIn("hypothesis_review_required", attachments["evaluation_report"]["validity"]["limitations"])
            self.assertIn("experiment_review_required", attachments["evaluation_report"]["validity"]["limitations"])
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertEqual(attachments["operator_summary"]["next_safe_action"]["kind"], "review_hypothesis_bundle")
            self.assertEqual(
                attachments["operator_summary"]["next_safe_action"]["target_path"],
                "research/proposals/hypotheses/hypothesis_latency_probe.json",
            )
            self.assertIn(
                "hypothesis publication is waiting on the generated review bundle",
                attachments["operator_summary"]["operator_message"],
            )
            self.assertIn(
                "experiment_latency_probe_review",
                attachments["current_conclusion_update"]["supporting_experiments"],
            )
            hypothesis_bundle_path = root / "research" / "proposals" / "hypotheses" / "hypothesis_latency_probe.json"
            self.assertTrue(hypothesis_bundle_path.exists())
            hypothesis_bundle = json.loads(hypothesis_bundle_path.read_text())
            self.assertEqual(hypothesis_bundle["hypothesis_update"]["hypothesis_id"], "hypothesis_latency_probe")
            self.assertFalse((root / "research" / "HYPOTHESIS_REGISTRY.jsonl").exists())
            bundle_path = root / "research" / "proposals" / "experiments" / "experiment_latency_probe_review.json"
            self.assertTrue(bundle_path.exists())
            bundle = json.loads(bundle_path.read_text())
            self.assertEqual(bundle["experiment_index_update"]["experiment_id"], "experiment_latency_probe_review")
            self.assertFalse((root / "project_index" / "experiment_index.jsonl").exists())

    def test_maybe_attach_execution_evaluation_falls_back_to_transition_review_when_project_states_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_transition_review"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU latency probe and summarize the outcome.",
                        "summary": "Bounded CPU latency probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu latency probe status",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/latency_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "latency_probe_status", "score": 6.0}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "program_id": "demo-program",
                        "available": True,
                        "publish_only_after_review": False,
                        "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "HYPOTHESIS_REGISTRY.json").write_text(
                json.dumps(
                    {
                        "registry_status": "active",
                        "hypotheses": [
                            {"hypothesis_id": "hypothesis_latency_probe", "summary": "Latency can be reduced"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    {
                        "required": True,
                        "objective": "bounded_cpu_eval",
                        "task_type": "bounded_execution",
                        "hypothesis_ids": ["hypothesis_latency_probe"],
                        "experiment_id": "experiment_latency_probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (root / "research").mkdir(parents=True, exist_ok=True)
            (root / "research" / "HYPOTHESIS_REGISTRY.jsonl").write_text(
                json.dumps(
                    {
                        "schema_version": "hypothesis_record.v0.1",
                        "hypothesis_id": "hypothesis_latency_probe",
                        "revision": 3,
                        "status": "archived",
                        "claim": "Old archived claim",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            (root / "project_index").mkdir(parents=True, exist_ok=True)
            (root / "project_index" / "experiment_index.jsonl").write_text(
                json.dumps(
                    {
                        "experiment_id": "experiment_latency_probe",
                        "experiment_type": "bounded_execution",
                        "status": "archived",
                        "name": "Archived latency probe",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260618_120000_transitionreview",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            result_data = {"text": "Latency stayed within the bounded target during the CPU probe."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                root / "task_20260618_120000_transitionreview",
                task,
                result_data,
                deps,
            )

            hypothesis_sync = attachments["hypothesis_promotion"]["project_sync"]
            experiment_sync = attachments["experiment_promotion"]["project_sync"]
            self.assertEqual(hypothesis_sync["status"], "transition_review_required")
            self.assertEqual(hypothesis_sync["transition_validation"]["reason"], "transition_not_allowed")
            self.assertEqual(hypothesis_sync["transition_validation"]["current_status"], "archived")
            self.assertEqual(hypothesis_sync["transition_validation"]["proposed_status"], "active")
            self.assertEqual(experiment_sync["status"], "transition_review_required")
            self.assertEqual(experiment_sync["transition_validation"]["reason"], "transition_not_allowed")
            self.assertEqual(experiment_sync["transition_validation"]["current_status"], "archived")
            self.assertEqual(experiment_sync["transition_validation"]["proposed_status"], "draft")
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertEqual(attachments["operator_summary"]["next_safe_action"]["kind"], "review_hypothesis_transition_bundle")
            self.assertEqual(
                attachments["operator_summary"]["next_safe_action"]["target_path"],
                "research/proposals/hypotheses/hypothesis_latency_probe.json",
            )

            hypothesis_bundle = json.loads(
                (root / "research" / "proposals" / "hypotheses" / "hypothesis_latency_probe.json").read_text()
            )
            self.assertEqual(hypothesis_bundle["transition_validation"]["reason"], "transition_not_allowed")
            self.assertEqual(hypothesis_bundle["existing_record"]["status"], "archived")
            experiment_bundle = json.loads(
                (root / "research" / "proposals" / "experiments" / "experiment_latency_probe.json").read_text()
            )
            self.assertEqual(experiment_bundle["transition_validation"]["reason"], "transition_not_allowed")
            self.assertEqual(experiment_bundle["existing_record"]["status"], "archived")

            hypothesis_records = [
                json.loads(line)
                for line in (root / "research" / "HYPOTHESIS_REGISTRY.jsonl").read_text().strip().splitlines()
                if line.strip()
            ]
            self.assertEqual(len(hypothesis_records), 1)
            self.assertEqual(hypothesis_records[0]["status"], "archived")
            experiment_records = [
                json.loads(line)
                for line in (root / "project_index" / "experiment_index.jsonl").read_text().strip().splitlines()
                if line.strip()
            ]
            self.assertEqual(len(experiment_records), 1)
            self.assertEqual(experiment_records[0]["status"], "archived")

    def test_maybe_attach_execution_evaluation_writes_review_bundle_when_publication_requires_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_review"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "report_only",
                        "mode": "readonly",
                        "prompt": "What is the current best candidate?",
                        "summary": "Current best candidate status",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "What is the current best candidate?",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/current_best.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "current_best_candidate", "score": 6.0}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps(
                    {
                        "program_id": "demo-program",
                        "available": True,
                        "publish_only_after_review": True,
                        "allowed_conclusion_statuses": ["confirmed", "tentative", "auxiliary_only"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260618_120000_review",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            result_data = {"text": "The current best candidate remains model A under the protected evaluation contract."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                root / "task_20260618_120000_review",
                task,
                result_data,
                deps,
            )

            promotion = attachments["current_conclusion_promotion"]
            self.assertEqual(promotion["promotion_state"], "review_required")
            self.assertEqual(promotion["project_sync"]["status"], "review_bundle_written")
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertEqual(attachments["operator_summary"]["next_safe_action"]["kind"], "review_current_conclusion_bundle")
            self.assertEqual(
                attachments["operator_summary"]["next_safe_action"]["target_path"],
                "research/proposals/current_conclusions/current_best_candidate.json",
            )
            self.assertIn(
                "waiting on the generated review bundle",
                attachments["operator_summary"]["operator_message"],
            )
            bundle_path = root / "research" / "proposals" / "current_conclusions" / "current_best_candidate.json"
            self.assertTrue(bundle_path.exists())
            bundle = json.loads(bundle_path.read_text())
            self.assertEqual(bundle["current_conclusion_update"]["topic_id"], "current_best_candidate")
            self.assertFalse((root / "project_index" / "current_conclusions.json").exists())


if __name__ == "__main__":
    unittest.main()
