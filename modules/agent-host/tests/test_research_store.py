import json
import multiprocessing
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import research_store


def hold_file_lock(lock_path: str, ready_queue, release_queue) -> None:
    with research_store.advisory_file_lock(Path(lock_path)):
        ready_queue.put("locked")
        release_queue.get(timeout=5)


def acquire_file_lock(lock_path: str, elapsed_queue) -> None:
    started = time.monotonic()
    with research_store.advisory_file_lock(Path(lock_path)):
        elapsed_queue.put(time.monotonic() - started)


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

    def test_advisory_file_lock_blocks_other_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "registry.jsonl.lock"
            ctx = multiprocessing.get_context("fork")
            ready_queue = ctx.Queue()
            release_queue = ctx.Queue()
            elapsed_queue = ctx.Queue()
            holder = ctx.Process(target=hold_file_lock, args=(str(lock_path), ready_queue, release_queue))
            waiter = ctx.Process(target=acquire_file_lock, args=(str(lock_path), elapsed_queue))
            try:
                holder.start()
                self.assertEqual(ready_queue.get(timeout=5), "locked")
                waiter.start()
                time.sleep(0.2)
                self.assertTrue(elapsed_queue.empty())
                release_queue.put("release")
                elapsed = elapsed_queue.get(timeout=5)
                self.assertGreaterEqual(elapsed, 0.15)
            finally:
                if holder.is_alive():
                    holder.terminate()
                if waiter.is_alive():
                    waiter.terminate()
                holder.join(timeout=5)
                waiter.join(timeout=5)
