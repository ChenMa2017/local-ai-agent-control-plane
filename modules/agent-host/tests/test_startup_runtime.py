import tempfile
import unittest
from pathlib import Path

import startup_runtime


class FakeProject:
    def __init__(self, root: Path, default_mode: str = "readonly", allowed_modes: tuple[str, ...] = ("readonly",)):
        self.root = root
        self.default_mode = default_mode
        self.allowed_modes = allowed_modes


class FakeConfig:
    def __init__(self, root: Path):
        self.host = "127.0.0.1"
        self.port = 8787
        self.mattermost_tokens = ("token-1",)
        self.allowed_users = ("chenma",)
        self.projects = {"demo": FakeProject(root)}
        self.codex_bridge_root = root
        self.codex_bridge_node_bin = "node"
        self.auth_tokens = {"bearer-1": object()}


class StartupRuntimeTests(unittest.TestCase):
    def test_writable_directory_check_rejects_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "not_a_directory"
            path.write_text("x")

            ok, detail = startup_runtime.writable_directory_check(path)

        self.assertFalse(ok)
        self.assertIn("not a directory", detail)

    def test_validate_check_config_returns_expected_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "scripts" / "codex-bridge.js").write_text("console.log('ok')\n")
            (root / ".codex-bridge" / "tasks").mkdir(parents=True)
            config = FakeConfig(root)

            checks = startup_runtime.validate_check_config(config, {"readonly", "workspace-write"})

        names = [name for name, _ok, _detail in checks]
        self.assertIn("bind host is localhost", names)
        self.assertIn("project demo exists", names)
        self.assertIn("project demo modes", names)
        self.assertIn("codex-bridge script exists", names)
        self.assertIn("codex task directory writable", names)

    def test_build_parser_parses_check_config_flag(self):
        parser = startup_runtime.build_parser()
        args = parser.parse_args(["--config", "demo.json", "--check-config"])

        self.assertEqual(args.config, "demo.json")
        self.assertTrue(args.check_config)


if __name__ == "__main__":
    unittest.main()
