import unittest

import prepare_intent


class PrepareIntentTests(unittest.TestCase):
    def test_build_gray_areas_flags_write_scope_and_reference(self):
        prompt = "Please fix this quickly."
        answers = ""
        signals = prepare_intent.parse_intent_signals(prompt, answers)
        gray_areas = prepare_intent.build_gray_areas(prompt, answers, "", signals)

        self.assertIn("write_scope_missing", gray_areas)
        self.assertIn("target_reference_missing", gray_areas)

    def test_gpu_experiment_gate_blocks_when_details_are_missing(self):
        prompt = "Run a GPU experiment to compare the new method."
        answers = ""
        signals = prepare_intent.parse_intent_signals(prompt, answers)
        objective = prepare_intent.infer_objective(signals)
        gate = prepare_intent.build_experiment_decision_gate(prompt, answers, objective, signals)

        self.assertEqual(objective, "gpu")
        self.assertTrue(gate["required"])
        self.assertTrue(gate["blocking"])
        self.assertGreaterEqual(gate["resolved_count"], 1)
        self.assertIn("control_definition_missing", gate["unresolved_items"])
        self.assertIn("fairness_constraint_missing", gate["unresolved_items"])
        self.assertIn("success_criterion_missing", gate["unresolved_items"])

    def test_clarification_questions_cap_at_three(self):
        gray_areas = [
            "target_reference_missing",
            "write_scope_missing",
            "experiment_question_missing",
            "control_definition_missing",
            "fairness_constraint_missing",
            "success_criterion_missing",
        ]
        signals = {
            "wants_write": True,
            "wants_local_workspace_copy": False,
            "wants_cpu_eval": False,
        }

        questions = prepare_intent.clarification_questions(gray_areas, signals)

        self.assertEqual(len(questions), 3)
        self.assertIn("reference_task_id", questions[0])

    def test_evidence_retrieval_summary_normalizes_fields(self):
        summary = prepare_intent.evidence_retrieval_summary({
            "required": 1,
            "available": True,
            "consulted": False,
            "query": "route status",
            "decision": "safe_to_answer",
            "warnings": ["stale index"],
            "read_plan": [{"path": "formal/report.md", "reason": "primary"}],
            "reason": "retrieval completed",
        })

        self.assertEqual(summary["query"], "route status")
        self.assertEqual(summary["decision"], "safe_to_answer")
        self.assertEqual(summary["warnings"], ["stale index"])
        self.assertEqual(summary["read_plan"][0]["path"], "formal/report.md")

    def test_read_plan_markdown_handles_empty_plan(self):
        markdown = prepare_intent.read_plan_markdown({
            "required": True,
            "available": True,
            "consulted": True,
            "decision": "safe_to_answer",
            "reason": "retrieval completed",
            "warnings": [],
            "read_plan": [],
        })

        self.assertIn("# Evidence Retrieval", markdown)
        self.assertIn("- No read-plan entries were produced.", markdown)


if __name__ == "__main__":
    unittest.main()
