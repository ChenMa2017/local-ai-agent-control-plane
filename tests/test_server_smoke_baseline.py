import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "server_smoke_baseline.py"
SPEC = importlib.util.spec_from_file_location("server_smoke_baseline", SCRIPT)
server_smoke_baseline = importlib.util.module_from_spec(SPEC)
sys.modules["server_smoke_baseline"] = server_smoke_baseline
SPEC.loader.exec_module(server_smoke_baseline)


class ServerSmokeBaselineTests(unittest.TestCase):
    def test_parse_env_file_reads_assignments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secrets.env"
            path.write_text(
                "\n".join(
                    [
                        "# comment",
                        "",
                        "AGENT_HOST_TOKEN=first",
                        "AGENT_HOST_TOKEN=second",
                        "DISCORD_GUILD_ID=1234",
                    ]
                ),
                encoding="utf-8",
            )

            values = server_smoke_baseline.parse_env_file(path)

            self.assertEqual(values["AGENT_HOST_TOKEN"], "second")
            self.assertEqual(values["DISCORD_GUILD_ID"], "1234")

    def test_normalize_agent_host_base_url_rewrites_wildcards(self):
        self.assertEqual(
            server_smoke_baseline.normalize_agent_host_base_url("0.0.0.0", 8787),
            "http://127.0.0.1:8787",
        )
        self.assertEqual(
            server_smoke_baseline.normalize_agent_host_base_url("::", 8787),
            "http://127.0.0.1:8787",
        )

    def test_select_workspace_prefers_readonly_when_requested(self):
        workspaces = [
            {"id": "main_codex", "default_mode": "workspace-write"},
            {"id": "grokking", "default_mode": "readonly"},
        ]

        chosen = server_smoke_baseline.select_workspace(
            workspaces,
            requested_workspace=None,
            default_workspace="main_codex",
            prefer_readonly=True,
        )

        self.assertEqual(chosen["id"], "grokking")

    def test_select_workspace_honors_requested_workspace(self):
        workspaces = [
            {"id": "main_codex", "default_mode": "workspace-write"},
            {"id": "grokking", "default_mode": "readonly"},
        ]

        chosen = server_smoke_baseline.select_workspace(
            workspaces,
            requested_workspace="main_codex",
            default_workspace="grokking",
            prefer_readonly=True,
        )

        self.assertEqual(chosen["id"], "main_codex")

    def test_resolve_token_env_name_prefers_discord_config(self):
        discord_config = {"agent_host": {"token_env": "AGENT_HOST_TOKEN"}}
        agent_host_config = {
            "auth": {
                "token_env_map": {
                    "AGENT_HOST_ADMIN_TOKEN": {"user": "chenma", "role": "admin"},
                    "AGENT_HOST_USER_TOKEN": {"user": "chenma", "role": "user"},
                }
            }
        }

        env_name = server_smoke_baseline.resolve_token_env_name(discord_config, agent_host_config, None)

        self.assertEqual(env_name, "AGENT_HOST_TOKEN")

    def test_build_run_payload_uses_string_dry_run(self):
        payload = server_smoke_baseline.build_run_payload(
            workspace_id="grokking",
            mode="readonly",
            intake_id="intake_1",
            source="server_smoke_baseline",
            idempotency_key="server-smoke-1",
            metadata={"kind": "server_smoke_baseline"},
            dry_run=True,
        )

        self.assertEqual(payload["dry_run"], "true")
        self.assertEqual(payload["workspace"], "grokking")
        self.assertIn('"kind":"server_smoke_baseline"', payload["metadata"])

    def test_find_task_summary_returns_matching_item(self):
        payload = {
            "ok": True,
            "tasks": [
                {"task_id": "task_a", "status": "queued"},
                {"task_id": "task_b", "status": "done"},
            ],
        }

        item = server_smoke_baseline.find_task_summary(payload, "task_b")

        self.assertEqual(item["status"], "done")


if __name__ == "__main__":
    unittest.main()
