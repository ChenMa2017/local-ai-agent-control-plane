#!/usr/bin/env python3
"""Read-only operational safety checks for the local AI-Agent control plane."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_AGENT_HOST_CONFIG = ROOT / "modules" / "agent-host" / "config.example.json"
DEFAULT_DISCORD_CONFIG = ROOT / "modules" / "discord-adapter" / "config.example.json"
DEFAULT_HOST_OPS_CONFIG = ROOT / "modules" / "host-ops" / "host_ops.config.example.json"
DEFAULT_SECRETS_ENV = Path.home() / ".config" / "agent-host" / "secrets.env"
DEFAULT_OLD_ROOT = Path.home() / "Documents" / "My_App_Dev"

SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
SAFE_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
TOKEN_LIKE_RE = re.compile(
    r"(?i)(discord[_-]?bot[_-]?token|agent[_-]?host[_-]?token|authorization:\s*bearer\s+|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,})"
)
SECRET_ENV_RE = re.compile(r"(?i)^(?:[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PRIVATE)[A-Z0-9_]*)=.*$")


@dataclass
class Finding:
    level: str
    code: str
    message: str
    details: dict[str, Any] | None = None


def finding(level: str, code: str, message: str, **details: Any) -> Finding:
    return Finding(level=level, code=code, message=message, details=details or None)


def load_json(path: Path, findings: list[Finding], label: str) -> dict[str, Any] | None:
    if not path.exists():
        findings.append(finding("error", f"{label}_missing", f"{label} config file is missing.", path=str(path)))
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        findings.append(
            finding(
                "error",
                f"{label}_invalid_json",
                f"{label} config is not valid JSON.",
                path=str(path),
                line=exc.lineno,
                column=exc.colno,
            )
        )
        return None


def redact_scalar(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    if SECRET_ENV_RE.match(value):
        key = value.split("=", 1)[0]
        return f"{key}=[REDACTED]"
    redacted = re.sub(r"Authorization:\s*Bearer\s+\S+", "Authorization: Bearer [REDACTED]", value, flags=re.I)
    redacted = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[REDACTED_OPENAI_KEY]", redacted)
    redacted = re.sub(r"ghp_[A-Za-z0-9_]{12,}", "[REDACTED_GITHUB_TOKEN]", redacted)
    redacted = re.sub(r"MT[A-Za-z0-9_.-]{20,}", "[REDACTED_DISCORD_TOKEN]", redacted)
    return redacted


def redact_config(obj: Any) -> Any:
    if isinstance(obj, dict):
        redacted: dict[str, Any] = {}
        for key, value in obj.items():
            key_lower = str(key).lower()
            if key_lower.endswith("_env"):
                redacted[key] = redact_config(value)
            elif key_lower.endswith("_env_map") and isinstance(value, dict):
                redacted[key] = {str(env_name): redact_config(principal) for env_name, principal in value.items()}
            elif any(word in key_lower for word in ("token", "secret", "password", "private_key")):
                if isinstance(value, dict):
                    redacted[key] = {shape_only(k): "[REDACTED]" for k in value.keys()}
                elif isinstance(value, list):
                    redacted[key] = [shape_only(v) for v in value]
                elif value:
                    redacted[key] = shape_only(value)
                else:
                    redacted[key] = value
            else:
                redacted[key] = redact_config(value)
        return redacted
    if isinstance(obj, list):
        return [redact_config(item) for item in obj]
    return redact_scalar(obj)


def shape_only(value: Any) -> str:
    text = str(value)
    if not text:
        return ""
    return f"[REDACTED len={len(text)} prefix={text[:3]!r}]"


def path_has_placeholder(path: str) -> bool:
    return "/home/you/" in path or "replace-with-" in path


def collect_required_secret_keys(agent_host: dict[str, Any] | None, discord: dict[str, Any] | None) -> list[str]:
    keys: list[str] = []

    def add(value: Any) -> None:
        text = str(value or "").strip()
        if text and text not in keys:
            keys.append(text)

    if isinstance(agent_host, dict):
        auth = agent_host.get("auth")
        if isinstance(auth, dict):
            env_map = auth.get("token_env_map")
            if isinstance(env_map, dict):
                for env_name in env_map.keys():
                    add(env_name)

    if isinstance(discord, dict):
        agent_host_section = discord.get("agent_host")
        if isinstance(agent_host_section, dict):
            add(agent_host_section.get("token_env"))
        discord_section = discord.get("discord")
        if isinstance(discord_section, dict):
            add(discord_section.get("bot_token_env"))
            add(discord_section.get("guild_id_env"))

    return keys


def validate_agent_host(config: dict[str, Any], findings: list[Finding], strict: bool) -> None:
    host = config.get("host")
    if host not in ("127.0.0.1", "localhost"):
        level = "error" if strict else "warning"
        findings.append(finding(level, "agent_host_bind_not_localhost", "Agent Host should bind only to localhost.", host=host))

    port = config.get("port")
    if not isinstance(port, int) or not (1 <= port <= 65535):
        findings.append(finding("error", "agent_host_invalid_port", "Agent Host port must be an integer between 1 and 65535.", port=port))

    allowed_users = config.get("allowed_users")
    if not isinstance(allowed_users, list) or not allowed_users:
        findings.append(finding("error", "agent_host_allowed_users_empty", "allowed_users must be a nonempty list."))

    auth = config.get("auth")
    if not isinstance(auth, dict):
        findings.append(finding("error", "agent_host_auth_invalid", "auth must be an object."))
    else:
        tokens = auth.get("tokens")
        token_env_map = auth.get("token_env_map")
        has_inline_tokens = isinstance(tokens, dict) and bool(tokens)
        has_env_tokens = isinstance(token_env_map, dict) and bool(token_env_map)
        if not has_inline_tokens and not has_env_tokens:
            findings.append(
                finding(
                    "error",
                    "agent_host_auth_token_source_empty",
                    "auth.tokens or auth.token_env_map must be a nonempty object.",
                )
            )
        if has_inline_tokens and any(str(token).startswith("replace-with-") for token in tokens):
            findings.append(finding("warning", "agent_host_placeholder_token", "auth.tokens contains placeholder token values."))
        if has_inline_tokens:
            findings.append(
                finding(
                    "warning",
                    "agent_host_inline_auth_tokens_present",
                    "Inline auth.tokens are supported for compatibility, but auth.token_env_map plus secrets.env is preferred.",
                )
            )
        if token_env_map is not None and not isinstance(token_env_map, dict):
            findings.append(finding("error", "agent_host_auth_token_env_map_invalid", "auth.token_env_map must be an object."))
        elif isinstance(token_env_map, dict):
            for env_name, principal in token_env_map.items():
                if not SAFE_ENV_NAME_RE.match(str(env_name)):
                    findings.append(
                        finding(
                            "error",
                            "agent_host_auth_token_env_name_invalid",
                            "auth.token_env_map keys must be safe environment variable names.",
                            env_name=env_name,
                        )
                    )
                if not isinstance(principal, dict):
                    findings.append(
                        finding(
                            "error",
                            "agent_host_auth_token_env_principal_invalid",
                            "auth.token_env_map values must be objects.",
                            env_name=env_name,
                        )
                    )
                    continue
                if not str(principal.get("user", "")).strip():
                    findings.append(
                        finding(
                            "error",
                            "agent_host_auth_token_env_user_missing",
                            "auth.token_env_map entries must define user.",
                            env_name=env_name,
                        )
                    )

    bridge_root = config.get("codex_bridge_root")
    if not isinstance(bridge_root, str) or not bridge_root:
        findings.append(finding("error", "agent_host_bridge_root_missing", "codex_bridge_root is required."))
    elif path_has_placeholder(bridge_root):
        findings.append(finding("warning", "agent_host_bridge_root_placeholder", "codex_bridge_root contains a placeholder path.", path=bridge_root))
    elif not Path(bridge_root).exists():
        level = "error" if strict else "warning"
        findings.append(finding(level, "agent_host_bridge_root_missing_path", "codex_bridge_root does not exist.", path=bridge_root))

    projects = config.get("projects")
    if not isinstance(projects, dict) or not projects:
        findings.append(finding("error", "agent_host_projects_empty", "projects must be a nonempty object."))
        return

    for name, project in projects.items():
        if not SAFE_NAME_RE.match(str(name)):
            findings.append(finding("error", "agent_host_project_name_unsafe", "Project alias must be a safe name.", project=name))
        if not isinstance(project, dict):
            findings.append(finding("error", "agent_host_project_invalid", "Project entry must be an object.", project=name))
            continue
        path = project.get("path")
        if not isinstance(path, str) or not path:
            findings.append(finding("error", "agent_host_project_path_missing", "Project path is required.", project=name))
        elif path_has_placeholder(path):
            findings.append(finding("warning", "agent_host_project_path_placeholder", "Project path contains a placeholder.", project=name, path=path))
        elif not Path(path).exists():
            level = "error" if strict else "warning"
            findings.append(finding(level, "agent_host_project_path_missing_path", "Project path does not exist.", project=name, path=path))
        allowed_modes = project.get("allowed_modes")
        default_mode = project.get("default_mode")
        if not isinstance(allowed_modes, list) or not allowed_modes:
            findings.append(finding("error", "agent_host_project_allowed_modes_empty", "allowed_modes must be nonempty.", project=name))
        elif default_mode not in allowed_modes:
            findings.append(
                finding(
                    "error",
                    "agent_host_project_default_mode_not_allowed",
                    "default_mode must be included in allowed_modes.",
                    project=name,
                    default_mode=default_mode,
                    allowed_modes=allowed_modes,
                )
            )


def validate_discord(config: dict[str, Any], findings: list[Finding]) -> None:
    agent_host = config.get("agent_host")
    if not isinstance(agent_host, dict):
        findings.append(finding("error", "discord_agent_host_missing", "agent_host section is required."))
    else:
        base_url = agent_host.get("base_url")
        if not isinstance(base_url, str) or not base_url.startswith("http://127.0.0.1"):
            findings.append(finding("warning", "discord_agent_host_base_url_not_localhost", "Agent Host base_url should usually be localhost.", base_url=base_url))
        if not agent_host.get("token_env"):
            findings.append(finding("error", "discord_agent_host_token_env_missing", "agent_host.token_env is required."))

    discord = config.get("discord")
    if not isinstance(discord, dict):
        findings.append(finding("error", "discord_section_missing", "discord section is required."))
        return
    for field in ("bot_token_env", "guild_id_env"):
        if not discord.get(field):
            findings.append(finding("error", f"discord_{field}_missing", f"discord.{field} is required."))
    for field in ("allowed_guild_ids", "allowed_channel_ids"):
        values = discord.get(field)
        if not isinstance(values, list) or not values:
            findings.append(finding("warning", f"discord_{field}_empty", f"discord.{field} should be nonempty for real deployments."))
    users = discord.get("users")
    if not isinstance(users, dict) or not users:
        findings.append(finding("warning", "discord_users_empty", "discord.users should map Discord users to internal users."))
    prefix = discord.get("command_prefix")
    if not isinstance(prefix, str) or not SAFE_NAME_RE.match(prefix):
        findings.append(finding("error", "discord_command_prefix_invalid", "discord.command_prefix must be a safe nonempty prefix.", command_prefix=prefix))


def validate_host_ops(config: dict[str, Any], findings: list[Finding]) -> None:
    for section in ("systemd_user_units", "journal_units"):
        values = config.get(section)
        if not isinstance(values, list):
            findings.append(finding("error", f"host_ops_{section}_invalid", f"{section} must be a list."))
        elif any("/" in str(unit) or not str(unit).endswith(".service") for unit in values):
            findings.append(finding("error", f"host_ops_{section}_unsafe", f"{section} must contain service unit names only."))
    path_aliases = config.get("path_aliases")
    if not isinstance(path_aliases, dict) or not path_aliases:
        findings.append(finding("warning", "host_ops_path_aliases_empty", "path_aliases should be nonempty."))
    elif any(path_has_placeholder(str(path)) for path in path_aliases.values()):
        findings.append(finding("warning", "host_ops_path_alias_placeholder", "path_aliases contains placeholder paths."))


def validate_secrets(path: Path, findings: list[Finding], required_keys: list[str] | None = None) -> None:
    if not path.exists():
        findings.append(finding("warning", "secrets_env_missing", "secrets.env was not found.", path=str(path)))
        return
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        findings.append(finding("error", "secrets_env_permissions_too_open", "secrets.env should be chmod 600.", path=str(path), mode=oct(mode)))
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    keys = [line.split("=", 1)[0] for line in lines if line and not line.lstrip().startswith("#") and "=" in line]
    expected = required_keys or ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "AGENT_HOST_TOKEN"]
    for required in expected:
        if required not in keys:
            findings.append(finding("warning", "secrets_env_key_missing", "Expected key missing from secrets.env.", key=required))


def report_for_config(args: argparse.Namespace) -> dict[str, Any]:
    findings: list[Finding] = []
    agent_host = load_json(Path(args.agent_host_config), findings, "agent_host")
    discord = load_json(Path(args.discord_config), findings, "discord_adapter")
    host_ops = load_json(Path(args.host_ops_config), findings, "host_ops")
    if agent_host is not None:
        validate_agent_host(agent_host, findings, strict=args.strict)
    if discord is not None:
        validate_discord(discord, findings)
    if host_ops is not None:
        validate_host_ops(host_ops, findings)
    validate_secrets(
        Path(args.secrets_env),
        findings,
        required_keys=collect_required_secret_keys(agent_host, discord),
    )
    return build_report("config_validation", findings, configs={"agent_host": agent_host, "discord_adapter": discord, "host_ops": host_ops})


def detect_old_installs(old_root: Path) -> list[dict[str, Any]]:
    names = ("codex-bridge", "mattermpst_chat", "discord_agent_adapter", "host_ops", "codex-watchdog-vscode")
    result = []
    for name in names:
        path = old_root / name
        result.append({"name": name, "path": str(path), "exists": path.exists(), "is_dir": path.is_dir()})
    return result


def detect_systemd_units() -> list[dict[str, Any]]:
    unit_dir = Path.home() / ".config" / "systemd" / "user"
    units = []
    for unit in ("agent-host-web.service", "discord-agent-adapter.service"):
        path = unit_dir / unit
        units.append({"unit": unit, "path": str(path), "exists": path.exists()})
    return units


def report_for_migration(args: argparse.Namespace) -> dict[str, Any]:
    findings: list[Finding] = []
    old_installs = detect_old_installs(Path(args.old_root))
    systemd_units = detect_systemd_units()
    if any(item["exists"] for item in old_installs):
        findings.append(finding("info", "old_installs_detected", "Old install paths were detected.", count=sum(1 for item in old_installs if item["exists"])))
    else:
        findings.append(finding("info", "old_installs_not_detected", "No old install paths were detected."))
    if any(item["exists"] for item in systemd_units):
        findings.append(finding("info", "user_systemd_units_detected", "User systemd unit files were detected.", count=sum(1 for item in systemd_units if item["exists"])))
    else:
        findings.append(finding("warning", "user_systemd_units_missing", "Expected user systemd unit files were not found."))
    findings.append(
        finding(
            "info",
            "dry_run_only",
            "This migration check is read-only. It did not stop services, copy files, or modify units.",
        )
    )
    return build_report(
        "migration_check",
        findings,
        old_installs=old_installs,
        systemd_units=systemd_units,
        dry_run=True,
        suggested_next_steps=[
            "Review this report before switching services.",
            "Back up user systemd units before any cutover.",
            "Verify no active tasks are running before restarting services.",
            "Run config validation with the real local config files.",
        ],
    )


def report_for_rollback(args: argparse.Namespace) -> dict[str, Any]:
    findings: list[Finding] = [
        finding("info", "rollback_plan_only", "Rollback helper is currently plan-only and read-only."),
    ]
    systemd_units = detect_systemd_units()
    old_installs = detect_old_installs(Path(args.old_root))
    plan = [
        "Stop new user services only after explicit human approval.",
        "Restore backed-up pre-monorepo unit files if backups exist.",
        "Run systemctl --user daemon-reload from a normal user session.",
        "Start old services only if their paths still exist.",
        "Do not delete new state, logs, tasks, or configs during rollback.",
        "Run health checks after rollback.",
    ]
    return build_report("rollback_plan", findings, old_installs=old_installs, systemd_units=systemd_units, plan=plan)


def build_report(kind: str, findings: list[Finding], **extra: Any) -> dict[str, Any]:
    status = "ok"
    if any(item.level == "error" for item in findings):
        status = "error"
    elif any(item.level == "warning" for item in findings):
        status = "warning"
    report = {
        "ok": status != "error",
        "status": status,
        "kind": kind,
        "repo_root": str(ROOT),
        "findings": [asdict(item) for item in findings],
    }
    report.update(extra)
    return redact_config(report)


def print_human(report: dict[str, Any]) -> None:
    print(f"== {report['kind']} ==")
    print(f"status: {report['status']}")
    for item in report.get("findings", []):
        details = item.get("details") or {}
        suffix = f" {json.dumps(details, ensure_ascii=False)}" if details else ""
        print(f"{item['level'].upper()} {item['code']}: {item['message']}{suffix}")
    if "plan" in report:
        print("\nRollback plan:")
        for step in report["plan"]:
            print(f"- {step}")
    if "suggested_next_steps" in report:
        print("\nSuggested next steps:")
        for step in report["suggested_next_steps"]:
            print(f"- {step}")


def emit(report: dict[str, Any], as_json: bool) -> int:
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    return 1 if report["status"] == "error" else 0


def add_common_config_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--agent-host-config", default=str(DEFAULT_AGENT_HOST_CONFIG))
    parser.add_argument("--discord-config", default=str(DEFAULT_DISCORD_CONFIG))
    parser.add_argument("--host-ops-config", default=str(DEFAULT_HOST_OPS_CONFIG))
    parser.add_argument("--secrets-env", default=str(DEFAULT_SECRETS_ENV))
    parser.add_argument("--strict", action="store_true", help="Treat missing local paths as errors.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only control-plane safety checks.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    config_parser = subparsers.add_parser("config", help="Validate and print redacted config.")
    config_sub = config_parser.add_subparsers(dest="config_command", required=True)
    validate_parser = config_sub.add_parser("validate", help="Validate control-plane configs.")
    add_common_config_args(validate_parser)
    print_parser = config_sub.add_parser("print-redacted", help="Print redacted config validation report.")
    add_common_config_args(print_parser)

    migrate_parser = subparsers.add_parser("migrate", help="Migration and rollback dry-run helpers.")
    migrate_sub = migrate_parser.add_subparsers(dest="migrate_command", required=True)
    check_parser = migrate_sub.add_parser("check", help="Read-only migration check.")
    check_parser.add_argument("--old-root", default=str(DEFAULT_OLD_ROOT))
    check_parser.add_argument("--dry-run", action="store_true", default=True)
    check_parser.add_argument("--json", action="store_true")
    rollback_parser = migrate_sub.add_parser("rollback", help="Print read-only rollback plan.")
    rollback_parser.add_argument("--old-root", default=str(DEFAULT_OLD_ROOT))
    rollback_parser.add_argument("--dry-run", action="store_true", default=True)
    rollback_parser.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "config":
        report = report_for_config(args)
        return emit(report, args.json)
    if args.command == "migrate" and args.migrate_command == "check":
        report = report_for_migration(args)
        return emit(report, args.json)
    if args.command == "migrate" and args.migrate_command == "rollback":
        report = report_for_rollback(args)
        return emit(report, args.json)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
