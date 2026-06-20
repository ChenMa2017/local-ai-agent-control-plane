import unittest

from agent_host.intake import prepared_context


class PreparedContextTests(unittest.TestCase):
    def test_load_intake_questions_prefers_json_items(self):
        questions = prepared_context.load_intake_questions_from_sources(
            {"items": ["Q1", "Q2", ""]},
            "1. ignored",
        )

        self.assertEqual(questions, ["Q1", "Q2"])

    def test_load_intake_questions_falls_back_to_markdown(self):
        questions = prepared_context.load_intake_questions_from_sources(
            None,
            "1. First question\n2. Second question\n\nnot-a-question\n",
        )

        self.assertEqual(questions, ["First question", "Second question"])

    def test_count_jsonl_records_ignores_blank_lines(self):
        self.assertEqual(prepared_context.count_jsonl_records('{"a":1}\n\n{"b":2}\n'), 2)

    def test_filter_source_task_artifact_drops_mismatched_source(self):
        artifact = {"source_task_id": "task-other", "title": "wrong"}
        filtered = prepared_context.filter_source_task_artifact(artifact, "task-123", "source_task_id")

        self.assertEqual(filtered, {})

    def test_prepared_run_prompt_includes_claim_boundary_when_evidence_is_not_safe(self):
        bundle = {
            "intake_id": "intake_demo",
            "contract": {
                "objective": "report_only",
                "prompt": "Summarize the route status.",
                "answers_summary": "Focus on bounded evidence.",
            },
            "taskbox": {
                "workspace_mode": "readonly",
                "allowed_runner": "report_only",
            },
            "evidence_retrieval": {
                "required": True,
                "decision": "stale_conclusion",
                "warnings": ["index is stale"],
                "read_plan": [{"path": "formal/status.md", "reason": "primary source"}],
            },
        }

        prompt = prepared_context.prepared_run_prompt(
            bundle,
            "Keep it narrow.",
            lambda text, _max_chars: text,
            4000,
        )

        self.assertIn("Claim boundary:", prompt)
        self.assertIn("formal/status.md", prompt)
        self.assertIn("Keep it narrow.", prompt)


if __name__ == "__main__":
    unittest.main()
