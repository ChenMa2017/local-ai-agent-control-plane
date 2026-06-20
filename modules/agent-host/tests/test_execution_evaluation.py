import datetime as dt
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import execution_evaluation
import experiment_contracts
import operator_summary
import research_objects


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
            self.assertIn("Task completed successfully", attachments["followup_task_draft"]["reason"])
            self.assertEqual(
                attachments["followup_task_draft"]["remediation"],
                {"category": "result_review", "subject": "task_result"},
            )
            self.assertEqual(
                attachments["followup_task_draft"]["evidence_retrieval_decision"],
                "stale_conclusion",
            )
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
            self.assertNotIn("experiment_result", attachments)
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
                        "baseline_spec": {"required": False, "entities": []},
                        "metric_definitions": [
                            {
                                "metric_id": "M-01",
                                "name": "safe_result_available",
                                "kind": "binary",
                                "source": "execution_safe_result_excerpt",
                                "higher_is_better": True,
                            }
                        ],
                        "success_criteria": [
                            {
                                "criterion_id": "SC-02",
                                "name": "user_success_criterion_defined",
                                "status": "missing",
                            }
                        ],
                        "failure_criteria": [
                            {
                                "criterion_id": "FC-01",
                                "name": "task_not_terminal",
                                "kind": "execution",
                            },
                            {
                                "criterion_id": "FC-02",
                                "name": "protected_path_violation",
                                "kind": "policy",
                            },
                            {
                                "criterion_id": "FC-03",
                                "name": "missing_safe_result_excerpt",
                                "kind": "execution",
                            },
                        ],
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
            experiment_result = attachments["experiment_result"]
            self.assertEqual(hypothesis_update["hypothesis_id"], "hypothesis_latency_probe")
            self.assertEqual(hypothesis_update["status"], "inconclusive")
            self.assertEqual(hypothesis_update["evaluation_result"], "inconclusive")
            self.assertEqual(hypothesis_update["evaluation_validity"], "valid")
            self.assertEqual(hypothesis_promotion["promotion_state"], "candidate_ready")
            self.assertEqual(hypothesis_promotion["project_sync"]["status"], "transition_review_required")
            self.assertEqual(hypothesis_promotion["project_sync"]["transition_validation"]["status"], "review_required")
            self.assertEqual(hypothesis_promotion["project_sync"]["transition_validation"]["reason"], "transition_not_allowed")
            self.assertIsNone(hypothesis_promotion["project_sync"]["transition_validation"]["current_status"])
            self.assertEqual(hypothesis_promotion["project_sync"]["transition_validation"]["proposed_status"], "inconclusive")
            self.assertEqual(experiment_result["experiment_id"], "experiment_latency_probe")
            self.assertEqual(experiment_result["assessment_basis"], "structural_only")
            self.assertEqual(experiment_result["validity"], "valid")
            self.assertEqual(experiment_result["result"], "inconclusive")
            self.assertEqual(experiment_result["metrics"][0]["name"], "safe_result_available")
            self.assertEqual(experiment_result["metrics"][0]["value"], 1)
            self.assertIn("success_criteria_unresolved", experiment_result["limitations"])
            self.assertEqual(experiment_result["failure_criteria"][0]["status"], "clear")
            self.assertEqual(experiment_result["failure_criteria"][1]["status"], "clear")
            self.assertEqual(experiment_result["failure_criteria"][2]["status"], "clear")
            self.assertEqual(experiment_update["experiment_id"], "experiment_latency_probe")
            self.assertEqual(experiment_update["status"], "draft")
            self.assertEqual(experiment_update["experiment_result"], "inconclusive")
            self.assertEqual(experiment_update["experiment_validity"], "valid")
            self.assertEqual(experiment_update["assessment_basis"], "structural_only")
            self.assertTrue(experiment_update["success_criteria"])
            self.assertEqual(experiment_update["failure_criteria"][2]["name"], "missing_safe_result_excerpt")
            self.assertEqual(experiment_update["failure_criteria"][2]["status"], "clear")
            self.assertEqual(experiment_promotion["promotion_state"], "candidate_ready")
            self.assertEqual(experiment_promotion["project_sync"]["status"], "applied")
            self.assertEqual(experiment_promotion["project_sync"]["transition_validation"]["status"], "valid")
            self.assertEqual(attachments["evaluation_report"]["hypothesis_promotion_state"], "candidate_ready")
            self.assertEqual(attachments["evaluation_report"]["experiment_promotion_state"], "candidate_ready")
            self.assertEqual(attachments["evaluation_report"]["validity"]["status"], "valid_with_limitations")
            self.assertIn("success_criteria_not_resolved", attachments["evaluation_report"]["validity"]["limitations"])
            self.assertFalse(attachments["evaluation_report"]["machine_checks"]["experiment_failure_criteria_triggered"])
            self.assertEqual(
                attachments["evaluation_report"]["machine_checks"]["experiment_failure_criteria_triggered_names"],
                [],
            )
            self.assertEqual(attachments["evaluation_report"]["experiment_result"]["result"], "inconclusive")
            self.assertEqual(attachments["evaluation_report"]["hypothesis_assessment"]["assessment"], "active_candidate")
            self.assertEqual(attachments["evaluation_report"]["hypothesis_assessment"]["evaluation_result"], "inconclusive")
            self.assertEqual(attachments["evaluation_report"]["experiment_assessment"]["assessment"], "candidate_recorded")
            self.assertEqual(attachments["evaluation_report"]["experiment_assessment"]["result"], "inconclusive")
            self.assertEqual(attachments["evaluation_report"]["experiment_assessment"]["validity"], "valid")
            self.assertEqual(
                attachments["evaluation_report"]["experiment_assessment"]["failure_criteria_summary"]["triggered"],
                0,
            )
            self.assertEqual(attachments["evaluation_report"]["conclusion_assessment"]["assessment"], "candidate_ready")
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertEqual(attachments["operator_summary"]["next_safe_action"]["kind"], "review_hypothesis_transition_bundle")
            self.assertIn("experiment_latency_probe", attachments["current_conclusion_update"]["supporting_experiments"])
            self.assertTrue((intake_root / "EXPERIMENT_RESULT.json").exists())

            hypothesis_registry_path = root / "research" / "HYPOTHESIS_REGISTRY.jsonl"
            self.assertFalse(hypothesis_registry_path.exists())
            hypothesis_bundle_path = root / "research" / "proposals" / "hypotheses" / "hypothesis_latency_probe.json"
            self.assertTrue(hypothesis_bundle_path.exists())
            hypothesis_bundle = json.loads(hypothesis_bundle_path.read_text())
            self.assertEqual(hypothesis_bundle["transition_validation"]["reason"], "transition_not_allowed")
            self.assertEqual(hypothesis_bundle["hypothesis_update"]["status"], "inconclusive")

            experiment_index_path = root / "project_index" / "experiment_index.jsonl"
            self.assertTrue(experiment_index_path.exists())
            experiment_records = [
                json.loads(line)
                for line in experiment_index_path.read_text().strip().splitlines()
                if line.strip()
            ]
            self.assertEqual(experiment_records[0]["experiment_id"], "experiment_latency_probe")
            self.assertEqual(experiment_records[0]["status"], "draft")
            self.assertEqual(experiment_records[0]["experiment_result"], "inconclusive")
            self.assertEqual(experiment_records[0]["failure_criteria"][0]["status"], "clear")
            self.assertEqual(experiment_records[0]["run_id"], "task_20260618_120000_expapply")

            current_conclusions = json.loads((root / "project_index" / "current_conclusions.json").read_text())
            self.assertIn(
                "experiment_latency_probe",
                current_conclusions["items"][0]["supporting_experiments"],
            )

    def test_maybe_attach_execution_evaluation_uses_runner_metrics_for_supported_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_metrics"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and keep the variant only if the primary metric improves.",
                        "summary": "Bounded CPU metric-backed probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu metric-backed probe",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/metric_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "metric_probe_status", "score": 6.0}],
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
                            {"hypothesis_id": "hypothesis_metric_probe", "summary": "The variant should outperform baseline"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            experiment_spec = {
                "required": True,
                "objective": "bounded_cpu_eval",
                "task_type": "bounded_execution",
                "hypothesis_ids": ["hypothesis_metric_probe"],
                "experiment_id": "experiment_metric_probe",
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [42],
                "code_reference": {
                    "commit": "deadbeef",
                    "paths": ["train.py"],
                    "status": "resolved",
                },
                "config_reference": {
                    "path": "configs/demo_probe.yaml",
                    "hash": "cfg-001",
                    "status": "resolved",
                },
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-02",
                        "name": "user_success_criterion_defined",
                        "kind": "contract",
                        "status": "resolved",
                    },
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
                "failure_criteria": [
                    {
                        "criterion_id": "FC-D1",
                        "name": "accuracy_gain_exceeds_guardrail",
                        "kind": "metric_guardrail",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.05},
                    }
                ],
            }
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    experiment_spec,
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260619_120000_expmetrics",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260619_120000_expmetrics"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "RUNNER_METRICS.json").write_text(
                json.dumps(
                    {
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task["task_id"],
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-19T12:00:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                                "artifact_refs": ["artifacts/metric_probe.json"],
                                "notes": "Variant outperformed baseline by 3.1 points.",
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            result_data = {"text": "The bounded probe completed and the variant beat baseline on the primary metric."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                result_data,
                deps,
            )

            experiment_result = attachments["experiment_result"]
            experiment_update = attachments["experiment_index_update"]
            hypothesis_update = attachments["hypothesis_update"]
            self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
            self.assertEqual(experiment_result["evidence_strength"], "metric_backed")
            self.assertEqual(experiment_result["validity"], "valid")
            self.assertEqual(experiment_result["provisional_result"], "supported")
            self.assertEqual(experiment_result["result"], "supported")
            self.assertEqual(experiment_result["final_result"], "supported")
            self.assertEqual(experiment_result["adjudication_status"], "accepted")
            self.assertTrue(experiment_result["promotion_eligible"])
            self.assertEqual(experiment_result["baseline_comparison"]["status"], "improved")
            self.assertEqual(experiment_result["metrics"][1]["name"], "accuracy_gain")
            self.assertEqual(experiment_result["metrics"][1]["value"], 0.031)
            self.assertEqual(experiment_result["success_criteria"][1]["status"], "pass")
            self.assertEqual(experiment_result["failure_criteria"][0]["status"], "clear")
            self.assertTrue(experiment_result["runner_metrics_artifact"]["present"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["validated"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["producer_allowed"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["trusted"])
            self.assertTrue(str(experiment_result["runner_metrics_artifact"]["sha256"]).startswith("sha256:"))
            self.assertFalse(experiment_result["limitations"])
            self.assertEqual(experiment_update["primary_metric_name"], "accuracy_gain")
            self.assertEqual(experiment_update["experiment_result"], "supported")
            self.assertEqual(hypothesis_update["status"], "supported")
            self.assertEqual(hypothesis_update["status_reason"], "experiment_final_result")
            self.assertEqual(hypothesis_update["status_blockers"], [])
            self.assertEqual(attachments["evaluation_report"]["assessment_basis"], "runner_metrics")
            self.assertEqual(attachments["evaluation_report"]["validity"]["status"], "valid_metric_backed")
            self.assertEqual(
                attachments["evaluation_report"]["hypothesis_assessment"]["assessment_basis"],
                "runner_metrics",
            )
            self.assertEqual(
                attachments["evaluation_report"]["hypothesis_assessment"]["status_reason"],
                "experiment_final_result",
            )
            self.assertEqual(attachments["evaluation_report"]["experiment_assessment"]["result"], "supported")
            self.assertEqual(attachments["experiment_promotion"]["project_sync"]["status"], "applied")
            self.assertEqual(attachments["hypothesis_promotion"]["project_sync"]["status"], "transition_review_required")
            self.assertEqual(
                attachments["hypothesis_promotion"]["project_sync"]["transition_validation"]["reason"],
                "transition_not_allowed",
            )
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertEqual(
                attachments["operator_summary"]["next_safe_action"]["kind"],
                "review_hypothesis_transition_bundle",
            )
            self.assertTrue(
                (root / "research" / "proposals" / "hypotheses" / "hypothesis_metric_probe.json").exists()
            )
            self.assertTrue((intake_root / "EXPERIMENT_RESULT.json").exists())

    def test_maybe_attach_execution_evaluation_blocks_partial_runner_metrics_from_promotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_partial_metric_probe"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and confirm the variant only if both accuracy and precision improve.",
                        "summary": "Bounded CPU metric-backed partial probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu partial metric-backed probe",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/partial_metric_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "partial_metric_probe_status", "score": 6.0}],
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
                            {"hypothesis_id": "hypothesis_partial_metric_probe", "summary": "The variant should outperform baseline"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            experiment_spec = {
                "required": True,
                "objective": "bounded_cpu_eval",
                "task_type": "bounded_execution",
                "hypothesis_ids": ["hypothesis_partial_metric_probe"],
                "experiment_id": "experiment_partial_metric_probe",
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [42],
                "code_reference": {
                    "commit": "deadbeef",
                    "paths": ["train.py"],
                    "status": "resolved",
                },
                "config_reference": {
                    "path": "configs/demo_partial_probe.yaml",
                    "hash": "cfg-002",
                    "status": "resolved",
                },
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-03",
                        "name": "precision_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                    {
                        "criterion_id": "SC-D2",
                        "name": "precision_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "precision_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
                "failure_criteria": [
                    {
                        "criterion_id": "FC-D1",
                        "name": "accuracy_gain_exceeds_guardrail",
                        "kind": "metric_guardrail",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.05},
                    }
                ],
            }
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    experiment_spec,
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260620_092500_partialmetrics",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260620_092500_partialmetrics"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "RUNNER_METRICS.json").write_text(
                json.dumps(
                    {
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task["task_id"],
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-20T09:25:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                                "artifact_refs": ["artifacts/accuracy_probe.json"],
                                "notes": "Accuracy improved by 3.1 points.",
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            result_data = {"text": "The bounded probe completed, but only one of the required metric observations was exported."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                result_data,
                deps,
            )

            experiment_result = attachments["experiment_result"]
            self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
            self.assertEqual(experiment_result["provisional_result"], "inconclusive")
            self.assertEqual(experiment_result["result"], "inconclusive")
            self.assertIsNone(experiment_result["final_result"])
            self.assertEqual(experiment_result["adjudication_status"], "pending_review")
            self.assertFalse(experiment_result["promotion_eligible"])
            self.assertIn("success_criteria_unresolved", experiment_result["limitations"])
            self.assertEqual(experiment_result["success_criteria"][0]["status"], "pass")
            self.assertEqual(experiment_result["success_criteria"][1]["status"], "not_observed")
            self.assertEqual(attachments["hypothesis_update"]["status"], "testing")
            self.assertEqual(
                attachments["hypothesis_update"]["status_reason"],
                "experiment_not_promotion_eligible",
            )
            self.assertIn("success_criteria_unresolved", attachments["hypothesis_update"]["status_blockers"])
            self.assertEqual(attachments["experiment_promotion"]["promotion_state"], "review_required")
            self.assertNotEqual(attachments["experiment_promotion"]["project_sync"]["status"], "applied")
            self.assertEqual(attachments["hypothesis_promotion"]["promotion_state"], "review_required")
            self.assertIn(
                "success_criteria_not_resolved",
                attachments["evaluation_report"]["validity"]["limitations"],
            )
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")

    def test_build_experiment_result_uses_runner_metrics_for_refuted_result(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260619_121000_refuted",
                "intake_id": "intake_refuted",
                "workspace": "demo",
                "updated_at": "2026-06-19T12:10:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_refuted_probe",
                "hypothesis_ids": ["hypothesis_refuted_probe"],
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [7],
                "code_reference": {"commit": "deadbeef"},
                "config_reference": {"path": "configs/refuted_probe.yaml"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "latency_delta",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": False,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "FC-01",
                        "name": "latency_regression_detected",
                        "kind": "falsification",
                        "metric_name": "latency_delta",
                        "target": {"operator": ">", "value": 0.0},
                    }
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "name": "latency_delta",
                        "value": 0.042,
                        "baseline_value": 0.0,
                    }
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
        self.assertEqual(experiment_result["provisional_result"], "refuted")
        self.assertEqual(experiment_result["result"], "refuted")
        self.assertEqual(experiment_result["final_result"], "refuted")
        self.assertEqual(experiment_result["adjudication_status"], "accepted")
        self.assertTrue(experiment_result["promotion_eligible"])
        self.assertEqual(experiment_result["success_criteria"][0]["status"], "pass")

    def test_build_experiment_result_requires_complete_support_criteria_for_supported_result(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260620_090000_partialsupport",
                "intake_id": "intake_partialsupport",
                "workspace": "demo",
                "updated_at": "2026-06-20T09:00:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_partial_support_probe",
                "hypothesis_ids": ["hypothesis_partial_support_probe"],
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [19],
                "code_reference": {"commit": "deadbeef"},
                "config_reference": {"path": "configs/partial_support_probe.yaml"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-03",
                        "name": "precision_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-01",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                    {
                        "criterion_id": "SC-02",
                        "name": "precision_gain_positive",
                        "kind": "metric",
                        "metric_name": "precision_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "value": 0.031,
                        "baseline_value": 0.0,
                    }
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
        self.assertEqual(experiment_result["provisional_result"], "inconclusive")
        self.assertEqual(experiment_result["result"], "inconclusive")
        self.assertIsNone(experiment_result["final_result"])
        self.assertEqual(experiment_result["adjudication_status"], "pending_review")
        self.assertFalse(experiment_result["promotion_eligible"])
        self.assertIn("success_criteria_unresolved", experiment_result["limitations"])
        self.assertEqual(experiment_result["success_criteria"][0]["status"], "pass")
        self.assertEqual(experiment_result["success_criteria"][1]["status"], "not_observed")

    def test_build_experiment_result_requires_reproducibility_contract_for_supported_promotion(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260620_092500_reprosupport",
                "intake_id": "intake_reprosupport",
                "workspace": "demo",
                "updated_at": "2026-06-20T09:25:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_repro_support_probe",
                "hypothesis_ids": ["hypothesis_repro_support_probe"],
                "baseline_spec": {"required": True, "entities": []},
                "dataset_refs": [],
                "random_seeds": [],
                "code_reference": {},
                "config_reference": {},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-01",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    }
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "value": 0.031,
                        "baseline_value": 0.0,
                    }
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
        self.assertEqual(experiment_result["provisional_result"], "supported")
        self.assertEqual(experiment_result["result"], "inconclusive")
        self.assertIsNone(experiment_result["final_result"])
        self.assertEqual(experiment_result["adjudication_status"], "pending_review")
        self.assertFalse(experiment_result["promotion_eligible"])
        self.assertIn("reproducibility_contract_incomplete", experiment_result["limitations"])
        self.assertEqual(experiment_result["reproducibility"]["status"], "contract_incomplete")

    def test_build_experiment_result_requires_complete_falsification_criteria_for_refuted_result(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260620_091500_partialfalsification",
                "intake_id": "intake_partialfalsification",
                "workspace": "demo",
                "updated_at": "2026-06-20T09:15:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_partial_falsification_probe",
                "hypothesis_ids": ["hypothesis_partial_falsification_probe"],
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [23],
                "code_reference": {"commit": "deadbeef"},
                "config_reference": {"path": "configs/partial_falsification_probe.yaml"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "latency_delta",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": False,
                    },
                    {
                        "metric_id": "M-03",
                        "name": "error_rate_delta",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": False,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "FC-01",
                        "name": "latency_regression_detected",
                        "kind": "falsification",
                        "metric_name": "latency_delta",
                        "target": {"operator": ">", "value": 0.0},
                    },
                    {
                        "criterion_id": "FC-02",
                        "name": "error_rate_regression_detected",
                        "kind": "falsification",
                        "metric_name": "error_rate_delta",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "name": "latency_delta",
                        "value": 0.042,
                        "baseline_value": 0.0,
                    }
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
        self.assertEqual(experiment_result["provisional_result"], "inconclusive")
        self.assertEqual(experiment_result["result"], "inconclusive")
        self.assertIsNone(experiment_result["final_result"])
        self.assertEqual(experiment_result["adjudication_status"], "pending_review")
        self.assertFalse(experiment_result["promotion_eligible"])
        self.assertIn("success_criteria_unresolved", experiment_result["limitations"])
        self.assertEqual(experiment_result["success_criteria"][0]["status"], "pass")
        self.assertEqual(experiment_result["success_criteria"][1]["status"], "not_observed")

    def test_build_experiment_result_blocks_promotion_when_metric_failure_criterion_triggers(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260619_121250_failure_guardrail",
                "intake_id": "intake_failure_guardrail",
                "workspace": "demo",
                "updated_at": "2026-06-19T12:12:50Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_failure_guardrail",
                "hypothesis_ids": ["hypothesis_failure_guardrail"],
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [13],
                "code_reference": {"commit": "deadbeef"},
                "config_reference": {"path": "configs/failure_guardrail.yaml"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    }
                ],
                "failure_criteria": [
                    {
                        "criterion_id": "FC-D1",
                        "name": "accuracy_gain_exceeds_guardrail",
                        "kind": "metric_guardrail",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.02},
                    }
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "value": 0.031,
                        "baseline_value": 0.0,
                    }
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
        self.assertEqual(experiment_result["provisional_result"], "supported")
        self.assertEqual(experiment_result["result"], "inconclusive")
        self.assertIsNone(experiment_result["final_result"])
        self.assertEqual(experiment_result["adjudication_status"], "pending_review")
        self.assertFalse(experiment_result["promotion_eligible"])
        self.assertEqual(experiment_result["failure_criteria"][0]["status"], "triggered")
        self.assertEqual(experiment_result["failure_criteria"][0]["triggered"], True)
        self.assertIn("failure_criteria_triggered", experiment_result["limitations"])
        self.assertEqual(
            research_objects.experiment_promotion_state(
                {
                    "task_status": "done",
                    "result_available": True,
                },
                {
                    "required": True,
                },
                {},
                {},
                experiment_result,
            ),
            "review_required",
        )

    def test_build_experiment_result_evaluates_failure_criteria_statuses(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "running",
                "result_available": False,
                "write_audit": {"protected_path_violation": True},
                "task_id": "task_20260619_122000_failurecriteria",
                "intake_id": "intake_failurecriteria",
                "workspace": "demo",
                "updated_at": "2026-06-19T12:20:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_failure_probe",
                "hypothesis_ids": ["hypothesis_failure_probe"],
                "failure_criteria": [
                    {
                        "criterion_id": "FC-01",
                        "name": "task_not_terminal",
                        "kind": "execution",
                    },
                    {
                        "criterion_id": "FC-02",
                        "name": "protected_path_violation",
                        "kind": "policy",
                    },
                    {
                        "criterion_id": "FC-03",
                        "name": "missing_safe_result_excerpt",
                        "kind": "execution",
                    },
                ],
            },
            {},
            {},
        )

        self.assertEqual(experiment_result["validity"], "invalid")
        self.assertEqual(experiment_result["result"], "invalid")
        self.assertEqual(
            [item["status"] for item in experiment_result["failure_criteria"]],
            ["triggered", "triggered", "triggered"],
        )
        self.assertEqual(
            [item["triggered"] for item in experiment_result["failure_criteria"]],
            [True, True, True],
        )

    def test_build_evaluation_report_surfaces_triggered_failure_criteria(self):
        report = research_objects.build_evaluation_report(
            {
                "intake_id": "intake_failurecriteria_report",
                "task_id": "task_20260619_122500_failurecriteria_report",
                "workspace": "demo",
                "task_status": "running",
                "result_available": False,
                "write_audit": {"protected_path_violation": True},
                "evidence_retrieval_decision": "safe_to_answer",
                "summary": "bounded run stalled before producing a safe excerpt",
            },
            {
                "objective": "bounded_cpu_eval",
            },
            {
                "read_plan": [{"path": "formal/failure_probe.md", "reason": "primary source"}],
            },
            {},
            {
                "hypotheses": [{"hypothesis_id": "hypothesis_failure_probe"}],
            },
            {
                "required": True,
                "experiment_id": "experiment_failure_probe",
                "hypothesis_ids": ["hypothesis_failure_probe"],
            },
            {
                "assessment_basis": "structural_only",
                "validity": "invalid",
                "result": "invalid",
                "promotion_eligible": False,
                "runner_metrics_artifact": {"present": False, "trusted": False},
                "failure_criteria": [
                    {"name": "task_not_terminal", "status": "triggered", "triggered": True},
                    {"name": "protected_path_violation", "status": "triggered", "triggered": True},
                    {"name": "missing_safe_result_excerpt", "status": "triggered", "triggered": True},
                ],
            },
            {},
        )

        self.assertTrue(report["machine_checks"]["experiment_failure_criteria_triggered"])
        self.assertEqual(
            report["machine_checks"]["experiment_failure_criteria_triggered_names"],
            ["task_not_terminal", "protected_path_violation", "missing_safe_result_excerpt"],
        )
        self.assertIn("failure_criteria_triggered", report["validity"]["limitations"])
        self.assertEqual(
            report["experiment_assessment"]["failure_criteria_summary"],
            {"total": 3, "triggered": 3, "clear": 0, "not_evaluated": 0},
        )
        self.assertEqual(
            report["experiment_assessment"]["failure_criteria_triggered"],
            ["task_not_terminal", "protected_path_violation", "missing_safe_result_excerpt"],
        )

    def test_build_experiment_result_requires_review_for_conflicting_success_criteria(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260619_121500_conflict",
                "intake_id": "intake_conflict",
                "workspace": "demo",
                "updated_at": "2026-06-19T12:15:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_conflict_probe",
                "hypothesis_ids": ["hypothesis_conflict_probe"],
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [11],
                "code_reference": {"commit": "deadbeef"},
                "config_reference": {"path": "configs/conflict_probe.yaml"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "quality_delta",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-01",
                        "name": "quality_gain_positive",
                        "kind": "metric",
                        "metric_name": "quality_delta",
                        "target": {"operator": ">", "value": 0.0},
                    },
                    {
                        "criterion_id": "FC-01",
                        "name": "quality_gain_should_not_be_positive",
                        "kind": "falsification",
                        "metric_name": "quality_delta",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "name": "quality_delta",
                        "value": 0.021,
                        "baseline_value": 0.0,
                    }
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["assessment_basis"], "runner_metrics")
        self.assertEqual(experiment_result["provisional_result"], "inconclusive")
        self.assertEqual(experiment_result["result"], "inconclusive")
        self.assertIsNone(experiment_result["final_result"])
        self.assertEqual(experiment_result["adjudication_status"], "pending_review")
        self.assertFalse(experiment_result["promotion_eligible"])
        self.assertIn("conflicting_success_criteria", experiment_result["limitations"])
        self.assertEqual(experiment_result["success_criteria"][0]["status"], "pass")
        self.assertEqual(experiment_result["success_criteria"][1]["status"], "pass")

    def test_maybe_attach_execution_evaluation_rejects_mismatched_runner_metrics_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_metrics_rejected"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and keep the variant only if the primary metric improves.",
                        "summary": "Bounded CPU metric-backed probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu metric-backed probe",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/metric_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "metric_probe_status", "score": 6.0}],
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
                            {"hypothesis_id": "hypothesis_metric_probe_rejected", "summary": "The variant should outperform baseline"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            experiment_spec = {
                "required": True,
                "objective": "bounded_cpu_eval",
                "task_type": "bounded_execution",
                "hypothesis_ids": ["hypothesis_metric_probe_rejected"],
                "experiment_id": "experiment_metric_probe_rejected",
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [42],
                "code_reference": {
                    "commit": "deadbeef",
                    "paths": ["train.py"],
                    "status": "resolved",
                },
                "config_reference": {
                    "path": "configs/demo_probe.yaml",
                    "hash": "cfg-001",
                    "status": "resolved",
                },
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-02",
                        "name": "user_success_criterion_defined",
                        "kind": "contract",
                        "status": "resolved",
                    },
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            }
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    experiment_spec,
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260619_120500_expmetrics",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260619_120500_expmetrics"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "RUNNER_METRICS.json").write_text(
                json.dumps(
                    {
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task["task_id"],
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": "sha256:not-the-current-spec",
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-19T12:05:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            result_data = {"text": "The bounded probe completed and produced a safe excerpt, but the metrics artifact was stale."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                result_data,
                deps,
            )

            experiment_result = attachments["experiment_result"]
            self.assertEqual(experiment_result["assessment_basis"], "structural_only")
            self.assertEqual(experiment_result["evidence_strength"], "structural_only")
            self.assertEqual(experiment_result["validity"], "valid")
            self.assertEqual(experiment_result["provisional_result"], "inconclusive")
            self.assertEqual(experiment_result["result"], "inconclusive")
            self.assertIsNone(experiment_result["final_result"])
            self.assertEqual(experiment_result["adjudication_status"], "pending_review")
            self.assertFalse(experiment_result["promotion_eligible"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["present"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["validated"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["producer_allowed"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["trusted"])
            self.assertTrue(str(experiment_result["runner_metrics_artifact"]["sha256"]).startswith("sha256:"))
            self.assertIn("experiment_spec_digest does not match", experiment_result["runner_metrics_artifact"]["rejection_reason"])
            self.assertIn("runner_metrics_rejected", experiment_result["limitations"])
            self.assertIn(
                "Runner metrics artifact rejected: experiment_spec_digest does not match ExperimentSpec",
                attachments["execution_evaluation"]["warnings"],
            )
            self.assertEqual(attachments["hypothesis_update"]["status"], "testing")
            self.assertEqual(
                attachments["hypothesis_update"]["status_reason"],
                "experiment_not_promotion_eligible",
            )
            self.assertIn("runner_metrics_rejected", attachments["hypothesis_update"]["status_blockers"])
            self.assertEqual(attachments["experiment_promotion"]["promotion_state"], "review_required")
            self.assertNotEqual(attachments["experiment_promotion"]["project_sync"]["status"], "applied")
            self.assertEqual(attachments["hypothesis_promotion"]["promotion_state"], "review_required")
            self.assertEqual(
                attachments["evaluation_report"]["hypothesis_assessment"]["status_reason"],
                "experiment_not_promotion_eligible",
            )
            self.assertIn(
                "runner_metrics_rejected",
                attachments["evaluation_report"]["hypothesis_assessment"]["status_blockers"],
            )
            self.assertEqual(attachments["operator_summary"]["overall_status"], "review_required")
            self.assertIn(
                "runner_metrics_rejected",
                attachments["evaluation_report"]["validity"]["limitations"],
            )
            self.assertIn(
                "runner_metrics_rejected",
                attachments["operator_summary"]["next_safe_action"]["reason"],
            )

    def test_maybe_attach_execution_evaluation_rejects_runner_metrics_from_disallowed_producer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_metrics_disallowed_producer"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and keep the variant only if the primary metric improves.",
                        "summary": "Bounded CPU metric-backed probe with producer gate",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu metric-backed probe producer gate",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/metric_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "metric_probe_status", "score": 6.0}],
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
                            {"hypothesis_id": "hypothesis_metric_probe_disallowed", "summary": "The variant should outperform baseline"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            experiment_spec = {
                "required": True,
                "objective": "bounded_cpu_eval",
                "task_type": "bounded_execution",
                "hypothesis_ids": ["hypothesis_metric_probe_disallowed"],
                "experiment_id": "experiment_metric_probe_disallowed",
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [42],
                "code_reference": {
                    "commit": "deadbeef",
                    "paths": ["train.py"],
                    "status": "resolved",
                },
                "config_reference": {
                    "path": "configs/demo_probe.yaml",
                    "hash": "cfg-001",
                    "status": "resolved",
                },
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-02",
                        "name": "user_success_criterion_defined",
                        "kind": "contract",
                        "status": "resolved",
                    },
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            }
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(
                    experiment_spec,
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260620_101000_disallowedproducer",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260620_101000_disallowedproducer"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "RUNNER_METRICS.json").write_text(
                json.dumps(
                    {
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task["task_id"],
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "shadow-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-20T10:10:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            result_data = {"text": "The bounded probe completed and produced a safe excerpt, but the producer was not approved."}

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                result_data,
                deps,
            )

            experiment_result = attachments["experiment_result"]
            self.assertEqual(experiment_result["assessment_basis"], "structural_only")
            self.assertEqual(experiment_result["provisional_result"], "inconclusive")
            self.assertEqual(experiment_result["result"], "inconclusive")
            self.assertFalse(experiment_result["promotion_eligible"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["present"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["validated"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["producer_allowed"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["trusted"])
            self.assertTrue(str(experiment_result["runner_metrics_artifact"]["sha256"]).startswith("sha256:"))
            self.assertEqual(
                experiment_result["runner_metrics_artifact"]["producer"],
                {
                    "kind": "experiment_runner",
                    "id": "shadow-runner",
                    "version": "0.2",
                },
            )
            self.assertIn("not in the allowlist", experiment_result["runner_metrics_artifact"]["rejection_reason"])
            self.assertIn("runner_metrics_rejected", experiment_result["limitations"])
            self.assertIn(
                "Runner metrics artifact rejected: producer experiment_runner:shadow-runner is not in the allowlist",
                attachments["execution_evaluation"]["warnings"],
            )
            self.assertEqual(attachments["hypothesis_update"]["status"], "testing")
            self.assertIn("runner_metrics_rejected", attachments["hypothesis_update"]["status_blockers"])
            self.assertEqual(attachments["evaluation_report"]["assessment_basis"], "structural_only")
            self.assertFalse(attachments["evaluation_report"]["machine_checks"]["runner_metrics_artifact_trusted"])
            self.assertTrue(attachments["evaluation_report"]["machine_checks"]["runner_metrics_artifact_validated"])
            self.assertFalse(attachments["evaluation_report"]["machine_checks"]["runner_metrics_artifact_producer_allowed"])

    def test_maybe_attach_execution_evaluation_blocks_supported_promotion_when_reproducibility_contract_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_supported_repro_gate"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and keep the variant only if the primary metric improves.",
                        "summary": "Bounded CPU supported repro gate",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu supported repro gate",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/metric_probe.md", "reason": "primary source"}],
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
                            {"hypothesis_id": "hypothesis_supported_repro_gate", "summary": "The variant should outperform baseline"}
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
                        "hypothesis_ids": ["hypothesis_supported_repro_gate"],
                        "experiment_id": "experiment_supported_repro_gate",
                        "baseline_spec": {"required": True, "entities": []},
                        "dataset_refs": [],
                        "random_seeds": [],
                        "code_reference": {},
                        "config_reference": {},
                        "repeat_count": 3,
                        "metric_definitions": [
                            {
                                "metric_id": "M-01",
                                "name": "safe_result_available",
                                "kind": "binary",
                                "source": "execution_safe_result_excerpt",
                                "higher_is_better": True,
                            },
                            {
                                "metric_id": "M-02",
                                "name": "accuracy_gain",
                                "kind": "delta",
                                "source": "runner_metrics",
                                "higher_is_better": True,
                            },
                        ],
                        "success_criteria": [
                            {
                                "criterion_id": "SC-01",
                                "name": "accuracy_gain_positive",
                                "kind": "metric",
                                "metric_name": "accuracy_gain",
                                "target": {"operator": ">", "value": 0.0},
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            task = {
                "task_id": "task_20260620_104000_supportedreprogate",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "created_at": "2026-06-20T10:35:00Z",
                "started_at": "2026-06-20T10:35:05Z",
                "updated_at": "2026-06-20T10:36:00Z",
                "ended_at": "2026-06-20T10:36:00Z",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260620_104000_supportedreprogate"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "RUNNER_METRICS.json").write_text(
                json.dumps(
                    {
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task["task_id"],
                        "intake_id": intake_id,
                        "experiment_id": "experiment_supported_repro_gate",
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(
                            json.loads((intake_root / "EXPERIMENT_SPEC.json").read_text())
                        ),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-20T10:36:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                {"text": "The bounded probe completed and the variant beat baseline on the primary metric."},
                deps,
            )

            experiment_result = attachments["experiment_result"]
            self.assertEqual(experiment_result["provisional_result"], "supported")
            self.assertEqual(experiment_result["result"], "inconclusive")
            self.assertIsNone(experiment_result["final_result"])
            self.assertFalse(experiment_result["promotion_eligible"])
            self.assertIn("reproducibility_contract_incomplete", experiment_result["limitations"])
            self.assertEqual(attachments["hypothesis_update"]["status"], "testing")
            self.assertEqual(attachments["hypothesis_update"]["status_reason"], "experiment_not_promotion_eligible")
            self.assertIn("reproducibility_contract_incomplete", attachments["hypothesis_update"]["status_blockers"])
            self.assertEqual(attachments["experiment_promotion"]["promotion_state"], "review_required")
            self.assertEqual(attachments["hypothesis_promotion"]["promotion_state"], "review_required")

    def test_maybe_attach_execution_evaluation_rejects_replayed_runner_metrics_hash_from_prior_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_metrics_replay"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and keep the variant only if the primary metric improves.",
                        "summary": "Bounded CPU metric-backed replay guard probe",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu replay guard probe",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/metric_probe.md", "reason": "primary source"}],
                        "hits": [{"kind": "current_conclusion", "id": "metric_probe_status", "score": 6.0}],
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
                            {"hypothesis_id": "hypothesis_metric_probe_replay", "summary": "The variant should outperform baseline"}
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            experiment_spec = {
                "required": True,
                "objective": "bounded_cpu_eval",
                "task_type": "bounded_execution",
                "hypothesis_ids": ["hypothesis_metric_probe_replay"],
                "experiment_id": "experiment_metric_probe_replay",
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [42],
                "code_reference": {"commit": "deadbeef", "paths": ["train.py"], "status": "resolved"},
                "config_reference": {"path": "configs/demo_probe.yaml", "hash": "cfg-001", "status": "resolved"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {"criterion_id": "SC-02", "name": "user_success_criterion_defined", "kind": "contract", "status": "resolved"},
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            }
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(experiment_spec, ensure_ascii=False, indent=2) + "\n"
            )
            task = {
                "task_id": "task_20260620_102500_replayguard",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "created_at": "2026-06-20T10:20:00Z",
                "started_at": "2026-06-20T10:20:05Z",
                "updated_at": "2026-06-20T10:21:00Z",
                "ended_at": "2026-06-20T10:21:00Z",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260620_102500_replayguard"
            task_dir.mkdir(parents=True, exist_ok=True)
            runner_metrics_payload = {
                "schema_version": "runner_metrics.v0.2",
                "task_id": task["task_id"],
                "intake_id": intake_id,
                "experiment_id": experiment_spec["experiment_id"],
                "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                "producer": {
                    "kind": "experiment_runner",
                    "id": "local-runner",
                    "version": "0.2",
                },
                "generated_at": "2026-06-20T10:21:00Z",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "value": 0.031,
                        "unit": "fraction",
                        "sample_count": 3,
                    }
                ],
            }
            runner_metrics_text = json.dumps(runner_metrics_payload, ensure_ascii=False, indent=2) + "\n"
            runner_metrics_sha = "sha256:" + hashlib.sha256(runner_metrics_text.encode("utf-8")).hexdigest()
            (task_dir / "RUNNER_METRICS.json").write_text(runner_metrics_text)
            (intake_root / "EXPERIMENT_RESULT.json").write_text(
                json.dumps(
                    {
                        "intake_id": intake_id,
                        "source_task_id": "task_20260620_101900_priorconsume",
                        "experiment_id": experiment_spec["experiment_id"],
                        "runner_metrics_artifact": {
                            "present": True,
                            "validated": True,
                            "producer_allowed": True,
                            "trusted": True,
                            "sha256": runner_metrics_sha,
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                {"text": "The bounded probe completed and produced a safe excerpt."},
                deps,
            )

            experiment_result = attachments["experiment_result"]
            self.assertEqual(experiment_result["assessment_basis"], "structural_only")
            self.assertFalse(experiment_result["promotion_eligible"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["validated"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["producer_allowed"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["trusted"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["replay_detected"])
            self.assertEqual(
                experiment_result["runner_metrics_artifact"]["prior_consumed_by_task_id"],
                "task_20260620_101900_priorconsume",
            )
            self.assertIn("already consumed by task", experiment_result["runner_metrics_artifact"]["rejection_reason"])
            self.assertIn("runner_metrics_rejected", experiment_result["limitations"])

    def test_maybe_attach_execution_evaluation_rejects_runner_metrics_hash_mutation_for_same_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deps = self.make_deps(root)
            config = self.Config(root)
            intake_id = "intake_exp_metrics_mutation"
            intake_root = root / ".codex-bridge" / "intake" / intake_id
            intake_root.mkdir(parents=True, exist_ok=True)
            (intake_root / "TASK_CONTRACT.json").write_text(
                json.dumps(
                    {
                        "objective": "bounded_cpu_eval",
                        "mode": "readonly",
                        "prompt": "Run the bounded CPU probe and keep the variant only if the primary metric improves.",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "EVIDENCE_RETRIEVAL.json").write_text(
                json.dumps(
                    {
                        "query": "bounded cpu mutation guard probe",
                        "decision": "safe_to_answer",
                        "read_plan": [{"path": "formal/metric_probe.md", "reason": "primary source"}],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            (intake_root / "RESEARCH_PROGRAM.json").write_text(
                json.dumps({"program_id": "demo-program", "available": True}, ensure_ascii=False, indent=2) + "\n"
            )
            (intake_root / "HYPOTHESIS_REGISTRY.json").write_text(
                json.dumps(
                    {"registry_status": "active", "hypotheses": [{"hypothesis_id": "hypothesis_metric_probe_mutation"}]},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
            experiment_spec = {
                "required": True,
                "objective": "bounded_cpu_eval",
                "task_type": "bounded_execution",
                "hypothesis_ids": ["hypothesis_metric_probe_mutation"],
                "experiment_id": "experiment_metric_probe_mutation",
                "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                "dataset_refs": ["eval://demo/validation"],
                "random_seeds": [42],
                "code_reference": {"commit": "deadbeef"},
                "config_reference": {"path": "configs/demo_probe.yaml"},
                "repeat_count": 3,
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {"criterion_id": "SC-02", "name": "user_success_criterion_defined", "kind": "contract", "status": "resolved"},
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "status": "ready",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    },
                ],
            }
            (intake_root / "EXPERIMENT_SPEC.json").write_text(
                json.dumps(experiment_spec, ensure_ascii=False, indent=2) + "\n"
            )
            task = {
                "task_id": "task_20260620_103000_mutationguard",
                "project": "demo",
                "status": "done",
                "mode": "readonly",
                "created_at": "2026-06-20T10:25:00Z",
                "started_at": "2026-06-20T10:25:05Z",
                "updated_at": "2026-06-20T10:26:00Z",
                "ended_at": "2026-06-20T10:26:00Z",
                "adapter_metadata": {"intake_id": intake_id},
            }
            task_dir = root / "task_20260620_103000_mutationguard"
            task_dir.mkdir(parents=True, exist_ok=True)
            runner_metrics_payload = {
                "schema_version": "runner_metrics.v0.2",
                "task_id": task["task_id"],
                "intake_id": intake_id,
                "experiment_id": experiment_spec["experiment_id"],
                "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                "producer": {
                    "kind": "experiment_runner",
                    "id": "local-runner",
                    "version": "0.2",
                },
                "generated_at": "2026-06-20T10:26:00Z",
                "metrics": [
                    {
                        "metric_id": "M-02",
                        "value": 0.031,
                        "unit": "fraction",
                        "sample_count": 3,
                    }
                ],
            }
            runner_metrics_text = json.dumps(runner_metrics_payload, ensure_ascii=False, indent=2) + "\n"
            current_hash = "sha256:" + hashlib.sha256(runner_metrics_text.encode("utf-8")).hexdigest()
            (task_dir / "RUNNER_METRICS.json").write_text(runner_metrics_text)
            (intake_root / "EXPERIMENT_RESULT.json").write_text(
                json.dumps(
                    {
                        "intake_id": intake_id,
                        "source_task_id": task["task_id"],
                        "experiment_id": experiment_spec["experiment_id"],
                        "runner_metrics_artifact": {
                            "present": True,
                            "validated": True,
                            "producer_allowed": True,
                            "trusted": True,
                            "sha256": "sha256:priorhash",
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )

            attachments = execution_evaluation.maybe_attach_execution_evaluation(
                config,
                task_dir,
                task,
                {"text": "The bounded probe completed and produced a safe excerpt."},
                deps,
            )

            experiment_result = attachments["experiment_result"]
            self.assertNotEqual(current_hash, "sha256:priorhash")
            self.assertEqual(experiment_result["assessment_basis"], "structural_only")
            self.assertFalse(experiment_result["promotion_eligible"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["validated"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["producer_allowed"])
            self.assertFalse(experiment_result["runner_metrics_artifact"]["trusted"])
            self.assertTrue(experiment_result["runner_metrics_artifact"]["replay_detected"])
            self.assertEqual(
                experiment_result["runner_metrics_artifact"]["prior_consumed_by_task_id"],
                task["task_id"],
            )
            self.assertIn("changed after prior evaluation", experiment_result["runner_metrics_artifact"]["rejection_reason"])

    def test_validate_runner_metrics_payload_rejects_metric_unit_mismatch(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_unit",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                    "unit": "fraction",
                }
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260619_160000_unitmismatch",
            "intake_id": "intake_unitmismatch",
            "experiment_id": "experiment_metric_probe_unit",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-19T16:00:00Z",
            "metrics": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "value": 0.031,
                    "unit": "percentage",
                    "sample_count": 3,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260619_160000_unitmismatch",
                "intake_id": "intake_unitmismatch",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("unit does not match ExperimentSpec", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_invalid_generated_at(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_time",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                }
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260619_160100_badtime",
            "intake_id": "intake_badtime",
            "experiment_id": "experiment_metric_probe_time",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-19 16:01:00",
            "metrics": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "value": 0.031,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260619_160100_badtime",
                "intake_id": "intake_badtime",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("generated_at must be a valid timezone-aware timestamp", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_generated_at_before_task_start(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_temporal_start",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                }
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260620_101500_beforestart",
            "intake_id": "intake_beforestart",
            "experiment_id": "experiment_metric_probe_temporal_start",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-20T09:53:59Z",
            "metrics": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "value": 0.031,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260620_101500_beforestart",
                "intake_id": "intake_beforestart",
                "task_started_at": "2026-06-20T10:00:00Z",
                "task_ended_at": "2026-06-20T10:10:00Z",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("predates the task execution window", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_generated_at_after_task_completion(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_temporal_end",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                }
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260620_102000_afterend",
            "intake_id": "intake_afterend",
            "experiment_id": "experiment_metric_probe_temporal_end",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-20T10:16:01Z",
            "metrics": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "value": 0.031,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260620_102000_afterend",
                "intake_id": "intake_afterend",
                "task_started_at": "2026-06-20T10:00:00Z",
                "task_ended_at": "2026-06-20T10:11:00Z",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("later than the task completion window", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_non_binary_value_for_binary_metric(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_binary",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-01",
                    "name": "safe_result_available",
                    "kind": "binary",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                }
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260619_160200_badbinary",
            "intake_id": "intake_badbinary",
            "experiment_id": "experiment_metric_probe_binary",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-19T16:02:00Z",
            "metrics": [
                {
                    "metric_id": "M-01",
                    "name": "safe_result_available",
                    "value": 2,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260619_160200_badbinary",
                "intake_id": "intake_badbinary",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("must be 0 or 1 for binary kind", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_evaluator_owned_metric(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_owned",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-01",
                    "name": "safe_result_available",
                    "kind": "binary",
                    "source": "execution_safe_result_excerpt",
                    "higher_is_better": True,
                }
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260619_160300_ownedmetric",
            "intake_id": "intake_ownedmetric",
            "experiment_id": "experiment_metric_probe_owned",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-19T16:03:00Z",
            "metrics": [
                {
                    "metric_id": "M-01",
                    "name": "safe_result_available",
                    "value": 0,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260619_160300_ownedmetric",
                "intake_id": "intake_ownedmetric",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("evaluator-owned and cannot be supplied by runner", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_duplicate_metric_definition_alias(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_duplicate_alias",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                },
                {
                    "metric_id": "M-03",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                },
            ],
            "success_criteria": [],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260620_100000_duplicatealias",
            "intake_id": "intake_duplicatealias",
            "experiment_id": "experiment_metric_probe_duplicate_alias",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-20T10:00:00Z",
            "metrics": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "value": 0.031,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260620_100000_duplicatealias",
                "intake_id": "intake_duplicatealias",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("ExperimentSpec invalid", rejection_reason)
        self.assertIn("duplicate metric definition alias", rejection_reason)

    def test_validate_runner_metrics_payload_rejects_success_criterion_with_undeclared_metric(self):
        experiment_spec = {
            "experiment_id": "experiment_metric_probe_unknown_criterion_metric",
            "objective": "bounded_cpu_eval",
            "task_type": "bounded_execution",
            "metric_definitions": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "kind": "delta",
                    "source": "runner_metrics",
                    "higher_is_better": True,
                }
            ],
            "success_criteria": [
                {
                    "criterion_id": "SC-01",
                    "name": "precision_gain_positive",
                    "kind": "metric",
                    "metric_name": "precision_gain",
                    "target": {"operator": ">", "value": 0.0},
                }
            ],
            "failure_criteria": [],
        }
        payload = {
            "schema_version": "runner_metrics.v0.2",
            "task_id": "task_20260620_100500_unknowncriterionmetric",
            "intake_id": "intake_unknowncriterionmetric",
            "experiment_id": "experiment_metric_probe_unknown_criterion_metric",
            "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
            "producer": {
                "kind": "experiment_runner",
                "id": "local-runner",
                "version": "0.2",
            },
            "generated_at": "2026-06-20T10:05:00Z",
            "metrics": [
                {
                    "metric_id": "M-02",
                    "name": "accuracy_gain",
                    "value": 0.031,
                }
            ],
        }

        validated, rejection_reason = experiment_contracts.validate_runner_metrics_payload(
            payload,
            evaluation={
                "task_id": "task_20260620_100500_unknowncriterionmetric",
                "intake_id": "intake_unknowncriterionmetric",
            },
            experiment_spec=experiment_spec,
        )

        self.assertEqual(validated, {})
        self.assertIn("ExperimentSpec invalid", rejection_reason)
        self.assertIn("references undeclared metric precision_gain", rejection_reason)

    def test_build_experiment_result_ignores_runner_override_for_evaluator_owned_metric(self):
        experiment_result = research_objects.build_experiment_result(
            {
                "task_status": "done",
                "result_available": True,
                "write_audit": {},
                "task_id": "task_20260619_160400_ownedmetric",
                "intake_id": "intake_ownedmetric",
                "workspace": "demo",
                "updated_at": "2026-06-19T16:04:00Z",
            },
            {
                "required": True,
                "experiment_id": "experiment_metric_probe_owned",
                "hypothesis_ids": ["hypothesis_metric_probe_owned"],
                "metric_definitions": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "kind": "binary",
                        "source": "execution_safe_result_excerpt",
                        "higher_is_better": True,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "kind": "delta",
                        "source": "runner_metrics",
                        "higher_is_better": True,
                    },
                ],
                "success_criteria": [
                    {
                        "criterion_id": "SC-D1",
                        "name": "accuracy_gain_positive",
                        "kind": "metric",
                        "metric_name": "accuracy_gain",
                        "target": {"operator": ">", "value": 0.0},
                    }
                ],
            },
            {},
            {},
            runner_metrics={
                "schema_version": "runner_metrics.v0.2",
                "metrics": [
                    {
                        "metric_id": "M-01",
                        "name": "safe_result_available",
                        "value": 0,
                    },
                    {
                        "metric_id": "M-02",
                        "name": "accuracy_gain",
                        "value": 0.031,
                    },
                ],
            },
            runner_metrics_status={
                "present": True,
                "trusted": True,
            },
        )

        self.assertEqual(experiment_result["metrics"][0]["name"], "safe_result_available")
        self.assertEqual(experiment_result["metrics"][0]["value"], 1)
        self.assertIn("non-empty safe result excerpt", experiment_result["metrics"][0]["notes"])
        self.assertEqual(experiment_result["metrics"][1]["name"], "accuracy_gain")
        self.assertEqual(experiment_result["metrics"][1]["value"], 0.031)

    def test_build_post_run_operator_summary_uses_hypothesis_status_blockers(self):
        summary = operator_summary.build_post_run_operator_summary(
            {
                "intake_id": "intake_operator_summary_hypothesis",
                "workspace": "demo",
                "task_id": "task_20260619_150000_hypothesis_reason",
                "task_status": "done",
                "result_available": True,
                "evidence_retrieval_decision": "safe_to_answer",
            },
            None,
            None,
            {
                "promotion_state": "review_required",
                "decision": "prepare_review_bundle",
                "hypothesis_update": {
                    "status": "testing",
                    "status_reason": "experiment_not_promotion_eligible",
                    "status_blockers": ["runner_metrics_rejected"],
                },
                "notes": ["The hypothesis candidate still has unresolved clarification or review requirements."],
            },
            None,
            None,
            {"validity": {}},
            None,
        )

        self.assertEqual(summary["next_safe_action"]["kind"], "review_hypothesis_promotion")
        self.assertIn("runner_metrics_rejected", summary["next_safe_action"]["reason"])
        self.assertIn("runner_metrics_rejected", summary["blockers"][0]["reason"])
        self.assertEqual(
            summary["next_safe_action"]["remediation"],
            {"category": "promotion_review", "subject": "hypothesis"},
        )

    def test_build_post_run_operator_summary_uses_experiment_failure_criteria(self):
        summary = operator_summary.build_post_run_operator_summary(
            {
                "intake_id": "intake_operator_summary_experiment",
                "workspace": "demo",
                "task_id": "task_20260619_150500_experiment_reason",
                "task_status": "done",
                "result_available": True,
                "evidence_retrieval_decision": "safe_to_answer",
            },
            None,
            None,
            None,
            {
                "promotion_state": "review_required",
                "decision": "prepare_review_bundle",
                "experiment_index_update": {
                    "failure_criteria": [
                        {
                            "name": "accuracy_gain_exceeds_guardrail",
                            "status": "triggered",
                        }
                    ],
                },
                "notes": ["The experiment candidate is structurally ready, but project policy still requires review before publication."],
            },
            None,
            {"validity": {}},
            None,
        )

        self.assertEqual(summary["next_safe_action"]["kind"], "review_experiment_promotion")
        self.assertIn("accuracy_gain_exceeds_guardrail", summary["next_safe_action"]["reason"])
        self.assertIn("accuracy_gain_exceeds_guardrail", summary["blockers"][0]["reason"])
        self.assertEqual(
            summary["next_safe_action"]["remediation"],
            {"category": "promotion_review", "subject": "experiment"},
        )

    def test_build_post_run_operator_summary_sets_transition_review_remediation(self):
        summary = operator_summary.build_post_run_operator_summary(
            {
                "intake_id": "intake_operator_summary_transition",
                "workspace": "demo",
                "task_id": "task_20260619_151000_transition",
                "task_status": "done",
                "result_available": True,
                "evidence_retrieval_decision": "safe_to_answer",
            },
            None,
            None,
            {
                "project_sync": {
                    "status": "transition_review_required",
                    "target_path": "research/proposals/hypotheses/hypothesis_latency_probe.json",
                    "transition_validation": {"reason": "transition_not_allowed"},
                },
            },
            None,
            None,
            {"validity": {}},
            None,
        )

        self.assertEqual(summary["next_safe_action"]["kind"], "review_hypothesis_transition_bundle")
        self.assertEqual(
            summary["next_safe_action"]["remediation"],
            {"category": "transition_review", "subject": "hypothesis"},
        )

    def test_build_post_run_operator_summary_sets_result_review_remediation(self):
        summary = operator_summary.build_post_run_operator_summary(
            {
                "intake_id": "intake_operator_summary_followup",
                "workspace": "demo",
                "task_id": "task_20260619_151500_followup",
                "task_status": "done",
                "result_available": True,
                "evidence_retrieval_decision": "safe_to_answer",
            },
            {
                "recommended_next_action": "review_result",
                "title": "Review the result against prepared evidence",
                "summary": "Use /prepare to review the completed task against the original read plan before making a new claim.",
            },
            None,
            None,
            None,
            None,
            {"validity": {}},
            None,
        )

        self.assertEqual(summary["next_safe_action"]["kind"], "review_result")
        self.assertEqual(
            summary["next_safe_action"]["remediation"],
            {"category": "result_review", "subject": "task_result"},
        )

    def test_build_prepare_operator_summary_surfaces_followup_guidance(self):
        summary = operator_summary.build_prepare_operator_summary(
            {
                "intake_id": "intake_prepare_followup",
                "workspace": "demo",
                "followup_recommended_next_action": "review_result",
                "followup_reason": "Task completed successfully; review the safe result before any promotion.",
                "followup_remediation": {"category": "result_review", "subject": "task_result"},
                "followup_evidence_retrieval_decision": "stale_conclusion",
                "followup_requires_prepare": True,
                "updated_at": "2026-06-19T15:20:00Z",
            },
            {
                "intake_id": "intake_prepare_followup",
                "updated_at": "2026-06-19T15:20:00Z",
                "experiment_decision_gate": {},
            },
            {
                "experiment_gate_status": "not_required",
            },
            {
                "required_action": "run",
                "blocked_by": [],
            },
            {
                "decision": "stale_conclusion",
            },
            [],
        )

        self.assertEqual(summary["overall_status"], "ready_to_run")
        self.assertEqual(summary["next_safe_action"]["kind"], "queue_run")
        self.assertIn("Task completed successfully", summary["next_safe_action"]["reason"])
        self.assertEqual(
            summary["followup_guidance"],
            {
                "recommended_next_action": "review_result",
                "reason": "Task completed successfully; review the safe result before any promotion.",
                "remediation": {"category": "result_review", "subject": "task_result"},
                "evidence_retrieval_decision": "stale_conclusion",
                "requires_prepare": True,
            },
        )
        self.assertIn("follow-up task is ready to run", summary["operator_message"])

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
            self.assertEqual(hypothesis_sync["transition_validation"]["proposed_status"], "inconclusive")
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

    def test_validate_hypothesis_registry_transition_requires_review_for_legacy_active_to_inconclusive(self):
        transition = research_objects.validate_hypothesis_registry_transition(
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "active",
            },
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "inconclusive",
            },
        )

        self.assertEqual(transition["status"], "review_required")
        self.assertEqual(transition["reason"], "transition_not_allowed")
        self.assertEqual(transition["current_status"], "active")
        self.assertEqual(transition["proposed_status"], "inconclusive")

    def test_validate_hypothesis_registry_transition_accepts_legacy_active_to_testing(self):
        transition = research_objects.validate_hypothesis_registry_transition(
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "active",
            },
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "testing",
            },
        )

        self.assertEqual(transition["status"], "valid")
        self.assertEqual(transition["reason"], "ok")
        self.assertEqual(transition["current_status"], "active")
        self.assertEqual(transition["proposed_status"], "testing")

    def test_validate_hypothesis_registry_transition_requires_review_for_new_inconclusive_record(self):
        transition = research_objects.validate_hypothesis_registry_transition(
            None,
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "inconclusive",
            },
        )

        self.assertEqual(transition["status"], "review_required")
        self.assertEqual(transition["reason"], "transition_not_allowed")
        self.assertIsNone(transition["current_status"])
        self.assertEqual(transition["proposed_status"], "inconclusive")

    def test_validate_hypothesis_registry_transition_allows_new_supported_historical_import(self):
        transition = research_objects.validate_hypothesis_registry_transition(
            None,
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "supported",
                "imported_from_history": True,
                "import_review_id": "review_20260619_001",
                "source": {"origin": "historical_import"},
                "supporting_evidence": [{"kind": "document", "path": "research/history/latency_probe.md"}],
            },
        )

        self.assertEqual(transition["status"], "valid")
        self.assertEqual(transition["reason"], "historical_import_ok")
        self.assertIsNone(transition["current_status"])
        self.assertEqual(transition["proposed_status"], "supported")

    def test_validate_hypothesis_registry_transition_requires_complete_historical_import_metadata(self):
        transition = research_objects.validate_hypothesis_registry_transition(
            None,
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "supported",
                "imported_from_history": True,
                "source": {"origin": "historical_import"},
            },
        )

        self.assertEqual(transition["status"], "review_required")
        self.assertEqual(transition["reason"], "historical_import_metadata_required")
        self.assertEqual(
            transition["missing_requirements"],
            ["import_review_id", "supporting_evidence"],
        )
        self.assertIsNone(transition["current_status"])
        self.assertEqual(transition["proposed_status"], "supported")

    def test_validate_hypothesis_registry_transition_requires_testing_before_supported_to_refuted(self):
        transition = research_objects.validate_hypothesis_registry_transition(
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "supported",
            },
            {
                "hypothesis_id": "hypothesis_latency_probe",
                "status": "refuted",
            },
        )

        self.assertEqual(transition["status"], "review_required")
        self.assertEqual(transition["reason"], "transition_not_allowed")
        self.assertEqual(transition["current_status"], "supported")
        self.assertEqual(transition["proposed_status"], "refuted")

    def test_sync_project_hypothesis_registry_applies_new_supported_historical_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sync = research_objects.sync_project_hypothesis_registry(
                root,
                {
                    "source_task_id": "task_20260619_120000_import",
                    "promotion_state": "candidate_ready",
                    "updated_at": "2026-06-19T12:00:00Z",
                    "hypothesis_update": {
                        "hypothesis_id": "hypothesis_latency_probe",
                        "program_id": "demo-program",
                        "claim": "Latency can be reduced with a bounded cache strategy.",
                        "mechanism": "Historical measurements showed fewer blocking lookups.",
                        "prediction": [],
                        "falsification_criteria": [],
                        "required_experiments": [],
                        "scope": {},
                        "supporting_evidence": [
                            {"kind": "document", "path": "research/history/latency_probe.md"}
                        ],
                        "contradicting_evidence": [],
                        "confidence": {"value": 0.7},
                        "source": {"origin": "historical_import"},
                        "imported_from_history": True,
                        "import_review_id": "review_20260619_001",
                        "status": "supported",
                    },
                },
            )

            self.assertEqual(sync["status"], "applied")
            self.assertEqual(sync["transition_validation"]["reason"], "historical_import_ok")
            records = [
                json.loads(line)
                for line in (root / "research" / "HYPOTHESIS_REGISTRY.jsonl").read_text().strip().splitlines()
                if line.strip()
            ]
            self.assertEqual(len(records), 1)
            self.assertTrue(records[0]["imported_from_history"])
            self.assertEqual(records[0]["import_review_id"], "review_20260619_001")
            self.assertEqual(records[0]["status"], "supported")

    def test_experiment_promotion_state_requires_review_when_result_is_not_promotion_eligible(self):
        promotion_state = research_objects.experiment_promotion_state(
            {
                "task_status": "done",
                "result_available": True,
            },
            {
                "required": True,
            },
            {},
            {},
            {
                "promotion_eligible": False,
            },
        )

        self.assertEqual(promotion_state, "review_required")

    def test_hypothesis_promotion_state_returns_not_required_for_analysis_only_registry(self):
        promotion_state = research_objects.hypothesis_promotion_state(
            {
                "task_status": "done",
                "result_available": True,
            },
            {
                "registry_status": "analysis_only",
                "hypotheses": [{"hypothesis_id": "hypothesis_latency_probe"}],
            },
            {},
        )

        self.assertEqual(promotion_state, "not_required")

    def test_current_conclusions_promotion_state_returns_bounded_only_for_auxiliary_evidence(self):
        promotion_state = research_objects.current_conclusions_promotion_state(
            {
                "task_status": "done",
                "result_available": True,
                "evidence_retrieval_decision": "stale_conclusion",
            },
            {},
            {},
        )

        self.assertEqual(promotion_state, "bounded_only")

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
