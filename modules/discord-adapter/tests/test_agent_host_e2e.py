import json
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
AGENT_HOST_ROOT = ROOT.parent / "agent-host"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(AGENT_HOST_ROOT))

from agent_host_client import AgentHostClient
import bot
import bridge


class AgentHostHttpE2ETests(unittest.TestCase):
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

    def write_watchdog_doc_search(self, workspace_root: Path) -> None:
        script = workspace_root / "agent" / "bin" / "watchdog_doc_search.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            "print(json.dumps({"
            "\"query\": \"What is the current best candidate?\", "
            "\"decision\": \"stale_conclusion\", "
            "\"warnings\": [\"matching current conclusion is stale and should be rechecked before citation\"], "
            "\"read_plan\": [{\"path\": \"formal/current_best.md\", \"reason\": \"supports current conclusion: current best candidate\"}], "
            "\"hits\": [{\"kind\": \"current_conclusion\", \"id\": \"current_best_candidate\", \"score\": 6.0}]"
            "}))\n"
        )
        script.chmod(0o755)

    def write_codex_bridge_script(self, codex_root: Path) -> None:
        script = codex_root / "scripts" / "codex-bridge.js"
        script.parent.mkdir(parents=True, exist_ok=True)
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
            "const taskId = 'task_20260618_120000_discorde2e01';\n"
            "if (args[0] === 'run') {\n"
            "  const taskDir = path.join(root, '.codex-bridge', 'tasks', taskId);\n"
            "  fs.mkdirSync(taskDir, { recursive: true });\n"
            "  const task = {\n"
            "    version: 1,\n"
            "    task_id: taskId,\n"
            "    status: 'done',\n"
            "    user: readFlag('--user', 'chenma'),\n"
            "    project: readFlag('--project', 'demo'),\n"
            "    source: readFlag('--source', 'discord'),\n"
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
            "  fs.writeFileSync(path.join(taskDir, 'result.md'), 'safe result summary for discord adapter e2e validation');\n"
            "  fs.writeFileSync(path.join(taskDir, 'bridge.log'), 'discord e2e log line\\n');\n"
            "  console.log(`queued ${taskId}`);\n"
            "  process.exit(0);\n"
            "}\n"
            "if (args[0] === 'result') {\n"
            "  console.log(JSON.stringify({\n"
            "    task_id: taskId,\n"
            "    text: 'safe result summary for discord adapter e2e validation',\n"
            "    raw: false,\n"
            "    redacted: true,\n"
            "    truncated: false\n"
            "  }));\n"
            "  process.exit(0);\n"
            "}\n"
            "if (args[0] === 'logs') {\n"
            "  console.log(JSON.stringify({\n"
            "    task_id: taskId,\n"
            "    text: 'discord e2e log line\\n',\n"
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

    def write_codex_task(
        self,
        codex_root: Path,
        workspace_root: Path,
        task_id: str,
        *,
        status: str = "done",
        prompt: str = "health summary test",
        created_at: str = "2026-06-18T12:00:00.000Z",
        updated_at: str = "2026-06-18T12:01:00.000Z",
        exit_code: int | None = 0,
    ) -> None:
        task_dir = codex_root / ".codex-bridge" / "tasks" / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        task = {
            "version": 1,
            "task_id": task_id,
            "status": status,
            "user": "chenma",
            "project": "demo",
            "source": "discord",
            "project_path": str(workspace_root / "secret-real-project-path"),
            "mode": "readonly",
            "prompt": prompt,
            "created_at": created_at,
            "updated_at": updated_at,
            "started_at": created_at,
            "ended_at": updated_at,
            "exit_code": exit_code,
        }
        (task_dir / "task.json").write_text(json.dumps(task, ensure_ascii=False, indent=2))
        (task_dir / "result.md").write_text("safe result")
        (task_dir / "bridge.log").write_text("log line\n")

    def write_supervisor_runtime(self, workspace_root: Path) -> None:
        agent_dir = workspace_root / "agent"
        agent_dir.mkdir(parents=True, exist_ok=True)
        (agent_dir / "RUN_STATE.json").write_text(
            json.dumps(
                {
                    "role": "runner",
                    "supervisor_mode": "light",
                    "runner_started_count": 5,
                    "runner_completed_count": 3,
                    "runner_failure_drift": 2,
                    "status": "blocked",
                    "blocker_type": "env",
                    "requires_human_review": True,
                    "updated_utc": "2026-06-18T12:00:00Z",
                    "next_action": {
                        "kind": "repair",
                        "description": f"Inspect {workspace_root}/private and Authorization: Bearer secret-token-12345",
                        "can_execute_automatically": False,
                        "reason": "Needs reviewer approval",
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        (agent_dir / "NEXT_ACTION.md").write_text("Fallback next action")
        (agent_dir / "BLOCKERS.md").write_text(
            f"Blockers mention {workspace_root}/private and ghp_abcdefghijklmnopqrstuvwxyz123456"
        )

    def wait_for_server(self, client: AgentHostClient) -> None:
        deadline = time.monotonic() + 5
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                data = client.health()
                if data.get("ok") is True:
                    return
            except Exception as exc:  # pragma: no cover - retries until ready
                last_error = exc
                time.sleep(0.05)
        if last_error:
            raise last_error
        raise AssertionError("server did not become ready")

    def test_discord_adapter_client_round_trips_against_real_agent_host(self):
        bridge.STREAM_TOKENS.clear()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_root = root / "workspace"
            workspace_root.mkdir(parents=True)
            (workspace_root / "project_index").mkdir(parents=True)
            codex_root = root / "codex-bridge"
            self.write_watchdog_doc_search(workspace_root)
            self.write_codex_bridge_script(codex_root)
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
                client = AgentHostClient(f"http://{config.host}:{server.server_port}", "bearer-1", timeout_seconds=5)
                self.wait_for_server(client)

                prepared = client.prepare(
                    workspace="demo",
                    prompt="What is the current best candidate?",
                    source_user_id="discord-user",
                    source_channel_id="discord-channel",
                    source_message_id="interaction-prepare-1",
                    guild_id="guild-1",
                )
                self.assertTrue(prepared["ok"])
                self.assertEqual(prepared["status"], "prepared")
                self.assertTrue(prepared["ready_to_run"])
                self.assertEqual(prepared["evidence_retrieval"]["decision"], "stale_conclusion")
                intake_id = str(prepared["intake_id"])

                queued = client.run(
                    workspace="demo",
                    prompt="",
                    source_user_id="discord-user",
                    source_channel_id="discord-channel",
                    source_message_id="interaction-run-1",
                    idempotency_key="discord:interaction-run-1",
                    guild_id="guild-1",
                    intake_id=intake_id,
                )
                self.assertTrue(queued["ok"])
                self.assertEqual(queued["task_id"], "task_20260618_120000_discorde2e01")
                self.assertEqual(queued["intake_id"], intake_id)
                self.assertEqual(queued["prepare_context"]["objective"], "report_only")

                status = client.status("task_20260618_120000_discorde2e01")
                self.assertTrue(status["ok"])
                self.assertIn("status: done", status["text"])

                page = client.result_page("task_20260618_120000_discorde2e01", page=1, page_size=120)
                self.assertTrue(page["ok"])
                self.assertEqual(page["task_id"], "task_20260618_120000_discorde2e01")
                self.assertEqual(page["intake_id"], intake_id)
                self.assertEqual(page["text"], "safe result summary for discord adapter e2e validation")
                self.assertEqual(page["execution_evaluation"]["execution_decision"], "result_ready_for_review")
                self.assertEqual(page["followup_task_draft"]["recommended_next_action"], "review_result")
                self.assertEqual(page["review_proposal_draft"]["review_scope"], "report_only")

                intake = client.intake(intake_id)
                self.assertTrue(intake["ok"])
                self.assertEqual(intake["intake_id"], intake_id)
                self.assertEqual(intake["execution_evaluation"]["execution_decision"], "result_ready_for_review")
                self.assertEqual(intake["followup_task_draft"]["source_task_id"], "task_20260618_120000_discorde2e01")
                self.assertEqual(intake["ledger_note_draft"]["target_path_hint"], "research/LEDGER_NOTES.md")
                self.assertEqual(intake["review_proposal_draft"]["review_scope"], "report_only")
                self.assertGreaterEqual(intake["event_count"], 5)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()

    def test_discord_adapter_health_summary_round_trips_watchdog_runtime_state(self):
        bridge.STREAM_TOKENS.clear()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_root = root / "workspace"
            workspace_root.mkdir(parents=True)
            codex_root = root / "codex-bridge"
            self.write_supervisor_runtime(workspace_root)
            self.write_codex_task(
                codex_root,
                workspace_root,
                "task_20260618_120000_healthdone01",
                status="done",
                updated_at="2026-06-18T12:01:00.000Z",
            )
            self.write_codex_task(
                codex_root,
                workspace_root,
                "task_20260618_120500_healthrun01",
                status="running",
                updated_at="2026-06-18T12:05:00.000Z",
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
                client = AgentHostClient(f"http://{config.host}:{server.server_port}", "bearer-1", timeout_seconds=5)
                self.wait_for_server(client)

                summary = client.health_summary()
                self.assertTrue(summary["ok"])
                self.assertEqual(summary["tasks"]["recent_count"], 2)
                self.assertEqual(summary["tasks"]["active_count"], 1)
                self.assertEqual(summary["tasks"]["terminal_count"], 1)
                self.assertEqual(summary["supervisor"]["blocked_count"], 1)
                self.assertEqual(summary["supervisor"]["review_required_count"], 1)
                self.assertEqual(summary["supervisor"]["runner_drift_count"], 1)
                signal = summary["supervisor"]["signals"][0]
                self.assertEqual(signal["workspace"], "demo")
                self.assertEqual(signal["role"], "runner")
                self.assertEqual(signal["blocker_type"], "env")
                self.assertIn("[workspace:demo]", signal["next_action"]["description"])

                raw_text = json.dumps(summary, ensure_ascii=False)
                self.assertNotIn(str(workspace_root), raw_text)
                self.assertNotIn("secret-token-12345", raw_text)
                self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz123456", raw_text)

                rendered = bot.format_health_summary(summary, command_prefix="agent")
                self.assertIn("Agent Host 健康摘要", rendered)
                self.assertIn("Supervisor signals", rendered)
                self.assertIn("blocked", rendered)
                self.assertIn("mode=light", rendered)
                self.assertIn("drift=2", rendered)
                self.assertIn("blocker=env", rendered)
                self.assertIn("/agent_task_page", rendered)
                self.assertNotIn(str(workspace_root), rendered)
                self.assertNotIn("secret-token-12345", rendered)
                self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz123456", rendered)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        bridge.STREAM_TOKENS.clear()


if __name__ == "__main__":
    unittest.main()
