import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import bridge


class BridgeHttpE2ETests(unittest.TestCase):
    def make_config(self, workspace_root: Path, codex_root: Path) -> bridge.BridgeConfig:
        return bridge.BridgeConfig(
            host="127.0.0.1",
            port=0,
            mattermost_tokens=("token-1",),
            allowed_users=("chenma",),
            projects={"demo": bridge.Project(name="demo", root=workspace_root)},
            codex_bridge_root=codex_root,
            codex_bridge_node_bin="node",
            auth_tokens={
                "bearer-1": bridge.AuthPrincipal(user="chenma", role="admin"),
            },
        )

    def write_watchdog_doc_search(self, workspace_root: Path, payload: dict[str, object]) -> None:
        script = workspace_root / "agent" / "bin" / "watchdog_doc_search.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            f"print(json.dumps({json.dumps(payload, ensure_ascii=False)}))\n"
        )
        script.chmod(0o755)

    def write_codex_bridge_script(
        self,
        codex_root: Path,
        *,
        task_id: str,
        result_text: str,
        runner_metrics: dict[str, object] | None = None,
    ) -> None:
        script = codex_root / "scripts" / "codex-bridge.js"
        script.parent.mkdir(parents=True, exist_ok=True)
        runner_metrics_write = (
            f"  fs.writeFileSync(path.join(taskDir, 'RUNNER_METRICS.json'), JSON.stringify({json.dumps(runner_metrics, ensure_ascii=False)}, null, 2));\n"
            if runner_metrics is not None
            else ""
        )
        script.write_text(
            "const fs = require('fs');\n"
            "const path = require('path');\n"
            "const args = process.argv.slice(2);\n"
            "const root = path.resolve(__dirname, '..');\n"
            "function readFlag(flag, fallback = '') {\n"
            "  const idx = args.indexOf(flag);\n"
            "  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;\n"
            "}\n"
            "function readJsonFlag(flag) {\n"
            "  try { return JSON.parse(readFlag(flag, '{}') || '{}'); } catch (_err) { return {}; }\n"
            "}\n"
            f"const taskId = {json.dumps(task_id)};\n"
            "if (args[0] === 'run') {\n"
            "  const taskDir = path.join(root, '.codex-bridge', 'tasks', taskId);\n"
            "  fs.mkdirSync(taskDir, { recursive: true });\n"
            "  const task = {\n"
            "    version: 1,\n"
            "    task_id: taskId,\n"
            "    status: 'done',\n"
            "    user: readFlag('--user', 'chenma'),\n"
            "    project: readFlag('--project', 'demo'),\n"
            "    source: readFlag('--source', 'web'),\n"
            "    project_path: path.join(root, 'secret-real-project-path'),\n"
            "    mode: readFlag('--mode', 'readonly'),\n"
            "    prompt: args[args.length - 1] || '',\n"
            "    created_at: '2026-06-18T12:00:00.000Z',\n"
            "    updated_at: '2026-06-18T12:01:00.000Z',\n"
            "    started_at: '2026-06-18T12:00:05.000Z',\n"
            "    ended_at: '2026-06-18T12:01:00.000Z',\n"
            "    exit_code: 0,\n"
            "    adapter_metadata: readJsonFlag('--metadata'),\n"
            "  };\n"
            "  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2));\n"
            f"  fs.writeFileSync(path.join(taskDir, 'result.md'), {json.dumps(result_text)});\n"
            + runner_metrics_write
            + "  fs.writeFileSync(path.join(taskDir, 'bridge.log'), 'log line\\n');\n"
            "  console.log(`queued ${taskId}`);\n"
            "  process.exit(0);\n"
            "}\n"
            "if (args[0] === 'result') {\n"
            "  console.log(JSON.stringify({\n"
            "    task_id: taskId,\n"
            f"    text: {json.dumps(result_text)},\n"
            "    raw: false,\n"
            "    redacted: true,\n"
            "    truncated: false\n"
            "  }));\n"
            "  process.exit(0);\n"
            "}\n"
            "if (args[0] === 'logs') {\n"
            "  console.log(JSON.stringify({\n"
            "    task_id: taskId,\n"
            "    text: 'log line\\n',\n"
            "    raw: false,\n"
            "    redacted: true,\n"
            "    truncated: false,\n"
            "    lines_returned: 1\n"
            "  }));\n"
            "  process.exit(0);\n"
            "}\n"
            "if (args[0] === 'status') {\n"
            "  console.log(`task_id: ${taskId}`);\n"
            "  console.log('status: done');\n"
            "  process.exit(0);\n"
            "}\n"
            "console.log('ok');\n"
        )

    def request_json(
        self,
        base_url: str,
        path: str,
        *,
        method: str = "GET",
        token: str = "bearer-1",
        payload: dict[str, object] | None = None,
    ) -> dict[str, object]:
        data = None
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def wait_for_server(self, base_url: str) -> None:
        deadline = time.monotonic() + 5
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                data = self.request_json(base_url, "/health", token="")
                if data.get("ok") is True:
                    return
            except (urllib.error.URLError, ConnectionError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                time.sleep(0.05)
        if last_error:
            raise last_error
        raise AssertionError("server did not become ready")

    def test_http_e2e_prepare_run_result_page_and_intake(self):
        bridge.STREAM_TOKENS.clear()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_root = root / "workspace"
            workspace_root.mkdir(parents=True)
            (workspace_root / "project_index").mkdir(parents=True)
            codex_root = root / "codex-bridge"
            self.write_watchdog_doc_search(
                workspace_root,
                {
                    "query": "What is the current best candidate?",
                    "decision": "stale_conclusion",
                    "warnings": ["matching current conclusion is stale and should be rechecked before citation"],
                    "read_plan": [{"path": "formal/current_best.md", "reason": "supports current conclusion: current best candidate"}],
                    "hits": [{"kind": "current_conclusion", "id": "current_best_candidate", "score": 6.0}],
                },
            )
            self.write_codex_bridge_script(
                codex_root,
                task_id="task_20260618_120000_e2e01",
                result_text="safe result summary for e2e validation",
            )
            config = self.make_config(workspace_root, codex_root)

            handler_class = type(
                "ConfiguredWatchdogBridgeHandler",
                (bridge.WatchdogBridgeHandler,),
                {"config": config},
            )
            server = ThreadingHTTPServer((config.host, 0), handler_class)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://{config.host}:{server.server_port}"
                self.wait_for_server(base_url)

                prepared = self.request_json(
                    base_url,
                    "/codex/prepare",
                    method="POST",
                    payload={
                        "workspace": "demo",
                        "prompt": "What is the current best candidate?",
                        "source": "web",
                    },
                )
                self.assertTrue(prepared["ok"])
                self.assertEqual(prepared["status"], "prepared")
                self.assertTrue(prepared["ready_to_run"])
                self.assertEqual(prepared["evidence_retrieval"]["decision"], "stale_conclusion")
                intake_id = prepared["intake_id"]

                queued = self.request_json(
                    base_url,
                    "/codex/run",
                    method="POST",
                    payload={
                        "workspace": "demo",
                        "intake_id": intake_id,
                    },
                )
                self.assertTrue(queued["ok"])
                self.assertEqual(queued["task_id"], "task_20260618_120000_e2e01")
                self.assertEqual(queued["intake_id"], intake_id)
                self.assertEqual(queued["prepare_context"]["objective"], "report_only")

                page = self.request_json(
                    base_url,
                    "/codex/result-page?task_id=task_20260618_120000_e2e01&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["task_id"], "task_20260618_120000_e2e01")
                self.assertEqual(page["intake_id"], intake_id)
                self.assertEqual(page["text"], "safe result summary for e2e validation")
                self.assertEqual(page["execution_evaluation"]["execution_decision"], "result_ready_for_review")
                self.assertEqual(page["followup_task_draft"]["recommended_next_action"], "review_result")
                self.assertEqual(page["review_proposal_draft"]["review_scope"], "report_only")
                self.assertEqual(page["followup_task_draft"]["provenance"]["artifact_role"], "followup_task_draft")
                self.assertEqual(page["review_proposal_draft"]["provenance"]["generated_by"], "agent_host_post_run_artifacts")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "not_required")
                self.assertEqual(page["hypothesis_promotion"]["project_sync"]["status"], "not_required")
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "not_required")
                self.assertEqual(page["experiment_promotion"]["project_sync"]["status"], "not_required")
                self.assertEqual(page["current_conclusion_update"]["conclusion_status"], "auxiliary_only")
                self.assertEqual(page["current_conclusion_promotion"]["promotion_state"], "bounded_only")
                self.assertEqual(page["current_conclusion_promotion"]["project_sync"]["status"], "bounded_only")
                self.assertEqual(page["evaluation_report"]["hypothesis_promotion_state"], "not_required")
                self.assertEqual(page["evaluation_report"]["experiment_promotion_state"], "not_required")
                self.assertEqual(page["evaluation_report"]["current_conclusions_promotion_state"], "bounded_only")
                self.assertEqual(page["evaluation_report"]["assessment_basis"], "structural_only")
                self.assertEqual(page["evaluation_report"]["validity"]["status"], "valid_with_limitations")
                self.assertEqual(page["operator_summary"]["overall_status"], "review_required")
                self.assertEqual(page["operator_summary"]["next_safe_action"]["target_path"], "research/proposals/current_conclusions/")
                self.assertEqual(page["current_conclusions"]["promotion_state"], "bounded_only")

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["intake_id"], intake_id)
                self.assertEqual(intake["execution_evaluation"]["execution_decision"], "result_ready_for_review")
                self.assertEqual(intake["followup_task_draft"]["source_task_id"], "task_20260618_120000_e2e01")
                self.assertEqual(intake["ledger_note_draft"]["target_path_hint"], "research/LEDGER_NOTES.md")
                self.assertEqual(intake["review_proposal_draft"]["review_scope"], "report_only")
                self.assertEqual(intake["ledger_note_draft"]["provenance"]["artifact_role"], "ledger_note_draft")
                self.assertEqual(intake["operator_summary"]["overall_status"], "review_required")
                self.assertEqual(intake["operator_summary"]["next_safe_action"]["target_path"], "research/proposals/current_conclusions/")
                self.assertEqual(intake["hypothesis_promotion"]["promotion_state"], "not_required")
                self.assertEqual(intake["experiment_promotion"]["promotion_state"], "not_required")
                self.assertEqual(intake["current_conclusion_update"]["source_task_id"], "task_20260618_120000_e2e01")
                self.assertEqual(intake["current_conclusion_promotion"]["decision"], "bounded_only_do_not_publish")
                self.assertEqual(intake["current_conclusion_promotion"]["project_sync"]["status"], "bounded_only")
                self.assertGreaterEqual(intake["event_count"], 10)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_http_e2e_bounded_cpu_eval_persists_experiment_result(self):
        bridge.STREAM_TOKENS.clear()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_root = root / "workspace"
            workspace_root.mkdir(parents=True)
            (workspace_root / "project_index").mkdir(parents=True)
            codex_root = root / "codex-bridge"
            self.write_watchdog_doc_search(
                workspace_root,
                {
                    "query": "bounded cpu latency probe status",
                    "decision": "safe_to_answer",
                    "warnings": [],
                    "read_plan": [{"path": "formal/latency_probe.md", "reason": "primary source"}],
                    "hits": [{"kind": "current_conclusion", "id": "latency_probe_status", "score": 6.0}],
                },
            )
            self.write_codex_bridge_script(
                codex_root,
                task_id="task_20260619_120000_e2eexp01",
                result_text="Latency stayed within the bounded target during the CPU probe.",
            )
            config = self.make_config(workspace_root, codex_root)

            handler_class = type(
                "ConfiguredWatchdogBridgeHandler",
                (bridge.WatchdogBridgeHandler,),
                {"config": config},
            )
            server = ThreadingHTTPServer((config.host, 0), handler_class)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://{config.host}:{server.server_port}"
                self.wait_for_server(base_url)

                prepared = self.request_json(
                    base_url,
                    "/codex/prepare",
                    method="POST",
                    payload={
                        "workspace": "demo",
                        "prompt": "Run a bounded CPU experiment to compare baseline vs variant with same data and same budget; success criterion accuracy.",
                        "source": "web",
                    },
                )
                self.assertTrue(prepared["ok"])
                self.assertEqual(prepared["contract"]["objective"], "bounded_cpu_eval")
                self.assertTrue(prepared["decision_gate"]["required"])
                self.assertTrue(prepared["ready_to_run"])
                intake_id = prepared["intake_id"]

                queued = self.request_json(
                    base_url,
                    "/codex/run",
                    method="POST",
                    payload={
                        "workspace": "demo",
                        "intake_id": intake_id,
                    },
                )
                self.assertTrue(queued["ok"])
                self.assertEqual(queued["task_id"], "task_20260619_120000_e2eexp01")
                self.assertEqual(queued["prepare_context"]["objective"], "bounded_cpu_eval")

                page = self.request_json(
                    base_url,
                    "/codex/result-page?task_id=task_20260619_120000_e2eexp01&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertIsNone(page["review_proposal_draft"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "structural_only")
                self.assertEqual(page["experiment_result"]["validity"], "valid")
                self.assertEqual(page["experiment_result"]["result"], "inconclusive")
                self.assertEqual(page["experiment_result"]["metrics"][0]["name"], "safe_result_available")
                self.assertEqual(page["experiment_result"]["metrics"][0]["value"], 1)
                self.assertIn("reproducibility_contract_incomplete", page["experiment_result"]["limitations"])
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["experiment_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["evaluation_report"]["experiment_result"]["result"], "inconclusive")
                self.assertEqual(page["evaluation_report"]["experiment_assessment"]["result"], "inconclusive")
                self.assertEqual(page["evaluation_report"]["experiment_assessment"]["validity"], "valid")
                self.assertEqual(page["evaluation_report"]["validity"]["status"], "valid_structural_only")
                self.assertEqual(page["current_conclusion_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["current_conclusion_promotion"]["project_sync"]["status"], "applied")

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["experiment_result"]["result"], "inconclusive")
                self.assertEqual(intake["experiment_promotion"]["promotion_state"], "candidate_ready")
                self.assertGreaterEqual(intake["event_count"], 11)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()


if __name__ == "__main__":
    unittest.main()
