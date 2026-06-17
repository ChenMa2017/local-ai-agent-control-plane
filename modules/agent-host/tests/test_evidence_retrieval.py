import tempfile
import unittest
from pathlib import Path

import evidence_retrieval


class EvidenceRetrievalTests(unittest.TestCase):
    def test_returns_not_required_when_gate_is_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp)
            result = evidence_retrieval.maybe_run_evidence_retrieval(
                project_root,
                "simple summary",
                "",
                "report_only",
                {"mentions_experiment": False, "wants_evidence_index": False},
                lambda text, _max_chars: text,
                lambda *_args: False,
            )

        self.assertFalse(result["required"])
        self.assertFalse(result["consulted"])
        self.assertEqual(result["reason"], "query does not currently require metadata-first evidence retrieval")

    def test_reports_missing_script_when_index_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp)
            (project_root / "project_index").mkdir(parents=True)
            result = evidence_retrieval.maybe_run_evidence_retrieval(
                project_root,
                "compare baseline",
                "",
                "bounded_cpu_eval",
                {"mentions_experiment": True, "wants_evidence_index": False},
                lambda text, _max_chars: text,
                lambda *_args: True,
            )

        self.assertTrue(result["required"])
        self.assertTrue(result["available"])
        self.assertFalse(result["consulted"])
        self.assertIn("missing", result["reason"])

    def test_parses_successful_retrieval_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_root = Path(tmp)
            (project_root / "project_index").mkdir(parents=True)
            script = project_root / "agent" / "bin" / "watchdog_doc_search.py"
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text(
                "#!/usr/bin/env python3\n"
                "import json\n"
                "print(json.dumps({"
                "\"decision\": \"safe_to_answer\", "
                "\"warnings\": [\"stale index\"], "
                "\"read_plan\": [{\"path\": \"formal/report.md\", \"reason\": \"primary source\"}], "
                "\"hits\": [{\"doc_id\": \"doc1\"}]"
                "}))\n"
            )
            script.chmod(0o755)

            result = evidence_retrieval.maybe_run_evidence_retrieval(
                project_root,
                "route status",
                "",
                "report_only",
                {"mentions_experiment": False, "wants_evidence_index": True},
                lambda text, _max_chars: text,
                lambda *_args: True,
            )

        self.assertTrue(result["consulted"])
        self.assertEqual(result["decision"], "safe_to_answer")
        self.assertEqual(result["warnings"], ["stale index"])
        self.assertEqual(result["read_plan"][0]["path"], "formal/report.md")
        self.assertEqual(result["hits"][0]["doc_id"], "doc1")
        self.assertEqual(result["reason"], "retrieval completed")


if __name__ == "__main__":
    unittest.main()
