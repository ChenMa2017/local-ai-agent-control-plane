import json
import re
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from agent_host.bridge import config_loader


@dataclass(frozen=True)
class FakeProject:
    name: str
    root: Path
    label: str = ""
    description: str = ""
    default_mode: str = "readonly"
    allowed_modes: tuple[str, ...] = ("readonly",)


@dataclass(frozen=True)
class FakePrincipal:
    user: str
    role: str


@dataclass(frozen=True)
class FakeConfig:
    host: str
    port: int
    mattermost_tokens: tuple[str, ...]
    allowed_users: tuple[str, ...]
    projects: dict[str, FakeProject]
    codex_bridge_root: Path
    codex_bridge_node_bin: str
    auth_tokens: dict[str, FakePrincipal]


class FakeBridgeError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class ConfigLoaderTests(unittest.TestCase):
    def error_factory(self, message: str, status: int) -> FakeBridgeError:
        return FakeBridgeError(message, status)

    def test_load_auth_tokens_parses_principals(self):
        tokens = config_loader.load_auth_tokens(
            {
                "auth": {
                    "tokens": {
                        "token-1": {"user": "chenma", "role": "admin"},
                        "token-2": {"user": "alice"},
                    }
                }
            },
            auth_principal_factory=FakePrincipal,
            error_factory=self.error_factory,
        )

        self.assertEqual(tokens["token-1"].role, "admin")
        self.assertEqual(tokens["token-2"].role, "user")

    def test_resolve_project_mapping_rejects_unsupported_mode(self):
        with self.assertRaises(FakeBridgeError) as ctx:
            config_loader.resolve_project_mapping(
                {
                    "demo": {
                        "path": "/tmp/demo",
                        "default_mode": "unsafe",
                        "allowed_modes": ["unsafe"],
                    }
                },
                project_name_re=re.compile(r"^[A-Za-z0-9_.-]{1,64}$"),
                supported_modes={"readonly", "workspace-write"},
                project_factory=FakeProject,
                error_factory=self.error_factory,
            )

        self.assertIn("unsupported default_mode", str(ctx.exception))
        self.assertEqual(ctx.exception.status, 500)

    def test_load_config_builds_projects_and_auth_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "127.0.0.1",
                        "port": 8787,
                        "mattermost_tokens": ["mm-1"],
                        "allowed_users": ["chenma"],
                        "codex_bridge_root": str(root / "codex-bridge"),
                        "codex_bridge_node_bin": "node",
                        "projects": {
                            "demo": {
                                "path": str(root),
                                "label": "Demo",
                                "description": "project",
                                "default_mode": "readonly",
                                "allowed_modes": ["readonly"],
                            }
                        },
                        "auth": {
                            "tokens": {
                                "bearer-1": {"user": "chenma", "role": "admin"}
                            }
                        },
                    },
                    ensure_ascii=False,
                )
            )

            config = config_loader.load_config(
                config_path,
                default_codex_bridge_root=root / "codex-bridge-default",
                project_name_re=re.compile(r"^[A-Za-z0-9_.-]{1,64}$"),
                supported_modes={"readonly", "workspace-write"},
                project_factory=FakeProject,
                bridge_config_factory=FakeConfig,
                auth_principal_factory=FakePrincipal,
                error_factory=self.error_factory,
            )

        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.projects["demo"].label, "Demo")
        self.assertEqual(config.auth_tokens["bearer-1"].user, "chenma")


if __name__ == "__main__":
    unittest.main()
