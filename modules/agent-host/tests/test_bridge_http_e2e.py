import datetime as dt
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
import experiment_contracts


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
        task_created_at = "2026-06-18T12:00:00.000Z"
        task_started_at = "2026-06-18T12:00:05.000Z"
        task_updated_at = "2026-06-18T12:01:00.000Z"
        task_ended_at = "2026-06-18T12:01:00.000Z"
        if isinstance(runner_metrics, dict):
            generated_at_text = str(runner_metrics.get("generated_at") or "").strip()
            if generated_at_text:
                generated_at = dt.datetime.fromisoformat(generated_at_text.replace("Z", "+00:00"))
                task_started = generated_at - dt.timedelta(minutes=5)
                task_created = task_started - dt.timedelta(seconds=5)
                task_ended = generated_at
                task_created_at = task_created.isoformat().replace("+00:00", "Z")
                task_started_at = task_started.isoformat().replace("+00:00", "Z")
                task_updated_at = task_ended.isoformat().replace("+00:00", "Z")
                task_ended_at = task_ended.isoformat().replace("+00:00", "Z")
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
            f"    created_at: {json.dumps(task_created_at)},\n"
            f"    updated_at: {json.dumps(task_updated_at)},\n"
            f"    started_at: {json.dumps(task_started_at)},\n"
            f"    ended_at: {json.dumps(task_ended_at)},\n"
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
                self.assertEqual(
                    page["followup_task_draft"]["remediation"],
                    {"category": "result_review", "subject": "task_result"},
                )
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
                self.assertEqual(
                    intake["followup_task_draft"]["remediation"],
                    {"category": "result_review", "subject": "task_result"},
                )
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

    def test_http_e2e_bounded_cpu_eval_uses_trusted_runner_metrics_artifact(self):
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
                experiment_spec = prepared["experiment_spec"]
                task_id = "task_20260619_120100_e2etrusted"

                self.write_codex_bridge_script(
                    codex_root,
                    task_id=task_id,
                    result_text="The bounded CPU probe completed and exported structured metrics for the primary domain slot.",
                    runner_metrics={
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task_id,
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-19T12:01:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                                "artifact_refs": ["artifacts/domain_primary_metric.json"],
                                "notes": "Variant improved the observed primary metric by 3.1 points.",
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                )

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
                self.assertEqual(queued["task_id"], task_id)
                self.assertEqual(queued["prepare_context"]["objective"], "bounded_cpu_eval")

                page = self.request_json(
                    base_url,
                    f"/codex/result-page?task_id={task_id}&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "runner_metrics")
                self.assertEqual(page["experiment_result"]["evidence_strength"], "metric_backed")
                self.assertEqual(page["experiment_result"]["validity"], "valid")
                self.assertEqual(page["experiment_result"]["provisional_result"], "inconclusive")
                self.assertEqual(page["experiment_result"]["result"], "inconclusive")
                self.assertEqual(page["experiment_result"]["final_result"], "inconclusive")
                self.assertEqual(page["experiment_result"]["adjudication_status"], "accepted")
                self.assertTrue(page["experiment_result"]["promotion_eligible"])
                self.assertTrue(page["experiment_result"]["runner_metrics_artifact"]["present"])
                self.assertTrue(page["experiment_result"]["runner_metrics_artifact"]["validated"])
                self.assertTrue(page["experiment_result"]["runner_metrics_artifact"]["producer_allowed"])
                self.assertTrue(page["experiment_result"]["runner_metrics_artifact"]["trusted"])
                self.assertTrue(str(page["experiment_result"]["runner_metrics_artifact"]["sha256"]).startswith("sha256:"))
                self.assertEqual(page["experiment_result"]["metrics"][1]["name"], "domain_primary_metric")
                self.assertEqual(page["experiment_result"]["metrics"][1]["value"], 0.031)
                self.assertEqual(page["experiment_result"]["baseline_comparison"]["status"], "observed")
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["experiment_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["hypothesis_promotion"]["project_sync"]["status"], "transition_review_required")
                self.assertEqual(
                    page["hypothesis_promotion"]["project_sync"]["transition_validation"]["reason"],
                    "transition_not_allowed",
                )
                self.assertEqual(page["evaluation_report"]["assessment_basis"], "runner_metrics")
                self.assertEqual(page["evaluation_report"]["validity"]["status"], "valid_metric_backed")
                self.assertEqual(page["evaluation_report"]["experiment_assessment"]["result"], "inconclusive")
                self.assertEqual(page["operator_summary"]["overall_status"], "review_required")
                self.assertEqual(
                    page["operator_summary"]["next_safe_action"]["kind"],
                    "review_hypothesis_transition_bundle",
                )

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["experiment_result"]["assessment_basis"], "runner_metrics")
                self.assertEqual(intake["experiment_result"]["runner_metrics_artifact"]["validated"], True)
                self.assertEqual(intake["experiment_result"]["runner_metrics_artifact"]["producer_allowed"], True)
                self.assertEqual(intake["experiment_result"]["runner_metrics_artifact"]["trusted"], True)
                self.assertTrue(str(intake["experiment_result"]["runner_metrics_artifact"]["sha256"]).startswith("sha256:"))
                self.assertEqual(intake["experiment_result"]["metrics"][1]["value"], 0.031)
                self.assertEqual(intake["experiment_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(intake["hypothesis_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(intake["hypothesis_promotion"]["project_sync"]["status"], "transition_review_required")
                self.assertGreaterEqual(intake["event_count"], 11)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_http_e2e_bounded_cpu_eval_rejects_mismatched_runner_metrics_artifact(self):
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
                experiment_spec = prepared["experiment_spec"]
                task_id = "task_20260619_120200_e2ereject"

                self.write_codex_bridge_script(
                    codex_root,
                    task_id=task_id,
                    result_text="The bounded CPU probe completed, but the runner metrics artifact was stale.",
                    runner_metrics={
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task_id,
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": "sha256:not-the-current-spec",
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-19T12:02:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                            }
                        ],
                    },
                )

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
                self.assertEqual(queued["task_id"], task_id)
                self.assertEqual(queued["prepare_context"]["objective"], "bounded_cpu_eval")

                page = self.request_json(
                    base_url,
                    f"/codex/result-page?task_id={task_id}&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "structural_only")
                self.assertEqual(page["experiment_result"]["evidence_strength"], "structural_only")
                self.assertEqual(page["experiment_result"]["validity"], "valid")
                self.assertEqual(page["experiment_result"]["provisional_result"], "inconclusive")
                self.assertEqual(page["experiment_result"]["result"], "inconclusive")
                self.assertIsNone(page["experiment_result"]["final_result"])
                self.assertEqual(page["experiment_result"]["adjudication_status"], "pending_review")
                self.assertFalse(page["experiment_result"]["promotion_eligible"])
                self.assertTrue(page["experiment_result"]["runner_metrics_artifact"]["present"])
                self.assertFalse(page["experiment_result"]["runner_metrics_artifact"]["trusted"])
                self.assertIn(
                    "experiment_spec_digest does not match ExperimentSpec",
                    page["experiment_result"]["runner_metrics_artifact"]["rejection_reason"],
                )
                self.assertIn("runner_metrics_rejected", page["experiment_result"]["limitations"])
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "review_required")
                self.assertNotEqual(page["experiment_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "review_required")
                self.assertNotEqual(page["hypothesis_promotion"]["project_sync"]["status"], "applied")
                self.assertIn(
                    "runner_metrics_rejected",
                    page["evaluation_report"]["validity"]["limitations"],
                )
                self.assertEqual(page["operator_summary"]["overall_status"], "review_required")

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["experiment_result"]["assessment_basis"], "structural_only")
                self.assertEqual(intake["experiment_result"]["runner_metrics_artifact"]["trusted"], False)
                self.assertEqual(intake["experiment_promotion"]["promotion_state"], "review_required")
                self.assertEqual(intake["hypothesis_promotion"]["promotion_state"], "review_required")
                self.assertGreaterEqual(intake["event_count"], 11)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_http_e2e_bounded_cpu_eval_rejects_runner_metric_name_mismatch(self):
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
                self.assertTrue(prepared["ready_to_run"])
                intake_id = prepared["intake_id"]
                experiment_spec = prepared["experiment_spec"]
                task_id = "task_20260619_120300_e2ename"

                self.write_codex_bridge_script(
                    codex_root,
                    task_id=task_id,
                    result_text="The bounded CPU probe completed, but the runner metrics artifact declared the wrong metric name.",
                    runner_metrics={
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task_id,
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-19T12:03:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "name": "wrong_metric_name",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                            }
                        ],
                    },
                )

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
                self.assertEqual(queued["task_id"], task_id)

                page = self.request_json(
                    base_url,
                    f"/codex/result-page?task_id={task_id}&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "structural_only")
                self.assertFalse(page["experiment_result"]["runner_metrics_artifact"]["trusted"])
                self.assertIn(
                    "name does not match ExperimentSpec",
                    page["experiment_result"]["runner_metrics_artifact"]["rejection_reason"],
                )
                self.assertIn("runner_metrics_rejected", page["experiment_result"]["limitations"])
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "review_required")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "review_required")
                self.assertIn(
                    "runner_metrics_rejected",
                    page["operator_summary"]["next_safe_action"]["reason"],
                )

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertFalse(intake["experiment_result"]["runner_metrics_artifact"]["trusted"])
                self.assertIn(
                    "name does not match ExperimentSpec",
                    intake["experiment_result"]["runner_metrics_artifact"]["rejection_reason"],
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_http_e2e_bounded_cpu_eval_blocks_partial_runner_metrics_from_promotion(self):
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
                    "query": "bounded cpu partial metric probe status",
                    "decision": "safe_to_answer",
                    "warnings": [],
                    "read_plan": [{"path": "formal/partial_metric_probe.md", "reason": "primary source"}],
                    "hits": [{"kind": "current_conclusion", "id": "partial_metric_probe_status", "score": 6.0}],
                },
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
                self.assertTrue(prepared["ready_to_run"])
                intake_id = prepared["intake_id"]
                experiment_spec = dict(prepared["experiment_spec"])
                hypothesis_ids = list(experiment_spec.get("hypothesis_ids") or [])

                experiment_spec.update(
                    {
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
                                "unit": "fraction",
                            },
                            {
                                "metric_id": "M-03",
                                "name": "precision_gain",
                                "kind": "delta",
                                "source": "runner_metrics",
                                "higher_is_better": True,
                                "unit": "fraction",
                            },
                        ],
                        "success_criteria": [
                            {
                                "criterion_id": "SC-D1",
                                "name": "accuracy_gain_positive",
                                "kind": "metric",
                                "metric_name": "accuracy_gain",
                                "target": {"operator": ">", "value": 0.0},
                            },
                            {
                                "criterion_id": "SC-D2",
                                "name": "precision_gain_positive",
                                "kind": "metric",
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
                        "hypothesis_ids": hypothesis_ids,
                    }
                )

                intake_root = codex_root / ".codex-bridge" / "intake" / intake_id
                (intake_root / "EXPERIMENT_SPEC.json").write_text(
                    json.dumps(experiment_spec, ensure_ascii=False, indent=2) + "\n"
                )

                task_id = "task_20260620_101500_e2epartial"
                self.write_codex_bridge_script(
                    codex_root,
                    task_id=task_id,
                    result_text="The bounded CPU probe completed, but only one of the required metric observations was exported.",
                    runner_metrics={
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task_id,
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-20T10:15:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "name": "accuracy_gain",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                                "artifact_refs": ["artifacts/accuracy_probe.json"],
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                )

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
                self.assertEqual(queued["task_id"], task_id)

                page = self.request_json(
                    base_url,
                    f"/codex/result-page?task_id={task_id}&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "runner_metrics")
                self.assertEqual(page["experiment_result"]["validity"], "valid")
                self.assertEqual(page["experiment_result"]["provisional_result"], "inconclusive")
                self.assertEqual(page["experiment_result"]["result"], "inconclusive")
                self.assertIsNone(page["experiment_result"]["final_result"])
                self.assertEqual(page["experiment_result"]["adjudication_status"], "pending_review")
                self.assertFalse(page["experiment_result"]["promotion_eligible"])
                self.assertEqual(page["experiment_result"]["success_criteria"][0]["status"], "pass")
                self.assertEqual(page["experiment_result"]["success_criteria"][1]["status"], "not_observed")
                self.assertIn("success_criteria_unresolved", page["experiment_result"]["limitations"])
                self.assertEqual(page["hypothesis_update"]["status"], "testing")
                self.assertEqual(page["hypothesis_update"]["status_reason"], "experiment_not_promotion_eligible")
                self.assertIn("success_criteria_unresolved", page["hypothesis_update"]["status_blockers"])
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "review_required")
                self.assertNotEqual(page["experiment_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "review_required")
                self.assertNotEqual(page["hypothesis_promotion"]["project_sync"]["status"], "applied")
                self.assertIn("success_criteria_not_resolved", page["evaluation_report"]["validity"]["limitations"])
                self.assertEqual(page["operator_summary"]["overall_status"], "review_required")

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["experiment_result"]["assessment_basis"], "runner_metrics")
                self.assertFalse(intake["experiment_result"]["promotion_eligible"])
                self.assertEqual(intake["hypothesis_update"]["status"], "testing")
                self.assertEqual(intake["experiment_promotion"]["promotion_state"], "review_required")
                self.assertEqual(intake["hypothesis_promotion"]["promotion_state"], "review_required")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_http_e2e_bounded_cpu_eval_promotes_supported_hypothesis_with_complete_runner_metrics(self):
        bridge.STREAM_TOKENS.clear()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_root = root / "workspace"
            workspace_root.mkdir(parents=True)
            (workspace_root / "project_index").mkdir(parents=True)
            (workspace_root / "research").mkdir(parents=True)
            codex_root = root / "codex-bridge"
            self.write_watchdog_doc_search(
                workspace_root,
                {
                    "query": "bounded cpu supported metric probe status",
                    "decision": "safe_to_answer",
                    "warnings": [],
                    "read_plan": [{"path": "formal/supported_metric_probe.md", "reason": "primary source"}],
                    "hits": [{"kind": "current_conclusion", "id": "supported_metric_probe_status", "score": 6.0}],
                },
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
                self.assertTrue(prepared["ready_to_run"])
                intake_id = prepared["intake_id"]
                experiment_spec = dict(prepared["experiment_spec"])
                hypothesis_ids = list(experiment_spec.get("hypothesis_ids") or [])
                hypothesis_id = hypothesis_ids[0]

                experiment_spec.update(
                    {
                        "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                        "dataset_refs": ["eval://demo/validation"],
                        "random_seeds": [42],
                        "code_reference": {
                            "commit": "deadbeef",
                            "paths": ["train.py"],
                            "status": "resolved",
                        },
                        "config_reference": {
                            "path": "configs/demo_supported_probe.yaml",
                            "hash": "cfg-003",
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
                                "unit": "fraction",
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
                                "target": {"operator": ">", "value": 0.05},
                            }
                        ],
                        "hypothesis_ids": hypothesis_ids,
                    }
                )

                intake_root = codex_root / ".codex-bridge" / "intake" / intake_id
                (intake_root / "EXPERIMENT_SPEC.json").write_text(
                    json.dumps(experiment_spec, ensure_ascii=False, indent=2) + "\n"
                )
                (workspace_root / "research" / "HYPOTHESIS_REGISTRY.jsonl").write_text(
                    json.dumps(
                        {
                            "schema_version": "hypothesis_record.v0.1",
                            "hypothesis_id": hypothesis_id,
                            "revision": 1,
                            "status": "testing",
                            "claim": "Accuracy can be improved with the variant.",
                            "confidence": {"value": 0.35},
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

                task_id = "task_20260620_103000_e2esupported"
                self.write_codex_bridge_script(
                    codex_root,
                    task_id=task_id,
                    result_text="The bounded CPU probe completed and all required support metrics improved over baseline.",
                    runner_metrics={
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task_id,
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-20T10:30:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "name": "accuracy_gain",
                                "value": 0.031,
                                "unit": "fraction",
                                "sample_count": 3,
                                "artifact_refs": ["artifacts/accuracy_probe.json"],
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                )

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
                self.assertEqual(queued["task_id"], task_id)

                page = self.request_json(
                    base_url,
                    f"/codex/result-page?task_id={task_id}&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "runner_metrics")
                self.assertEqual(page["experiment_result"]["validity"], "valid")
                self.assertEqual(page["experiment_result"]["provisional_result"], "supported")
                self.assertEqual(page["experiment_result"]["result"], "supported")
                self.assertEqual(page["experiment_result"]["final_result"], "supported")
                self.assertEqual(page["experiment_result"]["adjudication_status"], "accepted")
                self.assertTrue(page["experiment_result"]["promotion_eligible"])
                self.assertEqual(page["hypothesis_update"]["status"], "supported")
                self.assertEqual(page["hypothesis_update"]["status_reason"], "experiment_final_result")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["hypothesis_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["experiment_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["evaluation_report"]["experiment_assessment"]["result"], "supported")
                self.assertEqual(page["operator_summary"]["overall_status"], "promotion_ready")

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["experiment_result"]["final_result"], "supported")
                self.assertEqual(intake["hypothesis_update"]["status"], "supported")
                self.assertEqual(intake["hypothesis_promotion"]["project_sync"]["status"], "applied")

                hypothesis_records = [
                    json.loads(line)
                    for line in (workspace_root / "research" / "HYPOTHESIS_REGISTRY.jsonl").read_text().strip().splitlines()
                    if line.strip()
                ]
                self.assertEqual(len(hypothesis_records), 1)
                self.assertEqual(hypothesis_records[0]["status"], "supported")
                self.assertEqual(hypothesis_records[0]["revision"], 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_http_e2e_bounded_cpu_eval_promotes_refuted_hypothesis_with_complete_runner_metrics(self):
        bridge.STREAM_TOKENS.clear()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_root = root / "workspace"
            workspace_root.mkdir(parents=True)
            (workspace_root / "project_index").mkdir(parents=True)
            (workspace_root / "research").mkdir(parents=True)
            codex_root = root / "codex-bridge"
            self.write_watchdog_doc_search(
                workspace_root,
                {
                    "query": "bounded cpu refuted metric probe status",
                    "decision": "safe_to_answer",
                    "warnings": [],
                    "read_plan": [{"path": "formal/refuted_metric_probe.md", "reason": "primary source"}],
                    "hits": [{"kind": "current_conclusion", "id": "refuted_metric_probe_status", "score": 6.0}],
                },
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
                self.assertTrue(prepared["ready_to_run"])
                intake_id = prepared["intake_id"]
                experiment_spec = dict(prepared["experiment_spec"])
                hypothesis_ids = list(experiment_spec.get("hypothesis_ids") or [])
                hypothesis_id = hypothesis_ids[0]

                experiment_spec.update(
                    {
                        "baseline_spec": {"required": True, "entities": ["baseline_v1"]},
                        "dataset_refs": ["eval://demo/validation"],
                        "random_seeds": [7],
                        "code_reference": {
                            "commit": "deadbeef",
                            "paths": ["train.py"],
                            "status": "resolved",
                        },
                        "config_reference": {
                            "path": "configs/demo_refuted_probe.yaml",
                            "hash": "cfg-004",
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
                                "name": "latency_delta",
                                "kind": "delta",
                                "source": "runner_metrics",
                                "higher_is_better": False,
                                "unit": "fraction",
                            },
                        ],
                        "success_criteria": [
                            {
                                "criterion_id": "FC-D1",
                                "name": "latency_regression_detected",
                                "kind": "falsification",
                                "metric_name": "latency_delta",
                                "target": {"operator": ">", "value": 0.0},
                            }
                        ],
                        "failure_criteria": [],
                        "hypothesis_ids": hypothesis_ids,
                    }
                )

                intake_root = codex_root / ".codex-bridge" / "intake" / intake_id
                (intake_root / "EXPERIMENT_SPEC.json").write_text(
                    json.dumps(experiment_spec, ensure_ascii=False, indent=2) + "\n"
                )
                (workspace_root / "research" / "HYPOTHESIS_REGISTRY.jsonl").write_text(
                    json.dumps(
                        {
                            "schema_version": "hypothesis_record.v0.1",
                            "hypothesis_id": hypothesis_id,
                            "revision": 1,
                            "status": "testing",
                            "claim": "Latency should not regress with the variant.",
                            "confidence": {"value": 0.35},
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

                task_id = "task_20260620_103500_e2erefuted"
                self.write_codex_bridge_script(
                    codex_root,
                    task_id=task_id,
                    result_text="The bounded CPU probe completed and explicit falsification criteria were satisfied.",
                    runner_metrics={
                        "schema_version": "runner_metrics.v0.2",
                        "task_id": task_id,
                        "intake_id": intake_id,
                        "experiment_id": experiment_spec["experiment_id"],
                        "experiment_spec_digest": experiment_contracts.experiment_spec_digest(experiment_spec),
                        "producer": {
                            "kind": "experiment_runner",
                            "id": "local-runner",
                            "version": "0.2",
                        },
                        "generated_at": "2026-06-20T10:35:00Z",
                        "metrics": [
                            {
                                "metric_id": "M-02",
                                "name": "latency_delta",
                                "value": 0.042,
                                "unit": "fraction",
                                "sample_count": 3,
                                "artifact_refs": ["artifacts/latency_probe.json"],
                                "baseline_value": 0.0,
                            }
                        ],
                    },
                )

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
                self.assertEqual(queued["task_id"], task_id)

                page = self.request_json(
                    base_url,
                    f"/codex/result-page?task_id={task_id}&page=1&page_size=80",
                )
                self.assertTrue(page["ok"])
                self.assertEqual(page["experiment_result"]["assessment_basis"], "runner_metrics")
                self.assertEqual(page["experiment_result"]["validity"], "valid")
                self.assertEqual(page["experiment_result"]["provisional_result"], "refuted")
                self.assertEqual(page["experiment_result"]["result"], "refuted")
                self.assertEqual(page["experiment_result"]["final_result"], "refuted")
                self.assertEqual(page["experiment_result"]["adjudication_status"], "accepted")
                self.assertTrue(page["experiment_result"]["promotion_eligible"])
                self.assertEqual(page["hypothesis_update"]["status"], "refuted")
                self.assertEqual(page["hypothesis_update"]["status_reason"], "experiment_final_result")
                self.assertEqual(page["hypothesis_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["hypothesis_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["experiment_promotion"]["promotion_state"], "candidate_ready")
                self.assertEqual(page["experiment_promotion"]["project_sync"]["status"], "applied")
                self.assertEqual(page["evaluation_report"]["experiment_assessment"]["result"], "refuted")
                self.assertEqual(page["operator_summary"]["overall_status"], "promotion_ready")

                intake = self.request_json(base_url, f"/codex/intake?intake_id={intake_id}")
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["experiment_result"]["final_result"], "refuted")
                self.assertEqual(intake["hypothesis_update"]["status"], "refuted")
                self.assertEqual(intake["hypothesis_promotion"]["project_sync"]["status"], "applied")

                hypothesis_records = [
                    json.loads(line)
                    for line in (workspace_root / "research" / "HYPOTHESIS_REGISTRY.jsonl").read_text().strip().splitlines()
                    if line.strip()
                ]
                self.assertEqual(len(hypothesis_records), 1)
                self.assertEqual(hypothesis_records[0]["status"], "refuted")
                self.assertEqual(hypothesis_records[0]["revision"], 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()


if __name__ == "__main__":
    unittest.main()
