import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import research_store


class ResearchStoreTests(unittest.TestCase):
    def test_write_json_atomic_replaces_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "registry.json"

            research_store.write_json_atomic(path, {"value": 1})

            self.assertEqual(json.loads(path.read_text()), {"value": 1})

    def test_write_json_atomic_preserves_previous_file_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "registry.json"
            path.write_text(json.dumps({"value": "old"}, ensure_ascii=False) + "\n")

            with mock.patch("research_store.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    research_store.write_json_atomic(path, {"value": "new"})

            self.assertEqual(json.loads(path.read_text()), {"value": "old"})
            temp_files = list(path.parent.glob(f".{path.name}.*.tmp"))
            self.assertEqual(temp_files, [])

    def test_write_jsonl_atomic_replaces_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "registry.jsonl"

            research_store.write_jsonl_atomic(
                path,
                [
                    {"id": "a", "value": 1},
                    {"id": "b", "value": 2},
                ],
            )

            lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
            self.assertEqual(
                lines,
                [
                    {"id": "a", "value": 1},
                    {"id": "b", "value": 2},
                ],
            )

    def test_write_jsonl_atomic_preserves_previous_file_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "registry.jsonl"
            path.write_text(json.dumps({"id": "old"}, ensure_ascii=False) + "\n")

            with mock.patch("research_store.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    research_store.write_jsonl_atomic(
                        path,
                        [
                            {"id": "new"},
                        ],
                    )

            lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
            self.assertEqual(lines, [{"id": "old"}])
            temp_files = list(path.parent.glob(f".{path.name}.*.tmp"))
            self.assertEqual(temp_files, [])
