import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "control_plane.py"
SPEC = importlib.util.spec_from_file_location("control_plane", SCRIPT)
control_plane = importlib.util.module_from_spec(SPEC)
sys.modules["control_plane"] = control_plane
SPEC.loader.exec_module(control_plane)


class ControlPlaneTests(unittest.TestCase):
    def write_json(self, directory, name, data):
        path = Path(directory) / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def valid_agent_host(self, project_path):
        return {
            "host": "127.0.0.1",
            "port": 8787,
            "allowed_users": ["chenma"],
            "auth": {
                "token_env_map": {
                    "AGENT_HOST_ADMIN_TOKEN": {"user": "chenma", "role": "admin"},
                    "AGENT_HOST_TOKEN": {"user": "chenma", "role": "user"},
                }
            },
            "codex_bridge_root": str(project_path),
            "codex_bridge_node_bin": "node",
            "projects": {
                "main_codex": {
                    "path": str(project_path),
                    "label": "main codex",
                    "default_mode": "workspace-write",
                    "allowed_modes": ["workspace-write"],
                }
            },
        }

    def valid_discord(self):
        return {
            "agent_host": {
                "base_url": "http://127.0.0.1:8787",
                "token_env": "AGENT_HOST_TOKEN",
                "timeout_seconds": 30,
            },
            "discord": {
                "bot_token_env": "DISCORD_BOT_TOKEN",
                "guild_id_env": "DISCORD_GUILD_ID",
                "allowed_guild_ids": ["123456789012345678"],
                "allowed_channel_ids": ["123456789012345679"],
                "command_prefix": "agent",
                "users": {
                    "123456789012345680": {"internal_user": "chenma", "role": "admin"},
                },
            },
        }

    def valid_host_ops(self, project_path):
        return {
            "systemd_user_units": ["agent-host-web.service"],
            "journal_units": ["agent-host-web.service"],
            "path_aliases": {"main": str(project_path)},
        }

    def args(self, agent_host, discord, host_ops, secrets, strict=False):
        return Namespace(
            agent_host_config=str(agent_host),
            discord_config=str(discord),
            host_ops_config=str(host_ops),
            secrets_env=str(secrets),
            strict=strict,
        )

    def test_config_validation_redacts_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent_host = self.write_json(root, "agent.json", self.valid_agent_host(root))
            discord = self.write_json(root, "discord.json", self.valid_discord())
            host_ops = self.write_json(root, "host_ops.json", self.valid_host_ops(root))
            secrets = root / "secrets.env"
            secrets.write_text(
                "\n".join(
                    [
                        "DISCORD_BOT_TOKEN=demo",
                        "DISCORD_GUILD_ID=123456789012345678",
                        "AGENT_HOST_TOKEN=demo",
                        "AGENT_HOST_ADMIN_TOKEN=demo-admin",
                    ]
                ),
                encoding="utf-8",
            )
            secrets.chmod(stat.S_IRUSR | stat.S_IWUSR)

            report = control_plane.report_for_config(self.args(agent_host, discord, host_ops, secrets, strict=True))
            text = json.dumps(report, ensure_ascii=False)

            self.assertTrue(report["ok"])
            self.assertNotIn("DISCORD_BOT_TOKEN=demo", text)
            self.assertNotIn("AGENT_HOST_TOKEN=demo", text)
            self.assertIn("AGENT_HOST_ADMIN_TOKEN", text)

    def test_config_validation_rejects_invalid_default_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.valid_agent_host(root)
            config["projects"]["main_codex"]["default_mode"] = "workspace-write"
            config["projects"]["main_codex"]["allowed_modes"] = ["readonly"]
            agent_host = self.write_json(root, "agent.json", config)
            discord = self.write_json(root, "discord.json", self.valid_discord())
            host_ops = self.write_json(root, "host_ops.json", self.valid_host_ops(root))
            secrets = root / "secrets.env"
            secrets.write_text(
                "DISCORD_BOT_TOKEN=x\nDISCORD_GUILD_ID=y\nAGENT_HOST_TOKEN=z\nAGENT_HOST_ADMIN_TOKEN=q\n",
                encoding="utf-8",
            )
            secrets.chmod(stat.S_IRUSR | stat.S_IWUSR)

            report = control_plane.report_for_config(self.args(agent_host, discord, host_ops, secrets, strict=True))
            codes = {item["code"] for item in report["findings"]}

            self.assertFalse(report["ok"])
            self.assertIn("agent_host_project_default_mode_not_allowed", codes)

    def test_migration_check_is_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "codex-bridge").mkdir()
            args = Namespace(old_root=str(root), dry_run=True)

            report = control_plane.report_for_migration(args)

            self.assertTrue(report["ok"])
            self.assertTrue(report["dry_run"])
            self.assertIn("old_installs", report)

    def test_config_validation_accepts_legacy_inline_auth_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self.valid_agent_host(root)
            config["auth"] = {
                "tokens": {
                    "legacy-token": {"user": "chenma", "role": "admin"},
                }
            }
            agent_host = self.write_json(root, "agent.json", config)
            discord = self.write_json(root, "discord.json", self.valid_discord())
            host_ops = self.write_json(root, "host_ops.json", self.valid_host_ops(root))
            secrets = root / "secrets.env"
            secrets.write_text("DISCORD_BOT_TOKEN=x\nDISCORD_GUILD_ID=y\nAGENT_HOST_TOKEN=z\n", encoding="utf-8")
            secrets.chmod(stat.S_IRUSR | stat.S_IWUSR)

            report = control_plane.report_for_config(self.args(agent_host, discord, host_ops, secrets, strict=True))
            codes = {item["code"] for item in report["findings"]}

            self.assertTrue(report["ok"])
            self.assertIn("agent_host_inline_auth_tokens_present", codes)

    def test_rollback_is_plan_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = Namespace(old_root=tmp, dry_run=True)

            report = control_plane.report_for_rollback(args)
            codes = {item["code"] for item in report["findings"]}

            self.assertTrue(report["ok"])
            self.assertIn("rollback_plan_only", codes)
            self.assertIn("Do not delete new state, logs, tasks, or configs during rollback.", report["plan"])


if __name__ == "__main__":
    unittest.main()
