import asyncio
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import bot
from agent_host_client import AgentHostClient, AgentHostError, parse_status_text, truncate_text


class RecordingHandler(BaseHTTPRequestHandler):
    records = []
    leak_path = ""

    def log_message(self, _fmt, *_args):
        return

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode())

    def send_payload(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def record(self, payload=None):
        parsed = urlparse(self.path)
        item = {
            "method": self.command,
            "path": parsed.path,
            "query": parse_qs(parsed.query),
            "authorization": self.headers.get("Authorization", ""),
            "payload": payload or {},
        }
        self.records.append(item)
        return item

    def do_GET(self):
        item = self.record()
        if item["path"] == "/health":
            self.send_payload(200, {"ok": True})
        elif item["path"] == "/health/summary":
            self.send_payload(200, {
                "ok": True,
                "agent_host": {"active": True, "version": "mvp-v0.7"},
                "workspaces": {"modes": ["readonly"], "items": [{"id": "self"}]},
                "tasks": {"recent_count": 1, "active_count": 0, "latest_terminal": {"task_id": "task_123", "status": "done"}},
            })
        elif item["path"] == "/codex/capabilities":
            self.send_payload(200, {
                "ok": True,
                "version": "mvp-v0.7",
                "features": {"auth": True, "safe_output": True, "sse": True, "cancel": True, "timeout": True},
            })
        elif item["path"] == "/codex/tasks":
            self.send_payload(200, {"ok": True, "tasks": [{"task_id": "task_1"}]})
        elif item["path"] == "/codex/workspaces":
            workspace = {"id": "self", "allowed_modes": ["readonly"]}
            if self.leak_path:
                workspace["path"] = self.leak_path
            self.send_payload(200, {"ok": True, "workspaces": [workspace]})
        else:
            self.send_payload(404, {"ok": False, "error": {"code": "not_found", "message": "not found", "details": {}}})

    def do_POST(self):
        payload = self.read_json()
        item = self.record(payload)
        if item["path"] == "/codex/prepare":
            self.send_payload(200, {
                "ok": True,
                "intake_id": "intake_20260604_000001_ab12cd",
                "status": "need_user_reply",
                "questions": ["请说明允许改动的文件范围。"],
                "contract": {"objective": "local_workspace_copy", "risk_class": "medium"},
                "preflight": {"ok": False, "required_action": "reply_to_questions", "reasons": ["Task intent still has unresolved gray areas."]},
            })
        elif item["path"] == "/codex/run":
            self.send_payload(200, {"ok": True, "task_id": "task_123", "status": "queued"})
        elif item["path"] == "/codex/status":
            self.send_payload(200, {"ok": True, "text": "task_id: task_123\nstatus: done\n"})
        elif item["path"] == "/codex/result":
            self.send_payload(200, {"ok": True, "text": "safe result", "raw": False})
        elif item["path"] == "/codex/result-page":
            self.send_payload(200, {"ok": True, "task_id": "task_123", "page": 2, "total_pages": 3, "text": "page text", "raw": False})
        elif item["path"] == "/codex/cancel":
            self.send_payload(409, {
                "ok": False,
                "error": {
                    "code": "task_already_finished",
                    "message": "task already finished",
                    "details": {},
                },
                "text": "task already finished",
            })
        else:
            self.send_payload(404, {"ok": False, "error": {"code": "not_found", "message": "not found", "details": {}}})


class ClientTests(unittest.TestCase):
    def setUp(self):
        RecordingHandler.records = []
        RecordingHandler.leak_path = ""
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def client(self):
        return AgentHostClient(self.base_url, "demo", timeout_seconds=5)

    def test_run_constructs_agent_host_request(self):
        response = self.client().run(
            workspace="self",
            prompt="hello",
            mode="readonly",
            source_user_id="discord-user",
            source_channel_id="discord-channel",
            source_message_id="interaction-1",
            idempotency_key="discord:interaction-1",
            guild_id="guild-1",
            reference_task_id="task_20260525_120000_ref001",
        )

        self.assertEqual(response["task_id"], "task_123")
        record = RecordingHandler.records[-1]
        self.assertEqual(record["path"], "/codex/run")
        self.assertEqual(record["authorization"], "Bearer demo")
        payload = record["payload"]
        self.assertEqual(payload["source"], "discord")
        self.assertEqual(payload["workspace"], "self")
        self.assertEqual(payload["mode"], "readonly")
        self.assertEqual(payload["source_user_id"], "discord-user")
        self.assertEqual(payload["source_channel_id"], "discord-channel")
        self.assertEqual(payload["source_message_id"], "interaction-1")
        self.assertEqual(payload["idempotency_key"], "discord:interaction-1")
        self.assertEqual(payload["reference_task_id"], "task_20260525_120000_ref001")
        self.assertEqual(payload["metadata"]["guild_id"], "guild-1")
        self.assertEqual(payload["metadata"]["command"], "/agent_run")
        self.assertNotIn("user", payload)
        self.assertNotIn("internal_user", payload)

    def test_prepare_constructs_agent_host_request(self):
        response = self.client().prepare(
            workspace="self",
            prompt="Please fix this config issue",
            source_user_id="discord-user",
            source_channel_id="discord-channel",
            source_message_id="interaction-2",
            guild_id="guild-1",
            intake_id="intake_20260604_000001_ab12cd",
            answers="Only modify README.md and docs/setup/README.md",
            mode="readonly",
            reference_task_id="task_20260525_120000_ref001",
        )

        self.assertEqual(response["status"], "need_user_reply")
        record = RecordingHandler.records[-1]
        self.assertEqual(record["path"], "/codex/prepare")
        self.assertEqual(record["authorization"], "Bearer demo")
        payload = record["payload"]
        self.assertEqual(payload["workspace"], "self")
        self.assertEqual(payload["prompt"], "Please fix this config issue")
        self.assertEqual(payload["intake_id"], "intake_20260604_000001_ab12cd")
        self.assertEqual(payload["answers"], "Only modify README.md and docs/setup/README.md")
        self.assertEqual(payload["mode"], "readonly")
        self.assertEqual(payload["reference_task_id"], "task_20260525_120000_ref001")
        self.assertEqual(payload["metadata"]["command"], "/agent_prepare")

    def test_cancel_error_uses_stable_error_format_without_token_leak(self):
        with self.assertRaises(AgentHostError) as ctx:
            self.client().cancel("task_123")

        self.assertEqual(ctx.exception.code, "task_already_finished")
        self.assertEqual(ctx.exception.status, 409)
        self.assertNotIn("demo", str(ctx.exception))

    def test_health_does_not_send_bearer_token(self):
        self.client().health()
        self.assertEqual(RecordingHandler.records[-1]["path"], "/health")
        self.assertEqual(RecordingHandler.records[-1]["authorization"], "")

    def test_health_summary_uses_bearer_token(self):
        response = self.client().health_summary()
        self.assertTrue(response["agent_host"]["active"])
        record = RecordingHandler.records[-1]
        self.assertEqual(record["path"], "/health/summary")
        self.assertEqual(record["authorization"], "Bearer demo")

    def test_result_page_constructs_request(self):
        response = self.client().result_page("task_123", page=2, page_size=1200)
        self.assertEqual(response["text"], "page text")
        record = RecordingHandler.records[-1]
        self.assertEqual(record["path"], "/codex/result-page")
        self.assertEqual(record["payload"]["task_id"], "task_123")
        self.assertEqual(record["payload"]["page"], "2")
        self.assertEqual(record["payload"]["page_size"], "1200")


class BotHelperTests(unittest.TestCase):
    def make_config(self):
        return bot.AdapterConfig(
            agent_host_base_url="http://127.0.0.1:8787",
            agent_host_token="agent-token",
            agent_host_timeout_seconds=30,
            discord_bot_token="discord-token",
            discord_guild_id="guild-1",
            allowed_guild_ids=("guild-1",),
            allowed_channel_ids=("channel-1",),
            default_workspace="self",
            command_prefix="agent",
            users={"user-1": bot.DiscordUser(internal_user="chenma", role="admin")},
            max_prompt_chars=20,
            max_result_chars=20,
            state_dir=Path(tempfile.gettempdir()) / "discord-agent-adapter-test-state",
            watcher_interval_seconds=10,
        )

    def test_permission_checks(self):
        config = self.make_config()
        user = bot.authorize(config, "guild-1", "channel-1", "user-1")
        self.assertEqual(user.internal_user, "chenma")

        with self.assertRaises(bot.PermissionDenied):
            bot.authorize(config, "guild-2", "channel-1", "user-1")
        with self.assertRaises(bot.PermissionDenied):
            bot.authorize(config, "guild-1", "channel-2", "user-1")
        with self.assertRaises(bot.PermissionDenied):
            bot.authorize(config, "guild-1", "channel-1", "user-2")

    def test_prompt_and_result_limits(self):
        self.assertEqual(bot.ensure_prompt_allowed(" hello ", 20), "hello")
        with self.assertRaises(ValueError):
            bot.ensure_prompt_allowed("x" * 21, 20)

        text, truncated = truncate_text("abcdef", 4)
        self.assertTrue(truncated)
        self.assertLessEqual(len(text), len("\n\n[truncated]") + 1)

    def test_split_discord_text_chunks_long_messages(self):
        text = "段落一 " + ("alpha " * 120) + "\n\n" + "段落二 " + ("beta " * 120)
        chunks = bot.split_discord_text(text, 200)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(chunks[0].startswith("[1/"))
        for chunk in chunks:
            self.assertLessEqual(len(chunk), 200)

    def test_split_discord_text_redacts_before_chunking(self):
        text = "/home/example/project Authorization: Bearer demo-token " + ("x" * 300)
        chunks = bot.split_discord_text(text, 120)

        self.assertGreater(len(chunks), 1)
        combined = "\n".join(chunks)
        self.assertNotIn("/home/example", combined)
        self.assertNotIn("demo-token", combined)
        self.assertIn("Authorization: Bearer [REDACTED]", combined)

    def test_format_task_response_uses_safe_result_summary(self):
        response = bot.format_task_response(
            {"text": "task_id: task_123\nstatus: done\n"},
            {"text": "safe result " * 20, "raw": False},
            40,
        )
        self.assertIn("Task done.", response)
        self.assertIn("safe result safe result", response)
        self.assertNotIn("Result truncated", response)
        self.assertNotIn("/home/chenma", response)

    def test_policy_violation_task_response_uses_safe_result_summary(self):
        response = bot.format_task_response(
            {"text": "task_id: task_123\nstatus: policy_violation\n"},
            {"text": "Write Summary:\nprotected_path_violation: true", "raw": False},
            200,
        )

        self.assertIn("policy violation", response)
        self.assertIn("Write Summary", response)

    def test_format_status_is_conversational(self):
        response = bot.format_status(
            {"version": "mvp-v0.7", "features": {"cancel": True, "timeout": True, "write_mode": True}, "modes": ["readonly", "workspace-write"]},
            {"tasks": [{"task_id": "task_1"}]},
            {"workspaces": [{"id": "self"}, {"id": "grokking"}]},
        )

        self.assertIn("我在线", response)
        self.assertIn("self, grokking", response)
        self.assertIn("最近任务：1 个", response)
        self.assertIn("/agent_run", response)
        self.assertNotIn("Features:", response)

    def test_format_status_uses_command_prefix(self):
        response = bot.format_status(
            {"version": "mvp-v0.7", "features": {"cancel": True, "timeout": True}, "modes": ["readonly"]},
            {"tasks": []},
            {"workspaces": [{"id": "main_codex"}]},
            "server_agent",
        )

        self.assertIn("/server_agent_run", response)
        self.assertIn("/server_agent_task", response)

    def test_format_prepare_response_shows_questions(self):
        response = bot.format_prepare_response(
            {
                "intake_id": "intake_20260604_000001_ab12cd",
                "status": "need_user_reply",
                "questions": ["请说明允许改动的文件范围。"],
                "contract": {"objective": "local_workspace_copy", "risk_class": "medium"},
                "preflight": {"ok": False, "required_action": "reply_to_questions", "reasons": ["Task intent still has unresolved gray areas."]},
            },
            "self",
            "agent",
        )

        self.assertIn("intake_id: intake_20260604_000001_ab12cd", response)
        self.assertIn("请说明允许改动的文件范围", response)
        self.assertIn("/agent_prepare", response)

    def test_format_health_summary_is_safe(self):
        response = bot.format_health_summary(
            {
                "agent_host": {"active": True, "version": "mvp-v0.7"},
                "workspaces": {
                    "modes": ["readonly", "workspace-write"],
                    "items": [{"id": "main_codex"}, {"id": "grokking"}],
                },
                "tasks": {
                    "recent_count": 3,
                    "active_count": 1,
                    "latest_terminal": {"task_id": "task_123", "status": "done"},
                },
                "supervisor": {
                    "blocked_count": 1,
                    "review_required_count": 1,
                    "runner_drift_count": 1,
                    "signals": [
                        {
                            "workspace": "main_codex",
                            "supervisor_mode": "audit",
                            "runner_failure_drift": "3",
                            "status": "blocked",
                            "blocker_type": "env",
                            "requires_human_review": True,
                            "next_action": {
                                "description": "Inspect /home/chenma/private with Authorization: " + "Bearer secret-token",
                            },
                        }
                    ],
                },
            },
            command_prefix="server_agent",
        )

        self.assertIn("Agent Host 健康摘要", response)
        self.assertIn("main_codex, grokking", response)
        self.assertIn("Supervisor signals", response)
        self.assertIn("mode=audit", response)
        self.assertIn("drift=3", response)
        self.assertIn("blocker=env", response)
        self.assertIn("/server_agent_task_page", response)
        self.assertNotIn("/home/chenma", response)
        self.assertNotIn("secret-token", response)

    def test_format_task_page_response(self):
        response = bot.format_task_page_response(
            {
                "task_id": "task_123",
                "page": 1,
                "total_pages": 3,
                "has_next": True,
                "text": "/home/example/Documents/My_App_Dev/x Authorization: Bearer demo",
            },
            500,
        )

        self.assertIn("Page: 1/3", response)
        self.assertIn("Next page: 2", response)
        self.assertNotIn("/home/example", response)
        self.assertNotIn("Bearer demo", response)

    def test_thread_state_store_persists_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = bot.ThreadStateStore(Path(tmp))
            store.upsert_thread(
                task_id="task_123",
                guild_id="guild-1",
                channel_id="channel-1",
                thread_id="thread-1",
                created_by="user-1",
                workspace="self",
                status="running",
            )

            restored = bot.ThreadStateStore(Path(tmp))
            records = restored.load()
            self.assertEqual(records["task_123"]["thread_id"], "thread-1")
            self.assertEqual(restored.task_id_for_thread("thread-1"), "task_123")
            self.assertEqual(len(restored.pending()), 1)
            restored.mark_notified("task_123", "done")
            self.assertEqual(restored.pending(), [])

    def test_thread_state_store_persists_message_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = bot.ThreadStateStore(Path(tmp))
            store.upsert_thread(
                task_id="task_123",
                guild_id="guild-1",
                channel_id="channel-1",
                thread_id="thread-1",
                created_by="user-1",
                workspace="main_codex",
                status="running",
            )
            store.remember_message(
                message_id="msg-1",
                task_id="task_123",
                thread_id="thread-1",
                workspace="main_codex",
                kind="thread_intro",
            )

            restored = bot.ThreadStateStore(Path(tmp))
            self.assertEqual(restored.task_id_for_message("msg-1"), "task_123")
            self.assertEqual(restored.latest_record_for_thread("thread-1")["workspace"], "main_codex")

    def test_completion_watcher_notifies_done_once(self):
        class FakeAgent:
            def __init__(self):
                self.result_max_chars = []

            def status(self, task_id):
                return {"ok": True, "text": f"task_id: {task_id}\nstatus: done\n"}

            def result(self, task_id, max_chars=None):
                self.result_max_chars.append(max_chars)
                return {"ok": True, "text": "safe result", "raw": False}

        class FakeNotifier:
            def __init__(self):
                self.messages = []

            async def send(self, record, message):
                self.messages.append((record, message))

        with tempfile.TemporaryDirectory() as tmp:
            store = bot.ThreadStateStore(Path(tmp))
            store.upsert_thread(
                task_id="task_123",
                guild_id="guild-1",
                channel_id="channel-1",
                thread_id="thread-1",
                created_by="user-1",
                workspace="self",
                status="running",
            )
            notifier = FakeNotifier()
            agent = FakeAgent()

            sent = asyncio.run(bot.process_completion_notifications(
                store=store,
                agent=agent,
                notifier=notifier,
                max_result_chars=100,
            ))
            sent_again = asyncio.run(bot.process_completion_notifications(
                store=store,
                agent=agent,
                notifier=notifier,
                max_result_chars=100,
            ))

        self.assertEqual(sent, 1)
        self.assertEqual(sent_again, 0)
        self.assertEqual(len(notifier.messages), 1)
        self.assertIn("任务完成", notifier.messages[0][1])
        self.assertEqual(agent.result_max_chars, [None])

    def test_completion_watcher_marks_stale_terminal_thread_repaired(self):
        class FakeAgent:
            def status(self, task_id):
                return {"ok": True, "text": f"task_id: {task_id}\nstatus: done\n"}

            def result(self, task_id, max_chars=None):
                return {"ok": True, "text": "safe result", "raw": False}

        class FakeNotifier:
            async def send(self, record, message):
                return None

        with tempfile.TemporaryDirectory() as tmp:
            store = bot.ThreadStateStore(Path(tmp))
            store.upsert_thread(
                task_id="task_123",
                guild_id="guild-1",
                channel_id="channel-1",
                thread_id="thread-1",
                created_by="user-1",
                workspace="self",
                status="done",
            )

            sent = asyncio.run(bot.process_completion_notifications(
                store=store,
                agent=FakeAgent(),
                notifier=FakeNotifier(),
                max_result_chars=100,
            ))
            record = store.load()["task_123"]

        self.assertEqual(sent, 1)
        self.assertTrue(record["notified_done"])
        self.assertIn("repaired_at", record)

    def test_completion_message_sanitizes_result(self):
        response = bot.format_completion_message(
            "task_123",
            {"text": "task_id: task_123\nstatus: done\n"},
            {"text": "/home/example/Documents/My_App_Dev/x Authorization: Bearer demo"},
            500,
        )

        self.assertIn("🤖 AI 回答", response)
        self.assertNotIn("/home/example", response)
        self.assertNotIn("Bearer demo", response)
        self.assertIn("Authorization: Bearer [REDACTED]", response)

    def test_completion_message_keeps_full_safe_result_for_chunking(self):
        response = bot.format_completion_message(
            "task_123",
            {"text": "task_id: task_123\nstatus: done\n"},
            {"text": "safe result " * 20},
            40,
        )

        self.assertIn("safe result safe result", response)
        self.assertNotIn("Result truncated", response)

    def test_completion_message_uses_result_for_policy_violation(self):
        response = bot.format_completion_message(
            "task_123",
            {"text": "task_id: task_123\nstatus: policy_violation\n"},
            {"text": "Write Summary:\nprotected_path_violation: true"},
            500,
        )

        self.assertIn("protected path policy", response)
        self.assertIn("Write Summary", response)

    def test_thread_intro_sanitizes_prompt_secrets(self):
        response = bot.format_thread_intro(
            "task_123",
            "self",
            "workspace-write",
            "check this DISCORD_BOT_TOKEN=dummy-secret and SECRET_KEY=super-secret",
        )

        self.assertIn("👤 你的提问", response)
        self.assertIn("⏳ 等待 AI 回答", response)
        self.assertNotIn("dummy-secret", response)
        self.assertNotIn("super-secret", response)
        self.assertIn("DISCORD_BOT_TOKEN=[REDACTED_SECRET]", response)
        self.assertIn("SECRET_KEY=[REDACTED_SECRET]", response)
        self.assertIn("Write audit", response)

    def test_thread_intro_can_show_reference_task(self):
        response = bot.format_thread_intro(
            "task_456",
            "main_codex",
            "workspace-write",
            "continue",
            "task_123",
        )

        self.assertIn("reference_task_id: task_123", response)

    def test_safe_reference_task_id_validation(self):
        self.assertEqual(bot.safe_reference_task_id(" task_20260525_120000_ref001 "), "task_20260525_120000_ref001")
        with self.assertRaises(ValueError):
            bot.safe_reference_task_id("../../bad")

    def test_extract_task_id_from_text_supports_intro_and_completion_formats(self):
        self.assertEqual(
            bot.extract_task_id_from_text("task_id: task_20260604_000001_abc123"),
            "task_20260604_000001_abc123",
        )
        self.assertEqual(
            bot.extract_task_id_from_text("任务完成。\n\nTask: task_20260604_000002_def456"),
            "task_20260604_000002_def456",
        )
        self.assertEqual(bot.extract_task_id_from_text("no task here"), "")

    def test_resolve_reference_task_id_from_reply_prefers_message_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = bot.ThreadStateStore(Path(tmp))
            store.upsert_thread(
                task_id="task_latest",
                guild_id="guild-1",
                channel_id="channel-1",
                thread_id="thread-1",
                created_by="user-1",
                workspace="main_codex",
                status="done",
            )
            store.remember_message(
                message_id="msg-1",
                task_id="task_specific",
                thread_id="thread-1",
                workspace="main_codex",
                kind="completion",
            )

            resolved = bot.resolve_reference_task_id_from_reply(
                store,
                thread_id="thread-1",
                referenced_message_id="msg-1",
                referenced_message_text="Task: task_other",
            )

        self.assertEqual(resolved, "task_specific")

    def test_resolve_reference_task_id_from_reply_falls_back_to_thread_latest(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = bot.ThreadStateStore(Path(tmp))
            store.upsert_thread(
                task_id="task_latest",
                guild_id="guild-1",
                channel_id="channel-1",
                thread_id="thread-1",
                created_by="user-1",
                workspace="main_codex",
                status="done",
            )

            resolved = bot.resolve_reference_task_id_from_reply(
                store,
                thread_id="thread-1",
                referenced_message_id="unknown",
                referenced_message_text="",
            )

        self.assertEqual(resolved, "task_latest")

    def test_command_prefix_validation(self):
        self.assertEqual(bot.safe_command_prefix("server_agent"), "server_agent")
        self.assertEqual(bot.slash_command_name("server_agent", "run"), "server_agent_run")
        with self.assertRaises(ValueError):
            bot.safe_command_prefix("Bad Prefix!")

    def test_authorize_candidates_accepts_thread_parent_channel(self):
        config = self.make_config()
        user = bot.authorize_candidates(config, "guild-1", ("thread-1", "channel-1"), "user-1")
        self.assertEqual(user.internal_user, "chenma")

    def test_load_config_from_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({
                "agent_host": {
                    "base_url": "http://127.0.0.1:8787",
                    "token_env": "TEST_AGENT_HOST_TOKEN",
                },
                "discord": {
                    "bot_token_env": "TEST_DISCORD_BOT_TOKEN",
                    "guild_id_env": "TEST_DISCORD_GUILD_ID",
                    "default_workspace": "self",
                    "command_prefix": "server_agent",
                    "allowed_guild_ids": ["guild-1"],
                    "allowed_channel_ids": ["channel-1"],
                    "users": {"user-1": {"internal_user": "chenma", "role": "admin"}},
                },
            }))
            old_env = dict(os.environ)
            try:
                os.environ["TEST_AGENT_HOST_TOKEN"] = "agent-token"
                os.environ["TEST_DISCORD_BOT_TOKEN"] = "discord-token"
                os.environ["TEST_DISCORD_GUILD_ID"] = "guild-1"
                config = bot.load_config(config_path)
            finally:
                os.environ.clear()
                os.environ.update(old_env)

        self.assertEqual(config.agent_host_token, "agent-token")
        self.assertEqual(config.discord_bot_token, "discord-token")
        self.assertEqual(config.discord_guild_id, "guild-1")
        self.assertEqual(config.default_workspace, "self")
        self.assertEqual(config.command_prefix, "server_agent")

    def test_parse_status_text(self):
        self.assertEqual(parse_status_text("task_id: task_1\nstatus: running\n"), "running")
        self.assertEqual(parse_status_text("missing"), "unknown")

    def test_validate_check_config_success(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = bot.AdapterConfig(
                agent_host_base_url=f"http://127.0.0.1:{server.server_port}",
                agent_host_token="demo",
                agent_host_timeout_seconds=5,
                discord_bot_token="demo",
                discord_guild_id="guild-1",
                allowed_guild_ids=("guild-1",),
                allowed_channel_ids=("channel-1",),
                default_workspace="self",
                command_prefix="agent",
                users={"user-1": bot.DiscordUser(internal_user="chenma", role="admin")},
                max_prompt_chars=20,
                max_result_chars=20,
                state_dir=Path(tempfile.gettempdir()) / "discord-agent-adapter-test-state",
                watcher_interval_seconds=10,
            )
            checks = bot.validate_check_config(config, cwd=Path("/tmp/not-leaked"))
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

        self.assertTrue(all(ok for _name, ok, _detail in checks), checks)

    def test_validate_check_config_detects_workspace_path_leak(self):
        RecordingHandler.leak_path = "/home/chenma/Documents/My_App_Dev/secret"
        server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = bot.AdapterConfig(
                agent_host_base_url=f"http://127.0.0.1:{server.server_port}",
                agent_host_token="demo",
                agent_host_timeout_seconds=5,
                discord_bot_token="demo",
                discord_guild_id="guild-1",
                allowed_guild_ids=("guild-1",),
                allowed_channel_ids=("channel-1",),
                default_workspace="self",
                command_prefix="agent",
                users={"user-1": bot.DiscordUser(internal_user="chenma", role="admin")},
                max_prompt_chars=20,
                max_result_chars=20,
                state_dir=Path(tempfile.gettempdir()) / "discord-agent-adapter-test-state",
                watcher_interval_seconds=10,
            )
            checks = bot.validate_check_config(config, cwd=Path("/tmp/not-leaked"))
        finally:
            RecordingHandler.leak_path = ""
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

        redaction = [item for item in checks if item[0] == "/codex/workspaces path redaction"][0]
        self.assertFalse(redaction[1])

    def test_check_config_command_does_not_print_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({
                "agent_host": {
                    "base_url": "http://127.0.0.1:1",
                    "token_env": "TEST_AGENT_HOST_TOKEN",
                },
                "discord": {
                    "bot_token_env": "TEST_DISCORD_BOT_TOKEN",
                    "guild_id_env": "TEST_DISCORD_GUILD_ID",
                    "allowed_guild_ids": ["guild-1"],
                    "allowed_channel_ids": ["channel-1"],
                    "users": {"user-1": {"internal_user": "chenma", "role": "admin"}},
                },
            }))
            env = dict(os.environ)
            env["TEST_AGENT_HOST_TOKEN"] = "agent-super-secret"
            env["TEST_DISCORD_BOT_TOKEN"] = "discord-super-secret"
            env["TEST_DISCORD_GUILD_ID"] = "guild-1"
            result = subprocess.run(
                [sys.executable, str(ROOT / "bot.py"), "--config", str(config_path), "--check-config"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )

        combined = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("agent-super-secret", combined)
        self.assertNotIn("discord-super-secret", combined)
        self.assertIn("FAIL Agent Host /health", combined)

    def test_systemd_unit_uses_environment_file(self):
        unit = ROOT / "systemd" / "user" / "discord-agent-adapter.service"
        text = unit.read_text()
        self.assertIn("EnvironmentFile=%h/.config/agent-host/secrets.env", text)
        self.assertNotIn("Environment=DISCORD_BOT_TOKEN=", text)
        self.assertNotIn("Environment=AGENT_HOST_TOKEN=", text)


if __name__ == "__main__":
    unittest.main()
