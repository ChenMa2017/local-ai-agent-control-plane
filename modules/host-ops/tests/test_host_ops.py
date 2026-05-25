import json
import tempfile
import unittest
from pathlib import Path

import host_ops


class HostOpsTest(unittest.TestCase):
    def make_config(self):
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)
        root = Path(tempdir.name)
        workspace = root / "workspace"
        workspace.mkdir()
        return {
            "systemd_user_units": ["agent-host-web.service"],
            "journal_units": ["agent-host-web.service"],
            "path_aliases": {"tmp_root": str(root)},
            "git_workspaces": {"tmp_workspace": str(workspace)},
            "max_journal_lines": 5,
            "max_output_chars": 1000,
            "command_timeout_seconds": 5,
        }

    def test_capabilities_do_not_expose_paths(self):
        config = self.make_config()
        payload = host_ops.command_capabilities(config)
        text = json.dumps(payload)
        self.assertTrue(payload["ok"])
        self.assertIn("tmp_root", payload["path_aliases"])
        self.assertNotIn(config["path_aliases"]["tmp_root"], text)

    def test_sanitize_redacts_paths_and_secrets(self):
        config = self.make_config()
        raw = "\n".join(
            [
                f"path={config['path_aliases']['tmp_root']}/file.txt",
                "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
                "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
                "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz",
                "DISCORD_TOKEN=AAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCC",
                "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
            ]
        )
        sanitized = host_ops.sanitize_text(raw, config)
        self.assertIn("[path:tmp_root]", sanitized)
        self.assertNotIn(str(Path.home()), sanitized)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", sanitized)
        self.assertIn("[REDACTED_PRIVATE_KEY]", sanitized)

    def test_unknown_unit_is_rejected(self):
        config = self.make_config()
        payload = host_ops.command_systemd_user_status(config, "not-allowed.service")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "unit_not_allowed")

    def test_unknown_path_alias_is_rejected(self):
        config = self.make_config()
        payload = host_ops.command_disk_usage(config, "unknown")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "path_alias_not_allowed")

    def test_disk_usage_uses_alias_only(self):
        config = self.make_config()
        payload = host_ops.command_disk_usage(config, "tmp_root")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["path_alias"], "tmp_root")
        self.assertIn("free_bytes", payload)

    def test_git_workspace_allowlist(self):
        config = self.make_config()
        payload = host_ops.command_git_status(config, "unknown")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "git_workspace_not_allowed")

    def test_truncate_text_marks_truncated(self):
        text, truncated = host_ops.truncate_text("abcdef", 5)
        self.assertTrue(truncated)
        self.assertTrue(text.endswith("[truncated]"))


if __name__ == "__main__":
    unittest.main()
