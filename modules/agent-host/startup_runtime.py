from __future__ import annotations

import argparse
import os
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any


def writable_directory_check(path: Path) -> tuple[bool, str]:
    if path.exists():
        if not path.is_dir():
            return False, f"not a directory: {path}"
        return os.access(path, os.W_OK | os.X_OK), str(path)
    parent = path.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    if not parent.exists():
        return False, f"missing parent for {path}"
    return os.access(parent, os.W_OK | os.X_OK), f"{path} (parent writable: {parent})"


def validate_check_config(config: Any, supported_modes: set[str] | frozenset[str]) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, ok, detail))

    add("bind host is localhost", config.host == "127.0.0.1", config.host)
    add("port configured", 0 < config.port < 65536, str(config.port))
    add("Mattermost token count", bool(config.mattermost_tokens), str(len(config.mattermost_tokens)))
    add("Codex auth token count", bool(config.auth_tokens), str(len(config.auth_tokens)))
    add("allowed users nonempty", bool(config.allowed_users), ", ".join(config.allowed_users) or "(none)")
    add("projects nonempty", bool(config.projects), str(len(config.projects)))

    for name, project in sorted(config.projects.items()):
        add(f"project {name} exists", project.root.exists() and project.root.is_dir(), str(project.root))
        add(
            f"project {name} modes",
            project.default_mode in project.allowed_modes and set(project.allowed_modes).issubset(supported_modes),
            f"default={project.default_mode} allowed={','.join(project.allowed_modes)}",
        )

    bridge_script = config.codex_bridge_root / "scripts" / "codex-bridge.js"
    add("codex-bridge script exists", bridge_script.exists(), str(bridge_script))
    state_dir = config.codex_bridge_root / ".codex-bridge" / "tasks"
    writable, detail = writable_directory_check(state_dir)
    add("codex task directory writable", writable, detail)
    add("node executable configured", bool(config.codex_bridge_node_bin), config.codex_bridge_node_bin)
    return checks


def check_config(config: Any, supported_modes: set[str] | frozenset[str]) -> int:
    failed = False
    for name, ok, detail in validate_check_config(config, supported_modes):
        status = "OK" if ok else "FAIL"
        suffix = f" - {detail}" if detail else ""
        print(f"{status} {name}{suffix}")
        failed = failed or not ok
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Mattermost -> Watchdog task bridge")
    parser.add_argument("--config", default="config.json", help="path to bridge config JSON")
    parser.add_argument("--check-config", action="store_true", help="validate config and exit")
    return parser


def serve_bridge(config: Any, handler_class: type, server_class: type[ThreadingHTTPServer] = ThreadingHTTPServer) -> int:
    handler = type("ConfiguredWatchdogBridgeHandler", (handler_class,), {"config": config})
    server = server_class((config.host, config.port), handler)
    print(f"watchdog bridge listening on http://{config.host}:{config.port}/mattermost/watchdog", flush=True)
    print(f"codex bridge web UI listening on http://{config.host}:{config.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", file=sys.stderr)
    finally:
        server.server_close()
    return 0
