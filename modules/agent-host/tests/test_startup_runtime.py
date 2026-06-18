import contextlib
import io
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

    def test_validate_check_config_flags_invalid_project_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "scripts" / "codex-bridge.js").write_text("console.log('ok')\n")
            (root / ".codex-bridge" / "tasks").mkdir(parents=True)
            config = FakeConfig(root)
            config.projects["demo"] = FakeProject(
                root,
                default_mode="workspace-write",
                allowed_modes=("workspace-write", "danger-full-access"),
            )

            checks = startup_runtime.validate_check_config(config, {"readonly", "workspace-write"})

        by_name = {name: (ok, detail) for name, ok, detail in checks}
        self.assertFalse(by_name["project demo modes"][0])
        self.assertIn("default=workspace-write", by_name["project demo modes"][1])
        self.assertIn("danger-full-access", by_name["project demo modes"][1])

    def test_build_parser_parses_check_config_flag(self):
        parser = startup_runtime.build_parser()
        args = parser.parse_args(["--config", "demo.json", "--check-config"])

        self.assertEqual(args.config, "demo.json")
        self.assertTrue(args.check_config)

    def test_serve_bridge_closes_server_on_keyboard_interrupt(self):
        events: dict[str, object] = {}

        class FakeServer:
            def __init__(self, address, handler):
                events["address"] = address
                events["handler"] = handler
                events["closed"] = False

            def serve_forever(self):
                raise KeyboardInterrupt

            def server_close(self):
                events["closed"] = True

        config = FakeConfig(Path("/tmp/demo"))
        stdout = io.StringIO()
        stderr = io.StringIO()

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = startup_runtime.serve_bridge(config, object, server_class=FakeServer)

        self.assertEqual(result, 0)
        self.assertEqual(events["address"], ("127.0.0.1", 8787))
        self.assertTrue(events["closed"])
        self.assertIn("watchdog bridge listening on http://127.0.0.1:8787/mattermost/watchdog", stdout.getvalue())
        self.assertIn("codex bridge web UI listening on http://127.0.0.1:8787/", stdout.getvalue())
        self.assertIn("shutting down", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
