import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import bridge


class BridgeTests(unittest.TestCase):
    def make_config(self, root: Path) -> bridge.BridgeConfig:
        return bridge.BridgeConfig(
            host="127.0.0.1",
            port=8787,
            mattermost_tokens=("token-1",),
            allowed_users=("chenma",),
            projects={"demo": bridge.Project(name="demo", root=root)},
            codex_bridge_root=root,
            codex_bridge_node_bin="node",
            auth_tokens={
                "bearer-1": bridge.AuthPrincipal(user="chenma", role="admin"),
            },
        )

    def make_write_config(self, root: Path) -> bridge.BridgeConfig:
        return bridge.BridgeConfig(
            host="127.0.0.1",
            port=8787,
            mattermost_tokens=("token-1",),
            allowed_users=("chenma",),
            projects={
                "codex": bridge.Project(
                    name="codex",
                    root=root,
                    default_mode="workspace-write",
                    allowed_modes=("workspace-write",),
                )
            },
            codex_bridge_root=root,
            codex_bridge_node_bin="node",
            auth_tokens={
                "bearer-1": bridge.AuthPrincipal(user="chenma", role="admin"),
            },
        )

    def payload(self, text: str) -> dict[str, str]:
        return {
            "token": "token-1",
            "user_name": "chenma",
            "user_id": "u1",
            "channel_id": "c1",
            "channel_name": "codex-control",
            "team_id": "t1",
            "command": "/watchdog",
            "text": text,
        }

    def write_codex_task(
        self,
        root: Path,
        task_id: str,
        *,
        user: str = "chenma",
        project: str = "demo",
        status: str = "done",
        prompt: str = "hello",
        created_at: str = "2026-05-23T12:00:00.000Z",
        updated_at: str = "2026-05-23T12:01:00.000Z",
        exit_code: int | None = 0,
        source: str = "web",
        mode: str = "readonly",
        extra: dict | None = None,
    ) -> Path:
        task_dir = root / ".codex-bridge" / "tasks" / task_id
        task_dir.mkdir(parents=True)
        task = {
            "version": 1,
            "task_id": task_id,
            "status": status,
            "user": user,
            "project": project,
            "source": source,
            "project_path": str(root / "secret-real-project-path"),
            "mode": mode,
            "prompt": prompt,
            "created_at": created_at,
            "updated_at": updated_at,
            "started_at": created_at,
            "ended_at": updated_at,
            "exit_code": exit_code,
        }
        if extra:
            task.update(extra)
        (task_dir / "task.json").write_text(json.dumps(task, ensure_ascii=False, indent=2))
        (task_dir / "result.md").write_text("result")
        (task_dir / "bridge.log").write_text("log")
        return task_dir

    def write_watchdog_doc_search(self, root: Path, payload: dict) -> Path:
        script = root / "agent" / "bin" / "watchdog_doc_search.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            f"print(json.dumps({json.dumps(payload, ensure_ascii=False)}))\n"
        )
        script.chmod(0o755)
        return script

    def test_task_writes_inbox_json_without_executing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "agent").mkdir()
            config = self.make_config(root)
            response = bridge.handle_watchdog(
                self.payload("task demo 继续分析 A0 曲线"),
                config,
            )

            self.assertIn("Queued", response["text"])
            files = list((root / "agent" / "inbox").glob("*_mattermost_task.json"))
            self.assertEqual(len(files), 1)
            task = json.loads(files[0].read_text())
            self.assertEqual(task["project"], "demo")
            self.assertEqual(task["request"], "继续分析 A0 曲线")
            self.assertFalse(task["safety"]["bridge_executed_shell"])
            self.assertTrue(task["safety"]["requires_watchdog_decision"])

    def test_rejects_bad_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            payload = self.payload("status demo")
            payload["token"] = "wrong"
            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_watchdog(payload, config)
            self.assertEqual(ctx.exception.status, 403)

    def test_status_reads_project_without_creating_inbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "agent" / "reports").mkdir(parents=True)
            (root / "agent" / "reports" / "latest.md").write_text("# Report\n")
            config = self.make_config(root)
            response = bridge.handle_watchdog(self.payload("status demo"), config)
            self.assertIn("Project `demo`", response["text"])
            self.assertFalse((root / "agent" / "inbox").exists())

    def test_write_task_uses_stable_timestamp_when_provided(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = bridge.Project(name="demo", root=root)
            now = dt.datetime(2026, 5, 18, 12, 0, tzinfo=dt.timezone.utc)
            task_id, out = bridge.write_task(project, self.payload(""), "hello", "task_request", now=now)
            self.assertTrue(task_id.startswith("20260518T120000Z_"))
            self.assertTrue(out.exists())

    def test_codex_run_returns_task_id_from_bridge_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text("console.log('queued task_20260522_120000_abcd12')\n")
            config = self.make_config(root)
            response = bridge.handle_codex_run(
                {
                    "project": "demo",
                    "prompt": "hello",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )
            self.assertTrue(response["ok"])
            self.assertEqual(response["task_id"], "task_20260522_120000_abcd12")
            generated = root / ".codex-bridge" / "web-adapter.config.json"
            self.assertTrue(generated.exists())
            data = json.loads(generated.read_text())
            self.assertIn("demo", data["projects"])
            self.assertEqual(data["projects"]["demo"]["mode"], "readonly")
            self.assertEqual(data["projects"]["demo"]["allowedModes"], ["readonly"])

    def test_codex_run_uses_workspace_default_write_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            argv_file = root / "argv.json"
            script.parent.mkdir()
            script.write_text(
                "const fs = require('fs');\n"
                f"fs.writeFileSync({str(argv_file)!r}, JSON.stringify(process.argv.slice(2)));\n"
                "console.log('queued task_20260524_120000_write1')\n"
            )
            config = self.make_write_config(root)
            response = bridge.handle_codex_run(
                {
                    "project": "codex",
                    "prompt": "please update work",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            argv = json.loads(argv_file.read_text())
            self.assertTrue(response["ok"])
            self.assertEqual(response["mode"], "workspace-write")
            self.assertIn("--mode", argv)
            self.assertIn("workspace-write", argv)

    def test_codex_run_rejects_frontend_user_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_run(
                    {
                        "user": "chenma",
                        "project": "demo",
                        "prompt": "hello",
                    },
                    config,
                    bridge.AuthPrincipal(user="chenma", role="admin"),
                )
            self.assertEqual(ctx.exception.status, 400)

    def test_codex_prepare_generates_intake_artifacts_for_report_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            response = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "Please summarize the current project status and blockers.",
                    "source": "web",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertTrue(response["ok"])
            self.assertEqual(response["status"], "prepared")
            self.assertTrue(response["ready_to_run"])
            self.assertEqual(response["contract"]["objective"], "report_only")
            self.assertFalse(response["decision_gate"]["required"])
            self.assertEqual(response["taskbox"]["status"], "ready")
            self.assertEqual(response["taskbox"]["experiment_gate_status"], "not_required")
            intake_dir = Path(response["artifacts_dir"])
            self.assertTrue((intake_dir / "INTENT_DRAFT.json").exists())
            self.assertTrue((intake_dir / "TASK_CONTRACT.json").exists())
            self.assertTrue((intake_dir / "TASKBOX_DRAFT.json").exists())
            self.assertTrue((intake_dir / "POLICY_PREFLIGHT.json").exists())
            self.assertTrue((intake_dir / "DECISION_GATE.json").exists())

    def test_codex_prepare_requests_clarification_for_write_without_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            response = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "Please fix this for me.",
                    "source": "discord",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual(response["status"], "need_user_reply")
            self.assertFalse(response["ready_to_run"])
            self.assertIn("write_scope_missing", response["gray_areas"])
            self.assertGreaterEqual(len(response["questions"]), 1)
            preflight = json.loads((Path(response["artifacts_dir"]) / "POLICY_PREFLIGHT.json").read_text())
            self.assertFalse(preflight["ok"])
            self.assertIn("clarification_required", preflight["blocked_by"])

    def test_codex_prepare_followup_can_reuse_existing_prompt_by_intake_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            first = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "Please fix this for me.",
                    "source": "discord",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            second = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "intake_id": first["intake_id"],
                    "answers": "Only modify README.md and docs/setup/README.md using a local workspace copy.",
                    "source": "discord",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual(second["status"], "prepared")
            self.assertEqual(second["contract"]["objective"], "local_workspace_copy")
            self.assertEqual(second["contract"]["prompt"], "Please fix this for me.")
            self.assertTrue((Path(second["artifacts_dir"]) / "ANSWERS.jsonl").exists())

    def test_codex_prepare_blocks_high_risk_training_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            response = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "Launch GPU training and promote the checkpoint if metrics improve.",
                    "source": "discord",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual(response["status"], "blocked")
            self.assertFalse(response["ready_to_run"])
            self.assertEqual(response["contract"]["risk_class"], "high")
            self.assertIn("human_review_required", response["preflight"]["blocked_by"])
            self.assertTrue(response["decision_gate"]["required"])
            self.assertTrue(response["decision_gate"]["blocking"])
            self.assertIn("experiment_decision_gate_required", response["preflight"]["blocked_by"])
            intake_dir = Path(response["artifacts_dir"])
            gate = json.loads((intake_dir / "DECISION_GATE.json").read_text())
            self.assertTrue(gate["required"])
            self.assertGreaterEqual(len(gate["unresolved_items"]), 1)

    def test_codex_prepare_includes_evidence_retrieval_when_project_index_is_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "project_index").mkdir(parents=True)
            self.write_watchdog_doc_search(
                root,
                {
                    "query": "What is the current best candidate?",
                    "decision": "safe_to_answer",
                    "warnings": [],
                    "read_plan": [
                        {"path": "formal/current_best.md", "reason": "active primary conclusion"}
                    ],
                    "hits": [
                        {"kind": "current_conclusion", "id": "current_best_candidate", "score": 6.0}
                    ],
                },
            )
            config = self.make_config(root)
            response = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "What is the current best candidate?",
                    "source": "web",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertTrue(response["evidence_retrieval"]["required"])
            self.assertTrue(response["evidence_retrieval"]["available"])
            self.assertTrue(response["evidence_retrieval"]["consulted"])
            self.assertEqual(response["evidence_retrieval"]["decision"], "safe_to_answer")
            self.assertEqual(response["contract"]["evidence_retrieval"]["decision"], "safe_to_answer")
            self.assertEqual(response["taskbox"]["evidence_retrieval"]["decision"], "safe_to_answer")
            self.assertEqual(response["preflight"]["evidence_retrieval_decision"], "safe_to_answer")
            intake_dir = Path(response["artifacts_dir"])
            self.assertTrue((intake_dir / "EVIDENCE_RETRIEVAL.json").exists())
            self.assertTrue((intake_dir / "READ_PLAN.md").exists())

    def test_codex_prepare_reports_missing_evidence_tool_when_index_is_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "project_index").mkdir(parents=True)
            config = self.make_config(root)
            response = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "Please compare the current best candidate against the baseline.",
                    "source": "web",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertTrue(response["evidence_retrieval"]["required"])
            self.assertTrue(response["evidence_retrieval"]["available"])
            self.assertFalse(response["evidence_retrieval"]["consulted"])
            self.assertIsNone(response["evidence_retrieval"]["decision"])
            self.assertIn("missing", response["evidence_retrieval"]["reason"])
            self.assertTrue(any("Evidence retrieval was expected" in reason for reason in response["preflight"]["reasons"]))

    def test_codex_prepare_requests_decision_gate_for_bounded_gpu_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            response = bridge.handle_codex_prepare(
                {
                    "workspace": "demo",
                    "prompt": "Run a bounded GPU probe eval to compare the new curriculum against the baseline.",
                    "source": "web",
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual(response["status"], "need_user_reply")
            self.assertFalse(response["ready_to_run"])
            self.assertEqual(response["contract"]["objective"], "bounded_gpu_probe")
            self.assertTrue(response["decision_gate"]["required"])
            self.assertEqual(response["taskbox"]["status"], "blocked")
            self.assertEqual(response["taskbox"]["experiment_gate_status"], "blocked")
            self.assertTrue(response["taskbox"]["experiment_decision_gate"]["blocking"])
            self.assertIn("fairness_constraint_missing", response["gray_areas"])
            self.assertIn("success_criterion_missing", response["gray_areas"])
            self.assertIn("experiment_decision_gate_required", response["preflight"]["blocked_by"])
            self.assertGreaterEqual(len(response["questions"]), 1)

    def test_codex_run_rejects_non_allowlisted_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_run(
                    {
                        "project": "unknown",
                        "prompt": "hello",
                    },
                    config,
                    bridge.AuthPrincipal(user="chenma", role="admin"),
                )
            self.assertEqual(ctx.exception.status, 403)

    def test_bearer_auth(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            with self.assertRaises(bridge.BridgeError) as missing:
                bridge.authenticate_bearer("", config)
            self.assertEqual(missing.exception.status, 401)

            with self.assertRaises(bridge.BridgeError) as wrong:
                bridge.authenticate_bearer("Bearer wrong", config)
            self.assertEqual(wrong.exception.status, 401)

            principal = bridge.authenticate_bearer("Bearer bearer-1", config)
            self.assertEqual(principal.user, "chenma")
            self.assertEqual(principal.role, "admin")

    def test_index_html_has_no_user_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            page = bridge.index_html(config)
            self.assertNotIn('id="user"', page)
            self.assertNotIn("user_name", page)
            self.assertIn("/whoami", page)

    def test_codex_query_requires_backend_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text("console.log('ok')\n")
            self.write_codex_task(root, "task_20260522_120000_abcd12")
            config = self.make_config(root)
            response = bridge.handle_codex_query(
                {
                    "task_id": "task_20260522_120000_abcd12",
                },
                config,
                "status",
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )
            self.assertTrue(response["ok"])

    def test_codex_status_redacts_project_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text(
                "console.log('task_id: task_20260522_120000_abcd12')\n"
                "console.log('status: running')\n"
                f"console.log('project_path: {str(root / 'secret-real-project-path')}')\n"
            )
            self.write_codex_task(root, "task_20260522_120000_abcd12")
            config = self.make_config(root)

            response = bridge.handle_codex_query(
                {
                    "task_id": "task_20260522_120000_abcd12",
                },
                config,
                "status",
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertTrue(response["ok"])
            self.assertIn("project_path: [workspace:demo]", response["text"])
            self.assertNotIn(str(root), response["text"])
            self.assertNotIn("/home/chenma", response["text"])

    def test_bearer_auth_rejects_non_allowlisted_user(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = bridge.BridgeConfig(
                host="127.0.0.1",
                port=8787,
                mattermost_tokens=("token-1",),
                allowed_users=("chenma",),
                projects={"demo": bridge.Project(name="demo", root=root)},
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                auth_tokens={
                    "bearer-2": bridge.AuthPrincipal(user="unknown", role="user"),
                },
            )
            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.authenticate_bearer("Bearer bearer-2", config)
            self.assertEqual(ctx.exception.status, 403)

    def test_codex_tasks_lists_recent_without_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            self.write_codex_task(
                root,
                "task_20260523_120000_aaaaaa",
                prompt="one " * 80,
                updated_at="2026-05-23T12:01:00.000Z",
            )
            self.write_codex_task(
                root,
                "task_20260523_130000_bbbbbb",
                status="failed",
                prompt="newer task",
                updated_at="2026-05-23T13:01:00.000Z",
                exit_code=1,
            )

            response = bridge.handle_codex_tasks(
                {"limit": "10"},
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual([item["task_id"] for item in response["tasks"]], [
                "task_20260523_130000_bbbbbb",
                "task_20260523_120000_aaaaaa",
            ])
            first = response["tasks"][0]
            self.assertEqual(first["owner"], "chenma")
            self.assertEqual(first["project"], "demo")
            self.assertEqual(first["status"], "failed")
            self.assertTrue(first["has_result"])
            self.assertTrue(first["has_logs"])
            self.assertEqual(first["mode"], "readonly")
            self.assertFalse(first["write_audit"])
            self.assertNotIn("project_path", first)
            self.assertNotIn(str(root), json.dumps(response, ensure_ascii=False))
            self.assertLessEqual(len(response["tasks"][1]["prompt_preview"]), bridge.PROMPT_PREVIEW_CHARS)

    def test_codex_tasks_exposes_write_summary_without_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            self.write_codex_task(
                root,
                "task_20260523_120000_write1",
                mode="workspace-write",
                extra={
                    "write_audit_path": str(root / ".codex-bridge" / "tasks" / "task_20260523_120000_write1" / "write_audit.json"),
                    "changed_files_count": 3,
                    "protected_path_violation": True,
                },
            )

            response = bridge.handle_codex_tasks(
                {"limit": "10"},
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            task = response["tasks"][0]
            self.assertEqual(task["mode"], "workspace-write")
            self.assertTrue(task["write_audit"])
            self.assertEqual(task["changed_files_count"], 3)
            self.assertTrue(task["protected_path_violation"])
            self.assertNotIn(str(root), json.dumps(response, ensure_ascii=False))

    def test_health_summary_counts_tasks_without_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent_dir = root / "agent"
            agent_dir.mkdir()
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
                        "updated_utc": "2026-05-31T12:00:00Z",
                        "next_action": {
                            "kind": "repair",
                            "description": f"Inspect {root}/private and Authorization: {'Bearer'} secret-token-12345",
                            "can_execute_automatically": False,
                            "reason": "Needs reviewer approval",
                        },
                    }
                )
            )
            (agent_dir / "NEXT_ACTION.md").write_text("Fallback next action")
            fake_github_token = "ghp_" + "abcdefghijklmnopqrstuvwxyz123456"
            (agent_dir / "BLOCKERS.md").write_text(
                f"Blocker references {root}/private and {fake_github_token}"
            )
            config = self.make_config(root)
            self.write_codex_task(root, "task_20260523_120000_done01", status="done")
            self.write_codex_task(root, "task_20260523_130000_run001", status="running")

            response = bridge.handle_health_summary(
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )
            text = json.dumps(response, ensure_ascii=False)

            self.assertTrue(response["ok"])
            self.assertTrue(response["agent_host"]["active"])
            self.assertEqual(response["workspaces"]["count"], 1)
            self.assertEqual(response["tasks"]["recent_count"], 2)
            self.assertEqual(response["tasks"]["active_count"], 1)
            self.assertEqual(response["tasks"]["terminal_count"], 1)
            self.assertEqual(response["supervisor"]["workspace_count"], 1)
            self.assertEqual(response["supervisor"]["blocked_count"], 1)
            self.assertEqual(response["supervisor"]["review_required_count"], 1)
            self.assertEqual(response["supervisor"]["runner_drift_count"], 1)
            signal = response["supervisor"]["signals"][0]
            self.assertEqual(signal["workspace"], "demo")
            self.assertEqual(signal["role"], "runner")
            self.assertEqual(signal["supervisor_mode"], "light")
            self.assertEqual(signal["runner_started_count"], "5")
            self.assertEqual(signal["runner_completed_count"], "3")
            self.assertEqual(signal["runner_failure_drift"], "2")
            self.assertEqual(signal["status"], "blocked")
            self.assertEqual(signal["blocker_type"], "env")
            self.assertTrue(signal["requires_human_review"])
            self.assertIn("[workspace:demo]", signal["next_action"]["description"])
            self.assertNotIn("secret-real-project-path", text)
            self.assertNotIn(str(root), text)
            self.assertNotIn("secret-token-12345", text)
            self.assertNotIn(fake_github_token, text)

    def test_result_page_returns_safe_slice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text(
                "console.log(JSON.stringify({task_id:'task_20260523_120000_page01',"
                "text:'abcdefghi',raw:false,redacted:true,truncated:false}))\n"
            )
            config = self.make_config(root)
            self.write_codex_task(root, "task_20260523_120000_page01", status="done")

            response = bridge.handle_codex_result_page(
                {"task_id": "task_20260523_120000_page01", "page": "2", "page_size": "3"},
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertTrue(response["ok"])
            self.assertEqual(response["text"], "def")
            self.assertEqual(response["page"], 2)
            self.assertEqual(response["total_pages"], 3)
            self.assertTrue(response["has_next"])
            self.assertFalse(response["raw"])

    def test_codex_tasks_filters_and_user_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = bridge.BridgeConfig(
                host="127.0.0.1",
                port=8787,
                mattermost_tokens=("token-1",),
                allowed_users=("chenma", "alice"),
                projects={"demo": bridge.Project(name="demo", root=root)},
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                auth_tokens={},
            )
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma", status="done")
            self.write_codex_task(root, "task_20260523_130000_bbbbbb", user="alice", status="running")

            user_response = bridge.handle_codex_tasks(
                {"limit": "10"},
                config,
                bridge.AuthPrincipal(user="chenma", role="user"),
            )
            self.assertEqual([item["owner"] for item in user_response["tasks"]], ["chenma"])

            admin_response = bridge.handle_codex_tasks(
                {"status": "running", "project": "demo"},
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )
            self.assertEqual(len(admin_response["tasks"]), 1)
            self.assertEqual(admin_response["tasks"][0]["owner"], "alice")

    def test_codex_query_denies_other_user_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text("console.log('should not run')\n")
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma")
            config = bridge.BridgeConfig(
                host="127.0.0.1",
                port=8787,
                mattermost_tokens=("token-1",),
                allowed_users=("chenma", "alice"),
                projects={"demo": bridge.Project(name="demo", root=root)},
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                auth_tokens={},
            )

            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_query(
                    {"task_id": "task_20260523_120000_aaaaaa"},
                    config,
                    "result",
                    bridge.AuthPrincipal(user="alice", role="user"),
                )
            self.assertEqual(ctx.exception.status, 403)

    def test_codex_cancel_denies_finished_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", status="done")
            config = self.make_config(root)

            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_query(
                    {"task_id": "task_20260523_120000_aaaaaa"},
                    config,
                    "cancel",
                    bridge.AuthPrincipal(user="chenma", role="admin"),
                )
            self.assertEqual(ctx.exception.status, 409)

    def test_codex_cancel_denies_other_user_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text("console.log('should not run')\n")
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma", status="running")
            config = bridge.BridgeConfig(
                host="127.0.0.1",
                port=8787,
                mattermost_tokens=("token-1",),
                allowed_users=("chenma", "alice"),
                projects={"demo": bridge.Project(name="demo", root=root)},
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                auth_tokens={},
            )

            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_query(
                    {"task_id": "task_20260523_120000_aaaaaa"},
                    config,
                    "cancel",
                    bridge.AuthPrincipal(user="alice", role="user"),
                )
            self.assertEqual(ctx.exception.status, 403)

    def test_non_admin_cannot_request_raw_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma")
            config = self.make_config(root)

            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_query(
                    {"task_id": "task_20260523_120000_aaaaaa", "raw": "true"},
                    config,
                    "result",
                    bridge.AuthPrincipal(user="chenma", role="user"),
                )
            self.assertEqual(ctx.exception.status, 403)

    def test_admin_raw_result_passes_raw_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            argv_file = root / "argv.json"
            script.parent.mkdir()
            script.write_text(
                "const fs = require('fs');\n"
                f"fs.writeFileSync({str(argv_file)!r}, JSON.stringify(process.argv.slice(2)));\n"
                "console.log(JSON.stringify({task_id:'task_20260523_120000_aaaaaa', text:'raw text', raw:process.argv.includes('--raw'), redacted:false, truncated:false}));\n"
            )
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma")
            config = self.make_config(root)

            response = bridge.handle_codex_query(
                {"task_id": "task_20260523_120000_aaaaaa", "raw": "true"},
                config,
                "result",
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            argv = json.loads(argv_file.read_text())
            self.assertTrue(response["ok"])
            self.assertTrue(response["raw"])
            self.assertIn("--raw", argv)
            self.assertIn("--json-output", argv)

    def test_logs_pass_tail_and_max_chars(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            argv_file = root / "argv.json"
            script.parent.mkdir()
            script.write_text(
                "const fs = require('fs');\n"
                f"fs.writeFileSync({str(argv_file)!r}, JSON.stringify(process.argv.slice(2)));\n"
                "console.log(JSON.stringify({task_id:'task_20260523_120000_aaaaaa', text:'safe logs', raw:false, redacted:true, truncated:true, lines_returned:7}));\n"
            )
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma")
            config = self.make_config(root)

            response = bridge.handle_codex_query(
                {"task_id": "task_20260523_120000_aaaaaa", "tail": "7", "max_chars": "99"},
                config,
                "logs",
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            argv = json.loads(argv_file.read_text())
            self.assertTrue(response["redacted"])
            self.assertTrue(response["truncated"])
            self.assertEqual(response["lines_returned"], 7)
            self.assertIn("--tail", argv)
            self.assertIn("7", argv)
            self.assertIn("--max-chars", argv)
            self.assertIn("99", argv)

    def test_codex_workspaces_do_not_return_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)

            response = bridge.handle_codex_workspaces(
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertTrue(response["ok"])
            self.assertEqual(response["workspaces"][0]["id"], "demo")
            self.assertEqual(response["workspaces"][0]["default_mode"], "readonly")
            self.assertEqual(response["workspaces"][0]["allowed_modes"], ["readonly"])
            self.assertNotIn(str(root), json.dumps(response, ensure_ascii=False))

    def test_codex_capabilities_report_agent_host_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)

            response = bridge.handle_codex_capabilities(
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual(response["version"], bridge.AGENT_HOST_VERSION)
            self.assertIn("run", response["commands"])
            self.assertTrue(response["features"]["auth"])
            self.assertTrue(response["features"]["safe_output"])
            self.assertTrue(response["features"]["sse"])
            self.assertFalse(response["features"]["resume"])
            self.assertFalse(response["features"]["write_mode"])
            self.assertEqual(response["modes"], ["readonly"])

            write_response = bridge.handle_codex_capabilities(
                self.make_write_config(root),
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )
            self.assertTrue(write_response["features"]["write_mode"])
            self.assertEqual(write_response["modes"], ["workspace-write"])

    def test_codex_run_passes_adapter_metadata_and_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            argv_file = root / "argv.json"
            script.parent.mkdir()
            script.write_text(
                "const fs = require('fs');\n"
                f"fs.writeFileSync({str(argv_file)!r}, JSON.stringify(process.argv.slice(2)));\n"
                "console.log('queued task_20260523_120000_adapt1');\n"
                "console.log('idempotent=true');\n"
            )
            config = self.make_config(root)
            reference_task_id = "task_20260523_115959_ref001"
            self.write_codex_task(root, reference_task_id)

            response = bridge.handle_codex_run(
                {
                    "workspace": "demo",
                    "prompt": "hello",
                    "mode": "readonly",
                    "source": "web",
                    "source_user_id": "browser-user",
                    "source_channel_id": "browser",
                    "source_message_id": "submit-1",
                    "idempotency_key": "web:test-key",
                    "reference_task_id": reference_task_id,
                    "metadata": json.dumps({"client": "web-ui"}),
                },
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            argv = json.loads(argv_file.read_text())
            self.assertTrue(response["ok"])
            self.assertTrue(response["idempotent_replay"])
            self.assertEqual(response["source"], "web")
            self.assertIn("--source", argv)
            self.assertIn("web", argv)
            self.assertIn("--source-user-id", argv)
            self.assertIn("browser-user", argv)
            self.assertIn("--source-channel-id", argv)
            self.assertIn("browser", argv)
            self.assertIn("--source-message-id", argv)
            self.assertIn("submit-1", argv)
            self.assertIn("--idempotency-key", argv)
            self.assertIn("web:test-key", argv)
            self.assertIn("--reference-task-id", argv)
            self.assertIn(reference_task_id, argv)
            self.assertEqual(response["reference_task_id"], reference_task_id)
            self.assertIn("--metadata", argv)
            self.assertIn('{"client":"web-ui"}', argv)
            self.assertIn("--mode", argv)
            self.assertIn("readonly", argv)

    def test_codex_run_reference_task_requires_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            script.parent.mkdir()
            script.write_text("console.log('should not run')\n")
            reference_task_id = "task_20260523_115959_ref001"
            self.write_codex_task(root, reference_task_id, user="alice")
            config = bridge.BridgeConfig(
                host="127.0.0.1",
                port=8787,
                mattermost_tokens=("token-1",),
                allowed_users=("chenma", "alice"),
                projects={"demo": bridge.Project(name="demo", root=root)},
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                auth_tokens={},
            )

            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_codex_run(
                    {
                        "workspace": "demo",
                        "prompt": "hello",
                        "reference_task_id": reference_task_id,
                    },
                    config,
                    bridge.AuthPrincipal(user="chenma", role="user"),
                )

            self.assertEqual(ctx.exception.status, 403)

    def test_codex_tasks_returns_source_without_adapter_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.make_config(root)
            task_dir = self.write_codex_task(
                root,
                "task_20260523_120000_aaaaaa",
                source="discord",
            )
            task_file = task_dir / "task.json"
            task = json.loads(task_file.read_text())
            task["adapter_metadata"] = {"secret": "do-not-return"}
            task_file.write_text(json.dumps(task, ensure_ascii=False, indent=2))

            response = bridge.handle_codex_tasks(
                {"limit": "10"},
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            self.assertEqual(response["tasks"][0]["source"], "discord")
            self.assertNotIn("adapter_metadata", response["tasks"][0])
            self.assertNotIn("do-not-return", json.dumps(response, ensure_ascii=False))

    def test_api_error_payload_is_stable(self):
        payload = bridge.api_error_payload(
            bridge.BridgeError(
                "User is not allowed to access this workspace.",
                403,
                "permission_denied",
                {"workspace": "demo"},
            )
        )

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "permission_denied")
        self.assertEqual(payload["error"]["message"], "User is not allowed to access this workspace.")
        self.assertEqual(payload["error"]["details"], {"workspace": "demo"})

    def test_stream_token_binds_task_and_expires(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bridge.STREAM_TOKENS.clear()
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", status="running")
            config = self.make_config(root)

            response = bridge.handle_stream_token(
                {"task_id": "task_20260523_120000_aaaaaa"},
                config,
                bridge.AuthPrincipal(user="chenma", role="admin"),
            )

            token = response["stream_token"]
            principal = bridge.principal_from_stream_token("task_20260523_120000_aaaaaa", token)
            self.assertEqual(principal.user, "chenma")
            self.assertEqual(principal.role, "admin")

            with self.assertRaises(bridge.BridgeError) as wrong_task:
                bridge.principal_from_stream_token("task_20260523_130000_bbbbbb", token)
            self.assertEqual(wrong_task.exception.status, 403)

            bridge.STREAM_TOKENS[token]["expires_at_dt"] = bridge.utc_now() - dt.timedelta(seconds=1)
            with self.assertRaises(bridge.BridgeError) as expired:
                bridge.principal_from_stream_token("task_20260523_120000_aaaaaa", token)
            self.assertEqual(expired.exception.status, 401)

    def test_stream_token_denies_other_user_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bridge.STREAM_TOKENS.clear()
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma", status="running")
            config = bridge.BridgeConfig(
                host="127.0.0.1",
                port=8787,
                mattermost_tokens=("token-1",),
                allowed_users=("chenma", "alice"),
                projects={"demo": bridge.Project(name="demo", root=root)},
                codex_bridge_root=root,
                codex_bridge_node_bin="node",
                auth_tokens={},
            )

            with self.assertRaises(bridge.BridgeError) as ctx:
                bridge.handle_stream_token(
                    {"task_id": "task_20260523_120000_aaaaaa"},
                    config,
                    bridge.AuthPrincipal(user="alice", role="user"),
                )
            self.assertEqual(ctx.exception.status, 403)

    def test_safe_log_snapshot_uses_json_safe_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "scripts" / "codex-bridge.js"
            argv_file = root / "argv.json"
            script.parent.mkdir()
            script.write_text(
                "const fs = require('fs');\n"
                f"fs.writeFileSync({str(argv_file)!r}, JSON.stringify(process.argv.slice(2)));\n"
                "console.log(JSON.stringify({task_id:'task_20260523_120000_aaaaaa', text:'safe logs', raw:false, redacted:true, truncated:false, lines_returned:3}));\n"
            )
            self.write_codex_task(root, "task_20260523_120000_aaaaaa", user="chenma", status="running")
            config = self.make_config(root)

            response = bridge.safe_log_snapshot(config, "task_20260523_120000_aaaaaa")

            argv = json.loads(argv_file.read_text())
            self.assertEqual(response["text"], "safe logs")
            self.assertTrue(response["redacted"])
            self.assertFalse(response["raw"])
            self.assertIn("logs", argv)
            self.assertIn("--json-output", argv)
            self.assertIn("--tail", argv)
            self.assertIn(str(bridge.SSE_LOG_TAIL_LINES), argv)
            self.assertIn("--max-chars", argv)
            self.assertIn(str(bridge.SSE_LOG_MAX_CHARS), argv)

    def test_redact_url_secrets(self):
        text = bridge.redact_url_secrets(
            'GET /codex/events?task_id=task_1&stream_token=secret-stream&token=legacy HTTP/1.1'
        )
        self.assertIn("stream_token=[REDACTED]", text)
        self.assertIn("token=[REDACTED]", text)
        self.assertNotIn("secret-stream", text)
        self.assertNotIn("legacy", text)

    def test_check_config_command_does_not_print_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "scripts" / "codex-bridge.js").write_text("console.log('ok')\n")
            config_path = root / "config.json"
            mattermost_token = "mattermost-super-secret"
            bearer_token = "agent-host-super-secret"
            config_path.write_text(json.dumps({
                "host": "127.0.0.1",
                "port": 8787,
                "mattermost_tokens": [mattermost_token],
                "allowed_users": ["chenma"],
                "auth": {
                    "tokens": {
                        bearer_token: {
                            "user": "chenma",
                            "role": "admin",
                        }
                    }
                },
                "codex_bridge_root": str(root),
                "codex_bridge_node_bin": "node",
                "projects": {
                    "demo": str(root),
                },
            }))

            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parents[1] / "bridge.py"), "--config", str(config_path), "--check-config"],
                text=True,
                capture_output=True,
                check=False,
            )

        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("OK Codex auth token count - 1", combined)
        self.assertNotIn(mattermost_token, combined)
        self.assertNotIn(bearer_token, combined)

    def test_service_templates_do_not_inline_tokens(self):
        root = Path(__file__).resolve().parents[1]
        module_root = root.parent
        repo_root = module_root.parent
        discord_service = module_root / "discord_agent_adapter" / "systemd" / "user" / "discord-agent-adapter.service"
        if not discord_service.exists():
            discord_service = repo_root / "systemd" / "user" / "discord-agent-adapter.service"
        files = [
            root / "systemd" / "user" / "agent-host-web.service" if (root / "systemd" / "user" / "agent-host-web.service").exists() else repo_root / "systemd" / "user" / "agent-host-web.service",
            discord_service,
            root / "secrets.env.example",
        ]
        combined = "\n".join(path.read_text() for path in files)
        self.assertNotIn("Environment=DISCORD_BOT_TOKEN=", combined)
        self.assertNotIn("Environment=AGENT_HOST_TOKEN=", combined)
        self.assertNotIn("replace-with-real-discord-token", combined)
        self.assertIn("EnvironmentFile=%h/.config/agent-host/secrets.env", combined)


if __name__ == "__main__":
    unittest.main()
