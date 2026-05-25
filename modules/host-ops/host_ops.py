#!/usr/bin/env python3
"""Read-only host operations for the local Agent Host.

This CLI is intentionally narrow. It is a sensor layer, not a general shell.
All operations are allowlisted, bounded, and returned as JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
HOME = Path.home()
APP_ROOT = HOME / "Documents" / "My_App_Dev"
DEFAULT_CONFIG = {
    "systemd_user_units": [
        "agent-host-web.service",
        "discord-agent-adapter.service",
    ],
    "journal_units": [
        "agent-host-web.service",
        "discord-agent-adapter.service",
    ],
    "path_aliases": {
        "my_ai_agent": str(HOME / "Documents" / "My_AI_Agent"),
        "my_app_dev": str(APP_ROOT),
    },
    "git_workspaces": {
        "codex-bridge": str(APP_ROOT / "local-ai-agent-control-plane" / "modules" / "codex-bridge"),
        "agent-host": str(APP_ROOT / "local-ai-agent-control-plane" / "modules" / "agent-host"),
        "discord-adapter": str(APP_ROOT / "local-ai-agent-control-plane" / "modules" / "discord-adapter"),
        "codex-watchdog-vscode": str(APP_ROOT / "local-ai-agent-control-plane" / "modules" / "codex-watchdog-vscode"),
        "host-ops": str(APP_ROOT / "local-ai-agent-control-plane" / "modules" / "host-ops"),
    },
    "max_journal_lines": 200,
    "max_output_chars": 20000,
    "command_timeout_seconds": 10,
}


PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.DOTALL,
)
ENV_SECRET_RE = re.compile(
    r"(?im)^([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|PRIVATE)[A-Z0-9_]*)\s*=\s*.+$"
)
DISCORD_TOKEN_RE = re.compile(
    r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b"
)


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def default_config_path() -> Path | None:
    config_json = ROOT / "host_ops.config.json"
    if config_json.exists():
        return config_json
    example_json = ROOT / "host_ops.config.example.json"
    if example_json.exists():
        return example_json
    return None


def load_config(path: str | None) -> dict[str, Any]:
    config_path = Path(path).expanduser() if path else default_config_path()
    if not config_path:
        return dict(DEFAULT_CONFIG)
    with config_path.open("r", encoding="utf-8") as handle:
        loaded = json.load(handle)
    return deep_merge(DEFAULT_CONFIG, loaded)


def max_chars(config: dict[str, Any]) -> int:
    return max(1000, int(config.get("max_output_chars", 20000)))


def truncate_text(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    suffix = "\n[truncated]"
    return text[: max(0, limit - len(suffix))] + suffix, True


def configured_paths(config: dict[str, Any]) -> list[tuple[str, str]]:
    replacements: list[tuple[str, str]] = []
    for alias, path in config.get("path_aliases", {}).items():
        replacements.append((str(path), f"[path:{alias}]"))
    for alias, path in config.get("git_workspaces", {}).items():
        replacements.append((str(path), f"[workspace:{alias}]"))
    home = str(Path.home())
    replacements.append((home, "~"))
    return sorted(replacements, key=lambda item: len(item[0]), reverse=True)


def sanitize_text(text: str, config: dict[str, Any]) -> str:
    sanitized = text
    sanitized = PRIVATE_KEY_RE.sub("[REDACTED_PRIVATE_KEY]", sanitized)
    sanitized = ENV_SECRET_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", sanitized)
    sanitized = re.sub(
        r"(?i)Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+",
        "Authorization: Bearer [REDACTED]",
        sanitized,
    )
    sanitized = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", sanitized)
    sanitized = re.sub(r"\bsk-[A-Za-z0-9_-]{10,}\b", "[REDACTED_OPENAI_KEY]", sanitized)
    sanitized = re.sub(r"\bghp_[A-Za-z0-9_]{10,}\b", "[REDACTED_GITHUB_TOKEN]", sanitized)
    sanitized = re.sub(r"\bgithub_pat_[A-Za-z0-9_]+", "[REDACTED_GITHUB_TOKEN]", sanitized)
    sanitized = DISCORD_TOKEN_RE.sub("[REDACTED_DISCORD_TOKEN]", sanitized)
    for path, replacement in configured_paths(config):
        if path:
            sanitized = sanitized.replace(path, replacement)
    return sanitized


def json_result(payload: dict[str, Any], exit_code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


def error(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
        },
    }


def run_command(args: list[str], config: dict[str, Any]) -> dict[str, Any]:
    timeout = int(config.get("command_timeout_seconds", 10))
    try:
        completed = subprocess.run(
            args,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": str(exc),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "returncode": 124,
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or f"command timed out after {timeout}s",
            "timed_out": True,
        }
    return {
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "timed_out": False,
    }


def allowed(value: str, items: list[str]) -> bool:
    return value in set(items)


def parse_systemctl_show(text: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            parsed[key] = value
    return parsed


def command_capabilities(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "commands": [
            "capabilities",
            "systemd-user-status",
            "systemd-user-list-timers",
            "journal-tail",
            "disk-usage",
            "git-status",
        ],
        "systemd_user_units": list(config.get("systemd_user_units", [])),
        "journal_units": list(config.get("journal_units", [])),
        "path_aliases": sorted(config.get("path_aliases", {}).keys()),
        "git_workspaces": sorted(config.get("git_workspaces", {}).keys()),
        "read_only": True,
        "arbitrary_shell": False,
    }


def command_systemd_user_status(config: dict[str, Any], unit: str) -> dict[str, Any]:
    if not allowed(unit, list(config.get("systemd_user_units", []))):
        return error("unit_not_allowed", "Unit is not in the Host Ops allowlist.", {"unit": unit})
    result = run_command(
        [
            "systemctl",
            "--user",
            "show",
            unit,
            "--property=Id,LoadState,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp",
            "--no-pager",
        ],
        config,
    )
    stdout = sanitize_text(result["stdout"], config)
    stderr = sanitize_text(result["stderr"], config)
    parsed = parse_systemctl_show(stdout)
    ok = result["returncode"] == 0
    return {
        "ok": ok,
        "command": "systemd-user-status",
        "unit": unit,
        "active": parsed.get("ActiveState") == "active",
        "properties": parsed,
        "returncode": result["returncode"],
        "stderr": stderr,
        "timed_out": result["timed_out"],
    }


def command_systemd_user_list_timers(config: dict[str, Any]) -> dict[str, Any]:
    result = run_command(
        ["systemctl", "--user", "list-timers", "--all", "--no-pager", "--plain"],
        config,
    )
    text = sanitize_text(result["stdout"] + result["stderr"], config)
    text, truncated = truncate_text(text, max_chars(config))
    return {
        "ok": result["returncode"] == 0,
        "command": "systemd-user-list-timers",
        "text": text,
        "returncode": result["returncode"],
        "truncated": truncated,
        "timed_out": result["timed_out"],
    }


def command_journal_tail(config: dict[str, Any], unit: str, lines: int) -> dict[str, Any]:
    if not allowed(unit, list(config.get("journal_units", []))):
        return error("unit_not_allowed", "Unit is not in the journal allowlist.", {"unit": unit})
    max_lines = max(1, int(config.get("max_journal_lines", 200)))
    requested_lines = max(1, min(lines, max_lines))
    result = run_command(
        [
            "journalctl",
            "--user",
            "-u",
            unit,
            "-n",
            str(requested_lines),
            "--no-pager",
            "--output=short-iso",
        ],
        config,
    )
    text = sanitize_text(result["stdout"] + result["stderr"], config)
    text, truncated_by_chars = truncate_text(text, max_chars(config))
    return {
        "ok": result["returncode"] == 0,
        "command": "journal-tail",
        "unit": unit,
        "lines_requested": lines,
        "lines_returned": len(text.splitlines()) if text else 0,
        "redacted": True,
        "truncated": lines > requested_lines or truncated_by_chars,
        "text": text,
        "returncode": result["returncode"],
        "timed_out": result["timed_out"],
    }


def command_disk_usage(config: dict[str, Any], alias: str) -> dict[str, Any]:
    aliases = config.get("path_aliases", {})
    if alias not in aliases:
        return error("path_alias_not_allowed", "Path alias is not in the Host Ops allowlist.", {"alias": alias})
    path = Path(str(aliases[alias])).expanduser()
    if not path.exists():
        return error("path_not_found", "Allowlisted path does not exist.", {"alias": alias})
    usage = shutil.disk_usage(path)
    return {
        "ok": True,
        "command": "disk-usage",
        "path_alias": alias,
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "percent_used": round((usage.used / usage.total) * 100, 2) if usage.total else None,
    }


def command_git_status(config: dict[str, Any], workspace: str) -> dict[str, Any]:
    workspaces = config.get("git_workspaces", {})
    if workspace not in workspaces:
        return error(
            "git_workspace_not_allowed",
            "Git workspace is not in the Host Ops allowlist.",
            {"workspace": workspace},
        )
    path = Path(str(workspaces[workspace])).expanduser()
    if not path.exists():
        return error("workspace_not_found", "Allowlisted git workspace does not exist.", {"workspace": workspace})
    result = run_command(["git", "-C", str(path), "status", "--short", "--branch"], config)
    text = sanitize_text(result["stdout"] + result["stderr"], config)
    text, truncated = truncate_text(text, max_chars(config))
    return {
        "ok": result["returncode"] == 0,
        "command": "git-status",
        "workspace": workspace,
        "redacted": True,
        "truncated": truncated,
        "text": text,
        "returncode": result["returncode"],
        "timed_out": result["timed_out"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only Host Ops allowlist CLI.")
    parser.add_argument("--config", help="Path to host_ops config JSON.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("capabilities")

    status_parser = subparsers.add_parser("systemd-user-status")
    status_parser.add_argument("unit")

    subparsers.add_parser("systemd-user-list-timers")

    journal_parser = subparsers.add_parser("journal-tail")
    journal_parser.add_argument("unit")
    journal_parser.add_argument("--lines", type=int, default=80)

    disk_parser = subparsers.add_parser("disk-usage")
    disk_parser.add_argument("alias")

    git_parser = subparsers.add_parser("git-status")
    git_parser.add_argument("workspace")

    return parser


def dispatch(args: argparse.Namespace, config: dict[str, Any]) -> dict[str, Any]:
    if args.command == "capabilities":
        return command_capabilities(config)
    if args.command == "systemd-user-status":
        return command_systemd_user_status(config, args.unit)
    if args.command == "systemd-user-list-timers":
        return command_systemd_user_list_timers(config)
    if args.command == "journal-tail":
        return command_journal_tail(config, args.unit, args.lines)
    if args.command == "disk-usage":
        return command_disk_usage(config, args.alias)
    if args.command == "git-status":
        return command_git_status(config, args.workspace)
    return error("invalid_command", "Unsupported command.", {"command": args.command})


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        payload = dispatch(args, config)
    except Exception as exc:  # Keep CLI failures structured and secret-light.
        payload = error("internal_error", str(exc))
    return json_result(payload, 0 if payload.get("ok") else 1)


if __name__ == "__main__":
    raise SystemExit(main())
