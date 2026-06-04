#!/usr/bin/env python3
"""Mattermost -> Watchdog task bridge.

This is intentionally a task intake service, not a remote shell. It accepts a
small `/watchdog ...` command surface and writes JSON task files into a
whitelisted project's `agent/inbox/` directory for the project's watchdog to
judge later.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


MAX_BODY_BYTES = 64 * 1024
MAX_TASK_CHARS = 4000
MAX_RESPONSE_CHARS = 3500
AGENT_HOST_VERSION = "mvp-v0.7"
PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
CODEX_TASK_ID_RE = re.compile(r"^task_[A-Za-z0-9_.-]+$")
INTAKE_ID_RE = re.compile(r"^intake_[A-Za-z0-9_.-]+$")
SUPPORTED_CODEX_MODES = {"readonly", "workspace-write"}
TASK_LIST_DEFAULT_LIMIT = 50
TASK_LIST_MAX_LIMIT = 200
PROMPT_PREVIEW_CHARS = 110
RESULT_PAGE_DEFAULT_SIZE = 1800
RESULT_PAGE_MAX_SIZE = 8000
INTAKE_QUESTION_MAX = 3
CODEX_FINAL_STATUSES = {"done", "failed", "cancelled", "timeout", "stale", "policy_violation"}
CODEX_ACTIVE_STATUSES = {"queued", "running", "cancelling", "cancel_requested"}
STREAM_TOKEN_TTL_SECONDS = 300
SSE_POLL_SECONDS = 1.0
SSE_HEARTBEAT_SECONDS = 15.0
SSE_LOG_TAIL_LINES = 200
SSE_LOG_MAX_CHARS = 20000
SSE_LOG_EVENT_MAX_CHARS = 8000
SUPERVISOR_TEXT_MAX_CHARS = 500
SUPERVISOR_ALLOWED_BLOCKERS = {
    "env",
    "queue",
    "permission",
    "reviewer",
    "model",
    "data",
    "stale_state",
    "none",
    "unknown",
}
WRITE_SCOPE_HINT_RE = re.compile(r"(/|\.(?:md|txt|json|py|js|ts|tsx|jsx|yaml|yml|sh)\b|README|agent/|workspace/|runs/)", re.I)
DEICTIC_HINT_RE = re.compile(r"\b(this|that|it|these|those|here|there)\b|这个|这个问题|这个任务|它|上述|前面的", re.I)
STREAM_TOKENS: dict[str, dict[str, Any]] = {}
STREAM_TOKEN_LOCK = threading.Lock()


class BridgeError(Exception):
    def __init__(
        self,
        message: str,
        status: int = 400,
        code: str | None = None,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class Project:
    name: str
    root: Path
    label: str = ""
    description: str = ""
    default_mode: str = "readonly"
    allowed_modes: tuple[str, ...] = ("readonly",)


@dataclass(frozen=True)
class AuthPrincipal:
    user: str
    role: str


@dataclass(frozen=True)
class BridgeConfig:
    host: str
    port: int
    mattermost_tokens: tuple[str, ...]
    allowed_users: tuple[str, ...]
    projects: dict[str, Project]
    codex_bridge_root: Path
    codex_bridge_node_bin: str
    auth_tokens: dict[str, AuthPrincipal]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def load_config(path: Path) -> BridgeConfig:
    if not path.exists():
        raise BridgeError(f"config file not found: {path}", 500)
    data = json.loads(path.read_text())

    raw_projects = data.get("projects")
    if not isinstance(raw_projects, dict) or not raw_projects:
        raise BridgeError("config must define nonempty projects mapping", 500)

    projects: dict[str, Project] = {}
    for name, raw_project in raw_projects.items():
        if not isinstance(name, str) or not PROJECT_NAME_RE.match(name):
            raise BridgeError(f"invalid project name in config: {name!r}", 500)

        if isinstance(raw_project, str):
            root = raw_project
            label = name
            description = ""
            default_mode = "readonly"
            allowed_modes = ("readonly",)
        elif isinstance(raw_project, dict):
            root = str(raw_project.get("path") or raw_project.get("root") or "")
            label = str(raw_project.get("label") or name)
            description = str(raw_project.get("description") or "")
            default_mode = str(raw_project.get("default_mode") or "readonly")
            raw_modes = raw_project.get("allowed_modes") or [default_mode]
            if not isinstance(raw_modes, list):
                raise BridgeError(f"project {name} allowed_modes must be a list", 500)
            allowed_modes = tuple(str(mode) for mode in raw_modes if str(mode))
        else:
            raise BridgeError(f"project {name} must be a path string or object", 500)

        if not isinstance(root, str) or not root.startswith("/"):
            raise BridgeError(f"project {name} root must be an absolute path", 500)
        if default_mode not in SUPPORTED_CODEX_MODES:
            raise BridgeError(f"project {name} has unsupported default_mode: {default_mode}", 500)
        if not allowed_modes or any(mode not in SUPPORTED_CODEX_MODES for mode in allowed_modes):
            raise BridgeError(f"project {name} has unsupported allowed_modes", 500)
        if default_mode not in allowed_modes:
            raise BridgeError(f"project {name} default_mode must be in allowed_modes", 500)
        root_path = Path(root).resolve()
        projects[name] = Project(
            name=name,
            root=root_path,
            label=label,
            description=description,
            default_mode=default_mode,
            allowed_modes=allowed_modes,
        )

    tokens = tuple(str(x) for x in data.get("mattermost_tokens", []) if str(x))
    allowed_users = tuple(str(x) for x in data.get("allowed_users", []) if str(x))
    default_codex_bridge_root = Path(__file__).resolve().parents[1] / "codex-bridge"
    codex_bridge_root = Path(str(data.get("codex_bridge_root", default_codex_bridge_root))).resolve()
    auth_tokens = load_auth_tokens(data)

    return BridgeConfig(
        host=str(data.get("host", "127.0.0.1")),
        port=int(data.get("port", 8787)),
        mattermost_tokens=tokens,
        allowed_users=allowed_users,
        projects=projects,
        codex_bridge_root=codex_bridge_root,
        codex_bridge_node_bin=str(data.get("codex_bridge_node_bin", "node")),
        auth_tokens=auth_tokens,
    )


def load_auth_tokens(data: dict[str, Any]) -> dict[str, AuthPrincipal]:
    raw_tokens = data.get("auth", {}).get("tokens", {})
    if raw_tokens is None:
        raw_tokens = {}
    if not isinstance(raw_tokens, dict):
        raise BridgeError("auth.tokens must be an object", 500)

    tokens: dict[str, AuthPrincipal] = {}
    for token, raw_principal in raw_tokens.items():
        token = str(token)
        if not token:
            raise BridgeError("auth token may not be empty", 500)
        if not isinstance(raw_principal, dict):
            raise BridgeError("auth token entries must be objects", 500)
        user = str(raw_principal.get("user", "")).strip()
        role = str(raw_principal.get("role", "user")).strip() or "user"
        if not user:
            raise BridgeError("auth token entry missing user", 500)
        tokens[token] = AuthPrincipal(user=user, role=role)
    return tokens


def parse_body(content_type: str, raw: bytes) -> dict[str, str]:
    if "application/json" in content_type:
        data = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(data, dict):
            raise BridgeError("JSON body must be an object")
        parsed: dict[str, str] = {}
        for key, value in data.items():
            if value is None:
                continue
            if isinstance(value, (dict, list)):
                parsed[str(key)] = json.dumps(value, ensure_ascii=False)
            else:
                parsed[str(key)] = str(value)
        return parsed

    parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
    return {key: values[-1] if values else "" for key, values in parsed.items()}


def mattermost_response(text: str, response_type: str = "ephemeral") -> dict[str, str]:
    if len(text) > MAX_RESPONSE_CHARS:
        text = text[: MAX_RESPONSE_CHARS - 80].rstrip() + "\n\n...(truncated)"
    return {"response_type": response_type, "text": text}


def error_code_for(exc: BridgeError) -> str:
    if exc.code:
        return exc.code
    if exc.status == 401:
        return "unauthorized"
    if exc.status == 403:
        return "permission_denied"
    if exc.status == 404:
        return "task_not_found" if "task" in str(exc).lower() else "workspace_not_found"
    if exc.status == 409:
        return "task_already_finished"
    if exc.status == 400:
        return "invalid_request"
    return "internal_error"


def api_error_payload(exc: BridgeError | Exception) -> dict[str, Any]:
    if isinstance(exc, BridgeError):
        code = error_code_for(exc)
        message = str(exc)
        details = exc.details
    else:
        code = "internal_error"
        message = f"bridge error: {exc}"
        details = {}
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "details": details,
        },
        "text": message,
    }


def validate_auth(payload: dict[str, str], config: BridgeConfig) -> None:
    token = payload.get("token", "")
    if config.mattermost_tokens and token not in config.mattermost_tokens:
        raise BridgeError("unauthorized: invalid Mattermost token", 403)

    if config.allowed_users:
        user_name = payload.get("user_name", "")
        user_id = payload.get("user_id", "")
        if user_name not in config.allowed_users and user_id not in config.allowed_users:
            raise BridgeError("unauthorized: Mattermost user is not allowlisted", 403)


def authenticate_bearer(authorization: str, config: BridgeConfig) -> AuthPrincipal:
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise BridgeError("unauthorized: bearer token required", 401, "unauthorized")

    supplied = authorization[len(prefix) :].strip()
    if not supplied:
        raise BridgeError("unauthorized: bearer token required", 401, "unauthorized")

    for token, principal in config.auth_tokens.items():
        if secrets.compare_digest(supplied, token):
            if config.allowed_users and principal.user not in config.allowed_users:
                raise BridgeError("unauthorized: authenticated user is not allowlisted", 403, "permission_denied")
            return principal

    raise BridgeError("unauthorized: invalid bearer token", 401, "unauthorized")


def reject_frontend_identity(payload: dict[str, str]) -> None:
    forbidden = {"user", "user_name", "user_id", "internal_user"}
    present = sorted(forbidden.intersection(payload))
    if present:
        names = ", ".join(present)
        raise BridgeError(
            f"user identity must come from bearer token, not request body ({names})",
            400,
            "invalid_request",
        )


def get_project(config: BridgeConfig, name: str | None) -> Project:
    if not name:
        if len(config.projects) == 1:
            return next(iter(config.projects.values()))
        raise BridgeError("project is required")
    if name not in config.projects:
        available = ", ".join(sorted(config.projects))
        raise BridgeError(f"unknown project {name!r}; available: {available}")
    project = config.projects[name]
    if not project.root.exists() or not project.root.is_dir():
        raise BridgeError(f"project root does not exist: {project.root}", 500)
    return project


def parse_project_token(parts: list[str], start: int = 1) -> tuple[str | None, list[str]]:
    if len(parts) <= start:
        return None, []
    token = parts[start]
    if token.startswith("project="):
        return token.split("=", 1)[1], parts[start + 1 :]
    return token, parts[start + 1 :]


def safe_snippet(path: Path, max_chars: int = 1800) -> str:
    if not path.exists():
        return f"(missing: {path})"
    text = path.read_text(errors="replace")
    if len(text) > max_chars:
        return text[:max_chars].rstrip() + "\n...(truncated)"
    return text


def latest_report_path(project: Project) -> Path:
    return project.root / "agent" / "reports" / "latest.md"


def status_text(project: Project) -> str:
    root = project.root
    latest = latest_report_path(project)
    runtime = root / "agent" / "RUNTIME_STATE.md"
    morning = root / "agent" / "MORNING_BRIEF.md"
    inbox = root / "agent" / "inbox"

    lines = [
        f"Project `{project.name}`",
        f"Root: `{root}`",
        f"Latest report: `{latest.resolve() if latest.exists() else 'missing'}`",
        f"Runtime state: {'present' if runtime.exists() else 'missing'}",
        f"Morning brief: {'present' if morning.exists() else 'missing'}",
        f"Inbox items: {len(list(inbox.glob('*.json'))) if inbox.exists() else 0}",
    ]
    return "\n".join(lines)


def brief_text(project: Project) -> str:
    morning = project.root / "agent" / "MORNING_BRIEF.md"
    latest = latest_report_path(project)
    if morning.exists():
        return f"Morning brief for `{project.name}`:\n\n{safe_snippet(morning)}"
    return f"Latest report for `{project.name}`:\n\n{safe_snippet(latest)}"


def inbox_text(project: Project) -> str:
    inbox = project.root / "agent" / "inbox"
    if not inbox.exists():
        return f"Inbox for `{project.name}` is empty."
    items = sorted(inbox.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not items:
        return f"Inbox for `{project.name}` is empty."
    lines = [f"Latest inbox items for `{project.name}`:"]
    for item in items[:10]:
        lines.append(f"- `{item.name}` ({item.stat().st_size} bytes)")
    return "\n".join(lines)


def write_task(
    project: Project,
    payload: dict[str, str],
    request: str,
    mode: str,
    now: dt.datetime | None = None,
) -> tuple[str, Path]:
    request = request.strip()
    if not request:
        raise BridgeError("task request is empty")
    if len(request) > MAX_TASK_CHARS:
        raise BridgeError(f"task request is too long; max {MAX_TASK_CHARS} chars")

    now = now or utc_now()
    task_id = f"{now.strftime('%Y%m%dT%H%M%SZ')}_{secrets.token_hex(4)}"
    inbox = project.root / "agent" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    out = inbox / f"{task_id}_mattermost_task.json"
    tmp = inbox / f".{task_id}.tmp"

    task = {
        "id": task_id,
        "source": "mattermost",
        "project": project.name,
        "request": request,
        "mode": mode,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "status": "new",
        "mattermost": {
            "team_id": payload.get("team_id", ""),
            "team_domain": payload.get("team_domain", ""),
            "channel_id": payload.get("channel_id", ""),
            "channel_name": payload.get("channel_name", ""),
            "user_id": payload.get("user_id", ""),
            "user_name": payload.get("user_name", ""),
            "command": payload.get("command", ""),
            "text": payload.get("text", ""),
        },
        "safety": {
            "bridge_executed_shell": False,
            "bridge_started_watchdog": False,
            "bridge_modified_project_files": [str(out.relative_to(project.root))],
            "requires_watchdog_decision": True,
        },
    }

    tmp.write_text(json.dumps(task, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, out)
    return task_id, out


def help_text(config: BridgeConfig) -> str:
    projects = ", ".join(sorted(config.projects))
    return "\n".join(
        [
            "Watchdog bridge commands:",
            "`/watchdog task <project> <request>` - submit a task to project inbox",
            "`/watchdog status <project>` - show project status",
            "`/watchdog brief <project>` - show morning brief/latest report",
            "`/watchdog inbox <project>` - list queued inbox tasks",
            "`/watchdog run-once <project> <reason>` - submit a run-once request for watchdog to judge later",
            f"Projects: {projects}",
            "",
            "This bridge never executes shell commands directly.",
        ]
    )


def handle_watchdog(payload: dict[str, str], config: BridgeConfig) -> dict[str, str]:
    validate_auth(payload, config)

    text = payload.get("text", "").strip()
    if not text:
        return mattermost_response(help_text(config))

    try:
        parts = shlex.split(text)
    except ValueError as exc:
        raise BridgeError(f"could not parse command text: {exc}")

    if not parts:
        return mattermost_response(help_text(config))

    subcommand = parts[0].lower()
    if subcommand in {"help", "-h", "--help"}:
        return mattermost_response(help_text(config))

    if subcommand in {"status", "brief", "inbox"}:
        project_name, rest = parse_project_token(parts)
        if rest:
            raise BridgeError(f"`{subcommand}` does not accept extra arguments")
        project = get_project(config, project_name)
        if subcommand == "status":
            return mattermost_response(status_text(project))
        if subcommand == "brief":
            return mattermost_response(brief_text(project))
        return mattermost_response(inbox_text(project))

    if subcommand in {"task", "run-once", "run_once"}:
        project_name, rest = parse_project_token(parts)
        project = get_project(config, project_name)
        request = " ".join(rest).strip()
        if subcommand in {"run-once", "run_once"}:
            request = request or "Run one watchdog cycle when safe, then report results."
            mode = "run_once_request"
        else:
            mode = "task_request"
        task_id, out = write_task(project, payload, request, mode)
        rel = out.relative_to(project.root)
        return mattermost_response(
            f"Queued `{mode}` for `{project.name}`.\n"
            f"Task id: `{task_id}`\n"
            f"File: `{rel}`\n\n"
            "The bridge did not execute shell commands. The project watchdog will judge this task on its next cycle."
        )

    raise BridgeError(f"unknown subcommand: {subcommand}")


def bool_from_payload(value: str) -> bool:
    return str(value).lower() in {"1", "true", "yes", "on"}


def run_codex_bridge(config: BridgeConfig, args: list[str], timeout: int = 20) -> subprocess.CompletedProcess[str]:
    script = config.codex_bridge_root / "scripts" / "codex-bridge.js"
    if not script.exists():
        raise BridgeError(f"codex-bridge script not found: {script}", 500)
    bridge_config = write_codex_bridge_config(config)
    bridged_args = [args[0], "--config", str(bridge_config), *args[1:]]

    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = ""
    return subprocess.run(
        [config.codex_bridge_node_bin, str(script), *bridged_args],
        cwd=str(config.codex_bridge_root),
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def write_codex_bridge_config(config: BridgeConfig) -> Path:
    """Mirror the web adapter allowlists into the standalone codex-bridge config."""
    state_dir = config.codex_bridge_root / ".codex-bridge"
    state_dir.mkdir(parents=True, exist_ok=True)
    out = state_dir / "web-adapter.config.json"
    tmp = state_dir / f".web-adapter.{os.getpid()}.tmp"

    projects = {
        name: {
            "path": str(project.root),
            "mode": project.default_mode,
            "allowedModes": list(project.allowed_modes),
        }
        for name, project in sorted(config.projects.items())
    }
    data = {
        "version": 1,
        "users": list(config.allowed_users),
        "projects": projects,
        "stateDir": str(state_dir),
        "codexBin": "codex",
        "maxConcurrent": 1,
        "timeoutSeconds": 900,
        "cancelGraceMs": 5000,
        "watchdogIntervalMs": 1000,
        "dryRunStepMs": 450,
        "redaction": {
            "enabled": True,
            "redactHomePath": True,
            "redactProjectPaths": True,
            "redactTokens": True,
            "maxLogChars": 20000,
            "maxResultChars": 80000,
        },
        "generated_by": "mattermpst_chat web adapter",
    }
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, out)
    return out


def require_success(result: subprocess.CompletedProcess[str]) -> str:
    output = (result.stdout or "").strip()
    if result.returncode == 0:
        return output
    error = (result.stderr or result.stdout or "codex-bridge command failed").strip()
    raise BridgeError(error, 500)


def reconcile_codex_tasks(config: BridgeConfig) -> None:
    script = config.codex_bridge_root / "scripts" / "codex-bridge.js"
    if not script.exists():
        return
    result = run_codex_bridge(config, ["reconcile"], timeout=10)
    if result.returncode != 0:
        raise BridgeError((result.stderr or result.stdout or "codex-bridge reconcile failed").strip(), 500)


def parse_queued_task_id(output: str) -> str:
    for line in output.splitlines():
        match = re.match(r"^queued\s+(task_[A-Za-z0-9_.-]+)$", line.strip())
        if match:
            return match.group(1)
    raise BridgeError("codex-bridge did not return a task id", 500)


def validate_task_id(task_id: str) -> str:
    if not CODEX_TASK_ID_RE.match(task_id or ""):
        raise BridgeError("invalid task_id")
    return task_id


def codex_tasks_root(config: BridgeConfig) -> Path:
    return config.codex_bridge_root / ".codex-bridge" / "tasks"


def load_codex_task(config: BridgeConfig, task_id: str) -> tuple[Path, dict[str, Any]]:
    task_id = validate_task_id(task_id)
    task_dir = codex_tasks_root(config) / task_id
    task_file = task_dir / "task.json"
    if not task_file.exists():
        raise BridgeError(f"task not found: {task_id}", 404, "task_not_found")
    try:
        data = json.loads(task_file.read_text())
    except json.JSONDecodeError as exc:
        raise BridgeError(f"task metadata is invalid: {task_id}: {exc}", 500) from exc
    if not isinstance(data, dict):
        raise BridgeError(f"task metadata is invalid: {task_id}", 500)
    return task_dir, data


def is_admin(principal: AuthPrincipal) -> bool:
    return principal.role.lower() == "admin"


def can_access_task(task: dict[str, Any], principal: AuthPrincipal) -> bool:
    if is_admin(principal):
        return True
    return str(task.get("user", "")) == principal.user


def authorize_codex_task(
    config: BridgeConfig,
    principal: AuthPrincipal,
    task_id: str,
) -> tuple[Path, dict[str, Any]]:
    task_dir, task = load_codex_task(config, task_id)
    project = str(task.get("project", ""))
    if project and project not in config.projects:
        raise BridgeError(f"task project is not allowlisted: {project}", 403, "permission_denied")
    if not can_access_task(task, principal):
        raise BridgeError(f"unauthorized: task is not owned by {principal.user}", 403, "permission_denied")
    return task_dir, task


def parse_iso_datetime(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def task_duration_sec(task: dict[str, Any]) -> int | None:
    start = parse_iso_datetime(task.get("started_at")) or parse_iso_datetime(task.get("created_at"))
    end = parse_iso_datetime(task.get("ended_at")) or parse_iso_datetime(task.get("updated_at"))
    if not start:
        return None
    if not end and str(task.get("status", "")) in {"queued", "running"}:
        end = utc_now()
    if not end:
        return None
    return max(0, int(round((end - start).total_seconds())))


def prompt_preview(prompt: Any) -> str:
    text = re.sub(r"\s+", " ", str(prompt or "")).strip()
    if len(text) <= PROMPT_PREVIEW_CHARS:
        return text
    return text[: PROMPT_PREVIEW_CHARS - 1].rstrip() + "…"


def task_sort_value(task: dict[str, Any]) -> str:
    value = task.get("updated_at") or task.get("created_at") or ""
    return str(value)


def codex_task_summary(task_dir: Path, task: dict[str, Any]) -> dict[str, Any]:
    task_id = str(task.get("task_id") or task_dir.name)
    return {
        "task_id": task_id,
        "owner": str(task.get("user", "")),
        "project": str(task.get("project", "")),
        "source": str(task.get("source", "unknown") or "unknown"),
        "status": str(task.get("status", "")),
        "created_at": str(task.get("created_at", "")),
        "updated_at": str(task.get("updated_at", "")),
        "duration_sec": task_duration_sec(task),
        "exit_code": task.get("exit_code") if isinstance(task.get("exit_code"), int) else None,
        "prompt_preview": prompt_preview(task.get("prompt", "")),
        "has_result": (task_dir / "result.md").exists(),
        "has_logs": any((task_dir / name).exists() for name in ("bridge.log", "stdout.jsonl", "stderr.log")),
        "mode": str(task.get("mode", "")),
        "write_audit": bool(task.get("write_audit_path")),
        "changed_files_count": task.get("changed_files_count") if isinstance(task.get("changed_files_count"), int) else None,
        "protected_path_violation": bool(task.get("protected_path_violation")),
    }


def task_list_limit(value: str | None) -> int:
    if not value:
        return TASK_LIST_DEFAULT_LIMIT
    try:
        parsed = int(value)
    except ValueError as exc:
        raise BridgeError("limit must be a number") from exc
    if parsed < 1:
        raise BridgeError("limit must be at least 1")
    return min(parsed, TASK_LIST_MAX_LIMIT)


def handle_codex_tasks(
    payload: dict[str, str],
    config: BridgeConfig,
    principal: AuthPrincipal,
) -> dict[str, Any]:
    reject_frontend_identity(payload)
    limit = task_list_limit(payload.get("limit"))
    status_filter = payload.get("status", "").strip()
    project_filter = payload.get("project", "").strip()

    if status_filter and not re.match(r"^[A-Za-z0-9_.-]{1,32}$", status_filter):
        raise BridgeError("status filter must be a safe status name")
    if project_filter:
        validate_codex_project(config, project_filter)

    reconcile_codex_tasks(config)

    root = codex_tasks_root(config)
    if not root.exists():
        return {"ok": True, "tasks": []}

    items: list[tuple[str, dict[str, Any]]] = []
    for task_file in root.glob("*/task.json"):
        task_dir = task_file.parent
        if not CODEX_TASK_ID_RE.match(task_dir.name):
            continue
        try:
            task = json.loads(task_file.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(task, dict):
            continue
        task_project = str(task.get("project", ""))
        if task_project and task_project not in config.projects:
            continue
        if not can_access_task(task, principal):
            continue
        if status_filter and str(task.get("status", "")) != status_filter:
            continue
        if project_filter and task_project != project_filter:
            continue
        items.append((task_sort_value(task), codex_task_summary(task_dir, task)))

    items.sort(key=lambda item: item[0], reverse=True)
    return {"ok": True, "tasks": [summary for _, summary in items[:limit]]}


def workspace_summary(project: Project) -> dict[str, Any]:
    return {
        "id": project.name,
        "label": project.label or project.name,
        "default_mode": project.default_mode,
        "allowed_modes": list(project.allowed_modes),
        "description": project.description,
    }


def handle_codex_workspaces(config: BridgeConfig, _principal: AuthPrincipal) -> dict[str, Any]:
    return {
        "ok": True,
        "workspaces": [
            workspace_summary(project)
            for project in sorted(config.projects.values(), key=lambda item: item.name)
        ],
    }


def handle_codex_capabilities(config: BridgeConfig, _principal: AuthPrincipal) -> dict[str, Any]:
    modes = sorted({mode for project in config.projects.values() for mode in project.allowed_modes})
    write_mode = any("workspace-write" in project.allowed_modes for project in config.projects.values())
    return {
        "ok": True,
        "version": AGENT_HOST_VERSION,
        "commands": ["prepare", "run", "tasks", "status", "result", "logs", "cancel"],
        "features": {
            "auth": True,
            "safe_output": True,
            "sse": True,
            "cancel": True,
            "timeout": True,
            "resume": False,
            "write_mode": write_mode,
            "prepare_intake": True,
            "raw_admin_access": True,
        },
        "modes": modes,
    }


def read_recent_task_summaries(config: BridgeConfig, principal: AuthPrincipal, limit: int = 50) -> list[dict[str, Any]]:
    root = codex_tasks_root(config)
    if not root.exists():
        return []

    items: list[tuple[str, dict[str, Any]]] = []
    for task_file in root.glob("*/task.json"):
        task_dir = task_file.parent
        if not CODEX_TASK_ID_RE.match(task_dir.name):
            continue
        try:
            task = json.loads(task_file.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(task, dict):
            continue
        task_project = str(task.get("project", ""))
        if task_project and task_project not in config.projects:
            continue
        if not can_access_task(task, principal):
            continue
        items.append((task_sort_value(task), codex_task_summary(task_dir, task)))
    items.sort(key=lambda item: item[0], reverse=True)
    return [summary for _sort, summary in items[: max(1, limit)]]


def safe_control_text(config: BridgeConfig, text: str) -> str:
    safe = str(text or "")
    replacements = [(str(project.root), f"[workspace:{name}]") for name, project in config.projects.items()]
    for raw_path, replacement in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        if raw_path:
            safe = re.sub(re.escape(raw_path), replacement, safe)

    home = str(Path.home())
    if home:
        safe = re.sub(re.escape(home), "~", safe)

    safe = re.sub(r"Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+", "Authorization: Bearer [REDACTED]", safe, flags=re.I)
    safe = re.sub(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b", "[REDACTED_OPENAI_KEY]", safe)
    safe = re.sub(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b", "[REDACTED_GITHUB_TOKEN]", safe)
    safe = re.sub(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b", "[REDACTED_DISCORD_TOKEN]", safe)
    safe = re.sub(
        r"(?im)\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s]+)",
        r"\1=[REDACTED_SECRET]",
        safe,
    )
    safe = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        "[REDACTED_PRIVATE_KEY]",
        safe,
    )
    return safe


def compact_control_text(config: BridgeConfig, text: str, max_chars: int = SUPERVISOR_TEXT_MAX_CHARS) -> str:
    safe = " ".join(safe_control_text(config, text).split())
    if len(safe) > max_chars:
        return safe[: max(0, max_chars - 16)].rstrip() + "...(truncated)"
    return safe


def read_limited_text(path: Path, max_chars: int = 8192) -> str:
    if not path.exists() or not path.is_file():
        return ""
    try:
        return path.read_text(errors="replace")[:max_chars]
    except OSError:
        return ""


def read_limited_json(path: Path, max_chars: int = 65536) -> dict[str, Any] | None:
    text = read_limited_text(path, max_chars=max_chars)
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def safe_blocker_type(value: Any) -> str:
    blocker = str(value or "unknown").strip().lower().replace("-", "_")
    if blocker not in SUPERVISOR_ALLOWED_BLOCKERS:
        return "unknown"
    return blocker


def safe_count_text(config: BridgeConfig, value: Any) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return "unknown"
    if not re.fullmatch(r"[0-9]{1,12}", text):
        return "unknown"
    return compact_control_text(config, text, max_chars=16)


def workspace_supervisor_signal(config: BridgeConfig, project: Project) -> dict[str, Any]:
    agent_dir = project.root / "agent"
    run_state_path = agent_dir / "RUN_STATE.json"
    next_action_path = agent_dir / "NEXT_ACTION.md"
    blockers_path = agent_dir / "BLOCKERS.md"
    run_state = read_limited_json(run_state_path) or {}
    next_action = run_state.get("next_action") if isinstance(run_state.get("next_action"), dict) else {}
    role = str(run_state.get("role") or "unknown").strip().lower()
    if role not in {"runner", "supervisor"}:
        role = "unknown"

    description = str(next_action.get("description") or "")
    if not description:
        description = read_limited_text(next_action_path, max_chars=2000)

    return {
        "workspace": project.name,
        "role": role,
        "supervisor_mode": compact_control_text(config, str(run_state.get("supervisor_mode") or "unknown"), max_chars=80),
        "runner_started_count": safe_count_text(config, run_state.get("runner_started_count")),
        "runner_completed_count": safe_count_text(config, run_state.get("runner_completed_count") or run_state.get("runner_run_count")),
        "runner_failure_drift": safe_count_text(config, run_state.get("runner_failure_drift")),
        "status": compact_control_text(config, str(run_state.get("status") or "unknown"), max_chars=80),
        "blocker_type": safe_blocker_type(run_state.get("blocker_type")),
        "requires_human_review": bool(run_state.get("requires_human_review", False)),
        "updated_utc": compact_control_text(config, str(run_state.get("updated_utc") or ""), max_chars=80),
        "next_action": {
            "kind": compact_control_text(config, str(next_action.get("kind") or "unknown"), max_chars=80),
            "description": compact_control_text(config, description),
            "can_execute_automatically": bool(next_action.get("can_execute_automatically", False)),
            "reason": compact_control_text(config, str(next_action.get("reason") or ""), max_chars=240),
        },
        "blockers_preview": compact_control_text(config, read_limited_text(blockers_path, max_chars=3000)),
        "files": {
            "run_state": run_state_path.exists(),
            "next_action": next_action_path.exists(),
            "blockers": blockers_path.exists(),
            "current_state": (agent_dir / "CURRENT_STATE.md").exists(),
            "anti_snowball": (agent_dir / "ANTI_SNOWBALL.md").exists(),
        },
    }


def workspace_supervisor_signals(config: BridgeConfig) -> list[dict[str, Any]]:
    return [
        workspace_supervisor_signal(config, project)
        for project in sorted(config.projects.values(), key=lambda item: item.name)
    ]


def handle_health_summary(config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    recent = read_recent_task_summaries(config, principal, limit=50)
    active = [task for task in recent if task.get("status") in CODEX_ACTIVE_STATUSES]
    terminal = [task for task in recent if task.get("status") in CODEX_FINAL_STATUSES]
    modes = sorted({mode for project in config.projects.values() for mode in project.allowed_modes})
    supervisor_signals = workspace_supervisor_signals(config)
    blocked = [item for item in supervisor_signals if item.get("blocker_type") not in {"none", "unknown"}]
    review_required = [item for item in supervisor_signals if item.get("requires_human_review")]
    runner_drift = [
        item
        for item in supervisor_signals
        if str(item.get("runner_failure_drift") or "0").isdigit()
        and int(str(item.get("runner_failure_drift") or "0")) > 0
    ]
    return {
        "ok": True,
        "agent_host": {
            "active": True,
            "version": AGENT_HOST_VERSION,
        },
        "workspaces": {
            "count": len(config.projects),
            "modes": modes,
            "items": [
                {
                    "id": project.name,
                    "default_mode": project.default_mode,
                    "allowed_modes": list(project.allowed_modes),
                }
                for project in sorted(config.projects.values(), key=lambda item: item.name)
            ],
        },
        "tasks": {
            "recent_count": len(recent),
            "active_count": len(active),
            "terminal_count": len(terminal),
            "latest_terminal": terminal[0] if terminal else None,
        },
        "supervisor": {
            "workspace_count": len(supervisor_signals),
            "blocked_count": len(blocked),
            "review_required_count": len(review_required),
            "runner_drift_count": len(runner_drift),
            "signals": supervisor_signals,
        },
        "safety": {
            "safe_output": True,
            "raw_output": False,
            "host_ops_direct": False,
        },
    }


def safe_codex_status_text(config: BridgeConfig, task: dict[str, Any], text: str) -> str:
    safe = str(text or "")
    project_alias = str(task.get("project") or "")
    project_path = str(task.get("project_path") or "")
    replacements: list[tuple[str, str]] = []
    if project_alias and project_path:
        replacements.append((project_path, f"[workspace:{project_alias}]"))
    for name, project in config.projects.items():
        replacements.append((str(project.root), f"[workspace:{name}]"))

    seen: set[str] = set()
    for raw_path, replacement in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        if not raw_path or raw_path in seen:
            continue
        seen.add(raw_path)
        safe = re.sub(re.escape(raw_path), replacement, safe)

    home = str(Path.home())
    if home:
        safe = re.sub(re.escape(home), "~", safe)

    if project_alias:
        safe = re.sub(
            r"^project_path:\s*.+$",
            f"project_path: [workspace:{project_alias}]",
            safe,
            flags=re.MULTILINE,
        )
    return safe_control_text(config, safe)


def validate_codex_project(config: BridgeConfig, project: str) -> Project:
    if not PROJECT_NAME_RE.match(project):
        raise BridgeError("project is required and must be a safe project name", 400, "invalid_request")
    if project not in config.projects:
        raise BridgeError(f"project is not allowlisted: {project}", 403, "workspace_not_found")
    item = config.projects[project]
    if not item.root.exists() or not item.root.is_dir():
        raise BridgeError(f"project root does not exist: {item.root}", 500)
    return item


def validate_intake_id(intake_id: str) -> str:
    if not INTAKE_ID_RE.match(intake_id or ""):
        raise BridgeError("invalid intake_id", 400, "invalid_request")
    return intake_id


def new_intake_id() -> str:
    stamp = utc_now().strftime("%Y%m%d_%H%M%S")
    return f"intake_{stamp}_{secrets.token_hex(3)}"


def intake_root(config: BridgeConfig) -> Path:
    return config.codex_bridge_root / ".codex-bridge" / "intake"


def intake_dir(config: BridgeConfig, intake_id: str) -> Path:
    return intake_root(config) / validate_intake_id(intake_id)


def load_intake_intent(config: BridgeConfig, intake_id: str) -> dict[str, Any]:
    path = intake_dir(config, intake_id) / "INTENT_DRAFT.json"
    if not path.exists():
        raise BridgeError(f"intake not found: {intake_id}", 404, "intake_not_found")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise BridgeError(f"intake metadata is invalid: {intake_id}: {exc}", 500) from exc
    if not isinstance(data, dict):
        raise BridgeError(f"intake metadata is invalid: {intake_id}", 500)
    return data


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(temp, path)


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    temp.write_text(text)
    os.replace(temp, path)


def append_jsonl(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def safe_intake_text(value: str, max_chars: int = 6000) -> str:
    text = str(value or "").strip()
    if len(text) > max_chars:
        raise BridgeError(f"text is too long; max {max_chars} chars", 400, "invalid_request")
    return text


def intake_answers_text(payload: dict[str, str]) -> str:
    return safe_intake_text(payload.get("answers") or payload.get("answer") or "", 4000)


def intake_words(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


def parse_intent_signals(prompt: str, answers: str) -> dict[str, bool]:
    text = intake_words(f"{prompt}\n{answers}")
    return {
        "wants_write": any(term in text for term in ("fix", "update", "modify", "change", "edit", "rewrite", "implement", "修复", "修改", "更新", "实现", "改一下")),
        "wants_report_only": any(term in text for term in ("summarize", "summary", "explain", "review", "analyze", "status", "report", "总结", "说明", "检查", "分析", "状态")),
        "wants_local_workspace_copy": any(term in text for term in ("local workspace", "project_local_copy", "workspace/", "copy into workspace", "本地副本", "副本")),
        "wants_cpu_eval": any(term in text for term in ("cpu", "cpu32", "smoke", "eval", "probe", "bounded cpu", "sample_count", "cpu-only", "cpu only")),
        "wants_gpu": "gpu" in text,
        "wants_training": any(term in text for term in ("train", "training", "finetune", "qat", "训练")),
        "wants_promotion": any(term in text for term in ("promote", "promotion", "shared_model", "deployment", "public docs", "合并到共享", "发布")),
        "wants_external_send": any(term in text for term in ("external send", "reviewer send", "deep research send", "发给 reviewer", "外部发送")),
        "wants_secret_or_service": any(term in text for term in ("token", "secret", ".env", "systemd", "restart service", "private key", "密码")),
    }


def explicit_scope_present(prompt: str, answers: str) -> bool:
    text = f"{prompt}\n{answers}"
    if WRITE_SCOPE_HINT_RE.search(text):
        return True
    return any(term in text.lower() for term in ("file ", "files ", "folder ", "directory ", "path ", "目录", "文件", "路径"))


def infer_objective(signals: dict[str, bool]) -> str:
    if signals["wants_external_send"]:
        return "external_send"
    if signals["wants_promotion"]:
        return "promotion_apply"
    if signals["wants_training"]:
        return "bounded_training_canary" if signals["wants_cpu_eval"] else "training"
    if signals["wants_gpu"]:
        return "bounded_gpu_probe" if signals["wants_cpu_eval"] else "gpu"
    if signals["wants_local_workspace_copy"]:
        return "local_workspace_copy"
    if signals["wants_cpu_eval"]:
        return "bounded_cpu_eval"
    if signals["wants_write"]:
        return "local_workspace_copy"
    return "report_only"


def build_gray_areas(prompt: str, answers: str, reference_task_id: str, signals: dict[str, bool]) -> list[str]:
    gray: list[str] = []
    merged = f"{prompt}\n{answers}"
    if signals["wants_write"] and not explicit_scope_present(prompt, answers):
        gray.append("write_scope_missing")
    if DEICTIC_HINT_RE.search(merged) and not reference_task_id and not explicit_scope_present(prompt, answers):
        gray.append("target_reference_missing")
    if not prompt.strip():
        gray.append("empty_prompt")
    return gray


def clarification_questions(gray_areas: list[str], signals: dict[str, bool]) -> list[str]:
    questions: list[str] = []
    if "target_reference_missing" in gray_areas:
        questions.append("你指的是哪个具体对象？请给出文件、目录、工作区，或提供 reference_task_id。")
    if "write_scope_missing" in gray_areas:
        questions.append("如果允许修改，请明确允许改动的文件或目录范围；如果只想先分析，也可以直接说明“先只读总结”。")
    if signals["wants_write"] and not signals["wants_local_workspace_copy"] and not signals["wants_cpu_eval"]:
        questions.append("这次是希望先做本地副本修复方案，还是只整理可执行 task contract？")
    return questions[:INTAKE_QUESTION_MAX]


def intake_risk_class(objective: str, signals: dict[str, bool]) -> str:
    if objective in {"external_send", "promotion_apply", "training", "gpu"} or signals["wants_secret_or_service"]:
        return "high"
    if objective in {"bounded_gpu_probe", "bounded_training_canary", "local_workspace_copy", "bounded_cpu_eval"}:
        return "medium"
    return "low"


def make_task_contract(
    *,
    intake_id: str,
    project: Project,
    prompt: str,
    answers: str,
    objective: str,
    mode: str,
    reference_task_id: str,
    risk_class: str,
    signals: dict[str, bool],
    status: str,
) -> dict[str, Any]:
    decision_source = "user+answers" if answers else "user"
    requires_human = risk_class == "high"
    write_scope = []
    if objective == "local_workspace_copy":
        write_scope = ["workspace/<task_id>/", "runs/<task_id>/", "agent/status/", "agent/reports/"]
    return {
        "schema_version": 1,
        "intake_id": intake_id,
        "workspace": project.name,
        "status": status,
        "objective": objective,
        "mode": mode,
        "risk_class": risk_class,
        "decision_source": decision_source,
        "requires_human": requires_human,
        "reference_task_id": reference_task_id or "",
        "prompt": prompt,
        "answers_summary": answers,
        "summary": prompt_preview(prompt),
        "write_scope": write_scope,
        "blocked_actions": [
            "shared_file_promotion_without_human_review",
            "dataset_or_checkpoint_mutation",
            "external_send_without_human_review",
            "service_or_secret_mutation",
        ],
        "signals": signals,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def make_taskbox_draft(contract: dict[str, Any]) -> dict[str, Any]:
    objective = str(contract.get("objective") or "")
    if objective == "report_only":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "ready",
            "allowed_runner": "report_only",
            "workspace_mode": "readonly",
            "allowed_write_paths": [],
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Report-only clarification result; no execution side effects.",
        }
    if objective == "bounded_cpu_eval":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "ready",
            "allowed_runner": "cpu",
            "workspace_mode": "readonly",
            "allowed_write_paths": ["runs/<task_id>/", "agent/status/", "agent/reports/"],
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Bounded CPU evaluation or smoke-check task.",
        }
    if objective == "local_workspace_copy":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "ready",
            "allowed_runner": "cpu",
            "workspace_mode": "project_local_copy",
            "allowed_write_paths": contract.get("write_scope", []),
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Project-local copy task; shared files remain protected.",
        }
    return {
        "schema_version": 1,
        "intake_id": contract["intake_id"],
        "status": "blocked",
        "allowed_runner": "none",
        "workspace_mode": "none",
        "allowed_write_paths": [],
        "blocked_actions": contract.get("blocked_actions", []),
        "summary": "High-risk or nondelegable task; requires human approval before execution.",
    }


def make_policy_preflight(project: Project, contract: dict[str, Any], taskbox: dict[str, Any], questions: list[str]) -> dict[str, Any]:
    objective = str(contract.get("objective") or "")
    risk_class = str(contract.get("risk_class") or "low")
    blocked_by: list[str] = []
    reasons: list[str] = []
    if questions:
        blocked_by.append("clarification_required")
        reasons.append("Task intent still has unresolved gray areas.")
    if risk_class == "high":
        blocked_by.append("human_review_required")
        reasons.append(f"Objective {objective} is intentionally held for human approval.")
    if str(contract.get("mode") or "") not in project.allowed_modes:
        blocked_by.append("workspace_mode_not_allowed")
        reasons.append(f"Workspace {project.name} does not allow mode={contract.get('mode')}.")
    if objective not in {"report_only", "bounded_cpu_eval", "local_workspace_copy"} and risk_class != "high":
        blocked_by.append("unsupported_objective")
        reasons.append(f"Objective {objective} is not yet supported by the prepare pipeline.")
    ok = not blocked_by
    decision = "ready" if ok else "blocked"
    required_action = "run" if ok else ("reply_to_questions" if "clarification_required" in blocked_by else "human_review")
    return {
        "schema_version": 1,
        "intake_id": contract["intake_id"],
        "ok": ok,
        "decision": decision,
        "blocked_by": blocked_by,
        "required_action": required_action,
        "reasons": reasons,
        "allowed_runner": taskbox.get("allowed_runner"),
        "workspace_mode": taskbox.get("workspace_mode"),
    }


def intake_summary_markdown(contract: dict[str, Any], questions: list[str], preflight: dict[str, Any]) -> str:
    lines = [
        "# Task Contract Summary",
        "",
        f"- intake_id: {contract.get('intake_id')}",
        f"- workspace: {contract.get('workspace')}",
        f"- objective: {contract.get('objective')}",
        f"- risk_class: {contract.get('risk_class')}",
        f"- decision_source: {contract.get('decision_source')}",
        f"- status: {contract.get('status')}",
        f"- preflight_ok: {'true' if preflight.get('ok') else 'false'}",
        "",
        "## Prompt",
        "",
        str(contract.get("prompt") or ""),
        "",
    ]
    answers = str(contract.get("answers_summary") or "")
    if answers:
        lines.extend(["## Answers", "", answers, ""])
    if questions:
        lines.append("## Pending Questions")
        lines.append("")
        for idx, question in enumerate(questions, start=1):
            lines.append(f"{idx}. {question}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def persist_intake_artifacts(
    *,
    config: BridgeConfig,
    intake_id: str,
    intent: dict[str, Any],
    gray_areas: list[str],
    questions: list[str],
    contract: dict[str, Any],
    taskbox: dict[str, Any],
    preflight: dict[str, Any],
    answers: str,
    event_type: str,
) -> None:
    root = intake_dir(config, intake_id)
    write_json_atomic(root / "INTENT_DRAFT.json", intent)
    write_json_atomic(root / "GRAY_AREAS.json", {"schema_version": 1, "intake_id": intake_id, "items": gray_areas})
    write_text_atomic(
        root / "QUESTIONS.md",
        "\n".join(
            ["# Clarification Questions", ""] +
            ([f"{idx}. {question}" for idx, question in enumerate(questions, start=1)] if questions else ["No pending clarification questions."])
        ).rstrip() + "\n",
    )
    if answers:
        append_jsonl(root / "ANSWERS.jsonl", {"received_at": utc_now().isoformat().replace("+00:00", "Z"), "text": answers})
    write_json_atomic(root / "TASK_CONTRACT.json", contract)
    write_json_atomic(root / "TASKBOX_DRAFT.json", taskbox)
    write_json_atomic(root / "POLICY_PREFLIGHT.json", preflight)
    write_text_atomic(
        root / "ASSUMPTIONS.md",
        "\n".join([
            "# Assumptions",
            "",
            f"- objective_guess: {contract.get('objective')}",
            f"- risk_class: {contract.get('risk_class')}",
            f"- workspace_mode: {taskbox.get('workspace_mode')}",
        ]).rstrip() + "\n",
    )
    write_text_atomic(root / f"TASK_CONTRACT_{intake_id}.md", intake_summary_markdown(contract, questions, preflight))
    append_jsonl(
        root / "TASK_INTAKE.events.jsonl",
        {
            "event": event_type,
            "intake_id": intake_id,
            "status": contract.get("status"),
            "objective": contract.get("objective"),
            "risk_class": contract.get("risk_class"),
            "preflight_ok": preflight.get("ok"),
            "timestamp": utc_now().isoformat().replace("+00:00", "Z"),
        },
    )


def handle_codex_prepare(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    reject_frontend_identity(payload)
    intake_id = (payload.get("intake_id") or "").strip()
    existing_intent: dict[str, Any] = {}
    if intake_id:
        intake_id = validate_intake_id(intake_id)
        existing_intent = load_intake_intent(config, intake_id)
    else:
        intake_id = new_intake_id()

    project_name = (payload.get("workspace") or payload.get("project", "")).strip() or str(existing_intent.get("workspace") or "")
    prompt = safe_intake_text(payload.get("prompt", "") or str(existing_intent.get("prompt") or ""), MAX_TASK_CHARS)
    if not prompt:
        raise BridgeError("prompt is required", 400, "invalid_request")
    project = validate_codex_project(config, project_name)
    mode = (payload.get("mode") or str(existing_intent.get("desired_mode") or "") or project.default_mode).strip() or project.default_mode
    if mode not in project.allowed_modes:
        allowed = ", ".join(project.allowed_modes)
        raise BridgeError(f"mode {mode} is not allowed for workspace {project.name}; allowed: {allowed}", 400, "invalid_request")

    answers = intake_answers_text(payload)
    reference_task_id = (payload.get("reference_task_id") or payload.get("referenceTaskId") or str(existing_intent.get("reference_task_id") or "")).strip()
    if reference_task_id:
        reference_task_id = validate_task_id(reference_task_id)
        authorize_codex_task(config, principal, reference_task_id)

    source = safe_adapter_source(payload.get("source", "web"))
    signals = parse_intent_signals(prompt, answers)
    objective = infer_objective(signals)
    gray_areas = build_gray_areas(prompt, answers, reference_task_id, signals)
    questions = clarification_questions(gray_areas, signals)
    risk_class = intake_risk_class(objective, signals)
    status = "blocked" if risk_class == "high" else ("clarifying" if questions else "compiled")
    contract = make_task_contract(
        intake_id=intake_id,
        project=project,
        prompt=prompt,
        answers=answers,
        objective=objective,
        mode=mode,
        reference_task_id=reference_task_id,
        risk_class=risk_class,
        signals=signals,
        status=status,
    )
    taskbox = make_taskbox_draft(contract)
    preflight = make_policy_preflight(project, contract, taskbox, questions)
    intent = {
        "schema_version": 1,
        "intake_id": intake_id,
        "workspace": project.name,
        "source": source,
        "user": principal.user,
        "reference_task_id": reference_task_id or "",
        "prompt": prompt,
        "prompt_preview": prompt_preview(prompt),
        "desired_mode": mode,
        "status": status,
        "objective_guess": objective,
        "signals": signals,
        "gray_area_count": len(gray_areas),
        "answers_count": 1 if answers else 0,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }
    persist_intake_artifacts(
        config=config,
        intake_id=intake_id,
        intent=intent,
        gray_areas=gray_areas,
        questions=questions,
        contract=contract,
        taskbox=taskbox,
        preflight=preflight,
        answers=answers,
        event_type="intake_replied" if answers else "intake_created",
    )
    return {
        "ok": True,
        "intake_id": intake_id,
        "workspace": project.name,
        "status": "blocked" if risk_class == "high" else ("need_user_reply" if questions else ("blocked" if not preflight.get("ok") else "prepared")),
        "questions": questions,
        "gray_areas": gray_areas,
        "contract": contract,
        "taskbox": taskbox,
        "preflight": preflight,
        "artifacts_dir": str(intake_dir(config, intake_id)),
        "ready_to_run": bool(preflight.get("ok") and not questions),
    }


def safe_adapter_source(value: str) -> str:
    source = (value or "web").strip() or "web"
    if not re.match(r"^[A-Za-z0-9_.-]{1,32}$", source):
        raise BridgeError("source must be 1-32 safe characters", 400, "invalid_request")
    return source


def safe_idempotency_key(value: str) -> str:
    key = (value or "").strip()
    if not key:
        return ""
    if not re.match(r"^[A-Za-z0-9_.:@/-]{1,160}$", key):
        raise BridgeError("idempotency_key contains unsafe characters", 400, "invalid_request")
    return key


def parse_adapter_metadata(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        data = json.loads(value)
    except json.JSONDecodeError as exc:
        raise BridgeError(f"metadata must be a JSON object: {exc}", 400, "invalid_request") from exc
    if not isinstance(data, dict):
        raise BridgeError("metadata must be a JSON object", 400, "invalid_request")
    return data


def compact_adapter_metadata(value: str) -> str:
    data = parse_adapter_metadata(value)
    if not data:
        return ""
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > 2000:
        raise BridgeError("metadata is too large", 400, "invalid_request")
    return text


def parse_run_receipt(output: str) -> dict[str, Any]:
    return {
        "idempotent_replay": bool(re.search(r"^idempotent=true$", output, re.MULTILINE)),
    }


def handle_codex_run(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    reject_frontend_identity(payload)
    project = (payload.get("workspace") or payload.get("project", "")).strip()
    prompt = payload.get("prompt", "").strip()
    project_item = validate_codex_project(config, project)
    mode = (payload.get("mode") or project_item.default_mode).strip() or project_item.default_mode
    if mode not in project_item.allowed_modes:
        allowed = ", ".join(project_item.allowed_modes)
        raise BridgeError(f"mode {mode} is not allowed for workspace {project}; allowed: {allowed}", 400, "invalid_request")
    if not prompt:
        raise BridgeError("prompt is required")
    if len(prompt) > MAX_TASK_CHARS:
        raise BridgeError(f"prompt is too long; max {MAX_TASK_CHARS} chars")

    source = safe_adapter_source(payload.get("source", "web"))
    idempotency_key = safe_idempotency_key(payload.get("idempotency_key", ""))
    metadata = compact_adapter_metadata(payload.get("metadata", ""))
    reference_task_id = (payload.get("reference_task_id") or payload.get("referenceTaskId") or "").strip()
    if reference_task_id:
        reference_task_id = validate_task_id(reference_task_id)
        authorize_codex_task(config, principal, reference_task_id)
    args = ["run", "--project", project, "--mode", mode, "--user", principal.user]
    args.extend(["--source", source])
    args.extend(["--source-user-id", payload.get("source_user_id") or principal.user])
    if payload.get("source_channel_id"):
        args.extend(["--source-channel-id", payload["source_channel_id"]])
    if payload.get("source_message_id"):
        args.extend(["--source-message-id", payload["source_message_id"]])
    if idempotency_key:
        args.extend(["--idempotency-key", idempotency_key])
    if reference_task_id:
        args.extend(["--reference-task-id", reference_task_id])
    if metadata:
        args.extend(["--metadata", metadata])
    if bool_from_payload(payload.get("dry_run", "")):
        args.append("--dry-run")
    args.append(prompt)

    output = require_success(run_codex_bridge(config, args))
    task_id = parse_queued_task_id(output)
    receipt = parse_run_receipt(output)
    return {
        "ok": True,
        "task_id": task_id,
        "status": "queued",
        "mode": mode,
        "source": source,
        "reference_task_id": reference_task_id or None,
        "idempotent_replay": receipt["idempotent_replay"],
        "output": output,
        "status_url": f"/codex/status?task_id={task_id}",
        "result_url": f"/codex/result?task_id={task_id}",
        "logs_url": f"/codex/logs?task_id={task_id}",
    }


def handle_codex_query(
    payload: dict[str, str],
    config: BridgeConfig,
    command: str,
    principal: AuthPrincipal,
) -> dict[str, Any]:
    reject_frontend_identity(payload)
    task_id = validate_task_id(payload.get("task_id", ""))
    _task_dir, task = authorize_codex_task(config, principal, task_id)
    raw_requested = bool_from_payload(payload.get("raw", ""))
    if raw_requested and not is_admin(principal):
        raise BridgeError("raw output requires admin role", 403)
    if command == "cancel" and str(task.get("status", "")) in CODEX_FINAL_STATUSES:
        raise BridgeError(
            f"task already finished with status={task.get('status')}",
            409,
            "task_already_finished",
        )
    args = [command, task_id]
    if command in {"result", "logs"}:
        args.append("--json-output")
        if raw_requested:
            args.append("--raw")
    if command == "logs":
        args.extend(["--tail", payload.get("tail", "80")])
        if payload.get("max_chars"):
            args.extend(["--max-chars", payload["max_chars"]])
    elif command == "result" and payload.get("max_chars"):
        args.extend(["--max-chars", payload["max_chars"]])
    output = require_success(run_codex_bridge(config, args))
    if command in {"result", "logs"}:
        try:
            rendered = json.loads(output)
        except json.JSONDecodeError as exc:
            raise BridgeError(f"codex-bridge returned invalid JSON: {exc}", 500) from exc
        rendered.update({
            "ok": True,
            "task_id": task_id,
            "command": command,
            "user": principal.user,
        })
        return rendered
    return {
        "ok": True,
        "task_id": task_id,
        "command": command,
        "user": principal.user,
        "text": safe_codex_status_text(config, task, output) if command == "status" else output,
    }


def parse_positive_int(value: str | None, default: int, max_value: int, field: str) -> int:
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise BridgeError(f"{field} must be a number", 400, "invalid_request") from exc
    if parsed < 1:
        raise BridgeError(f"{field} must be at least 1", 400, "invalid_request")
    return min(parsed, max_value)


def paginate_text(text: str, page: int, page_size: int) -> dict[str, Any]:
    value = str(text or "")
    total_chars = len(value)
    total_pages = max(1, (total_chars + page_size - 1) // page_size)
    if page > total_pages:
        raise BridgeError(f"page out of range; total_pages={total_pages}", 400, "invalid_request")
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "total_chars": total_chars,
        "has_next": page < total_pages,
        "has_prev": page > 1,
        "text": value[start:end],
    }


def handle_codex_result_page(
    payload: dict[str, str],
    config: BridgeConfig,
    principal: AuthPrincipal,
) -> dict[str, Any]:
    page = parse_positive_int(payload.get("page"), 1, 1000000, "page")
    page_size = parse_positive_int(payload.get("page_size") or payload.get("pageSize"), RESULT_PAGE_DEFAULT_SIZE, RESULT_PAGE_MAX_SIZE, "page_size")
    result = handle_codex_query(
        {
            "task_id": payload.get("task_id", ""),
            "max_chars": str(RESULT_PAGE_MAX_SIZE * 100),
        },
        config,
        "result",
        principal,
    )
    if result.get("raw"):
        raise BridgeError("result pages only support safe output", 403, "permission_denied")
    page_data = paginate_text(str(result.get("text", "")), page, page_size)
    return {
        "ok": True,
        "task_id": result.get("task_id"),
        "command": "result-page",
        "redacted": bool(result.get("redacted", True)),
        "raw": False,
        "source_truncated": bool(result.get("truncated", False)),
        **page_data,
    }


def cleanup_stream_tokens() -> None:
    now = utc_now()
    with STREAM_TOKEN_LOCK:
        expired = [
            token
            for token, record in STREAM_TOKENS.items()
            if record.get("expires_at_dt") and record["expires_at_dt"] <= now
        ]
        for token in expired:
            STREAM_TOKENS.pop(token, None)


def handle_stream_token(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    reject_frontend_identity(payload)
    task_id = validate_task_id(payload.get("task_id", ""))
    authorize_codex_task(config, principal, task_id)
    cleanup_stream_tokens()
    token = secrets.token_urlsafe(32)
    expires_at = utc_now() + dt.timedelta(seconds=STREAM_TOKEN_TTL_SECONDS)
    with STREAM_TOKEN_LOCK:
        STREAM_TOKENS[token] = {
            "task_id": task_id,
            "user": principal.user,
            "role": principal.role,
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
            "expires_at_dt": expires_at,
        }
    return {
        "ok": True,
        "task_id": task_id,
        "stream_token": token,
        "expires_in": STREAM_TOKEN_TTL_SECONDS,
        "events_url": f"/codex/events?task_id={task_id}&stream_token={token}",
    }


def principal_from_stream_token(task_id: str, stream_token: str) -> AuthPrincipal:
    cleanup_stream_tokens()
    if not stream_token:
        raise BridgeError("unauthorized: stream token required", 401)
    with STREAM_TOKEN_LOCK:
        record = STREAM_TOKENS.get(stream_token)
    if not record:
        raise BridgeError("unauthorized: invalid or expired stream token", 401)
    if record.get("task_id") != task_id:
        raise BridgeError("unauthorized: stream token is not valid for this task", 403)
    return AuthPrincipal(user=str(record.get("user", "")), role=str(record.get("role", "user")))


def remaining_seconds(task: dict[str, Any]) -> int | None:
    deadline = parse_iso_datetime(task.get("deadline_at"))
    if not deadline:
        return None
    return max(0, int((deadline - utc_now()).total_seconds()))


def task_snapshot(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": str(task.get("task_id", "")),
        "project": str(task.get("project", "")),
        "status": str(task.get("status", "")),
        "created_at": str(task.get("created_at", "")),
        "started_at": str(task.get("started_at", "")),
        "updated_at": str(task.get("updated_at", "")),
        "timeout_seconds": task.get("timeout_seconds"),
        "remaining_sec": remaining_seconds(task),
        "exit_code": task.get("exit_code") if isinstance(task.get("exit_code"), int) else None,
    }


def safe_log_snapshot(config: BridgeConfig, task_id: str) -> dict[str, Any]:
    args = [
        "logs",
        task_id,
        "--json-output",
        "--tail",
        str(SSE_LOG_TAIL_LINES),
        "--max-chars",
        str(SSE_LOG_MAX_CHARS),
    ]
    output = require_success(run_codex_bridge(config, args, timeout=10))
    try:
        data = json.loads(output)
    except json.JSONDecodeError as exc:
        raise BridgeError(f"codex-bridge logs returned invalid JSON: {exc}", 500) from exc
    return data


def has_safe_result(task_dir: Path) -> bool:
    return (task_dir / "result.safe.md").exists() or (task_dir / "result.md").exists()


def redact_url_secrets(text: str) -> str:
    text = re.sub(r"(stream_token=)[^&\s]+", r"\1[REDACTED]", text)
    text = re.sub(r"([?&]token=)[^&\s]+", r"\1[REDACTED]", text)
    return text


def index_html(config: BridgeConfig) -> str:
    projects = sorted(config.projects)
    project_options = "\n".join(
        f'<option value="{html.escape(name)}">{html.escape(name)}</option>' for name in projects
    )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Bridge</title>
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #f6f7f9;
      --fg: #1f2933;
      --muted: #667085;
      --line: #ccd3dd;
      --panel: #ffffff;
      --accent: #2563eb;
      --ok: #0f766e;
      --warn: #9a3412;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #101418;
        --fg: #eef2f6;
        --muted: #aab4c0;
        --line: #344150;
        --panel: #171d24;
        --accent: #60a5fa;
        --ok: #2dd4bf;
        --warn: #fdba74;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--fg);
    }}
    main {{
      width: min(1040px, calc(100vw - 32px));
      margin: 32px auto;
      display: grid;
      grid-template-columns: minmax(320px, 420px) 1fr;
      gap: 16px;
      align-items: start;
    }}
    h1 {{ font-size: 24px; margin: 0 0 16px; letter-spacing: 0; }}
    h2 {{ font-size: 16px; margin: 0 0 12px; letter-spacing: 0; }}
    section {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }}
    label {{
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 12px;
    }}
    input, select, textarea, button {{
      width: 100%;
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--fg);
      padding: 10px 11px;
    }}
    textarea {{ min-height: 160px; resize: vertical; line-height: 1.45; }}
    button {{
      border-color: var(--accent);
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-weight: 650;
    }}
    button:disabled {{
      cursor: wait;
      opacity: 0.65;
    }}
    .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
    .check {{ display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: var(--fg); }}
    .check input {{ width: auto; }}
    .meta {{ color: var(--muted); font-size: 13px; margin: 10px 0 0; overflow-wrap: anywhere; }}
    .pill {{ color: var(--ok); font-weight: 700; }}
    .warn {{ color: var(--warn); }}
    pre {{
      min-height: 360px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      line-height: 1.45;
    }}
    .response-tabs {{ display: flex; gap: 8px; margin-bottom: 10px; }}
    .response-tabs button {{ width: auto; padding: 7px 10px; font-size: 12px; background: transparent; color: var(--fg); border-color: var(--line); }}
    .response-tabs button.active {{ background: var(--accent); color: #ffffff; border-color: var(--accent); }}
    .hidden {{ display: none; }}
    .markdown {{
      min-height: 360px;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }}
    .markdown h1, .markdown h2, .markdown h3 {{ margin: 0.6em 0 0.35em; letter-spacing: 0; }}
    .markdown h1 {{ font-size: 22px; }}
    .markdown h2 {{ font-size: 18px; }}
    .markdown h3 {{ font-size: 15px; }}
    .markdown p {{ margin: 0 0 0.65em; }}
    .markdown ul {{ margin: 0 0 0.65em 1.2em; padding: 0; }}
    .markdown code {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }}
    .markdown pre {{ min-height: 0; margin: 0 0 0.75em; overflow-x: auto; }}
    .live {{
      min-height: 360px;
      max-height: 560px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel), var(--bg) 45%);
      line-height: 1.45;
    }}
    .live-tools {{ display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; color: var(--muted); font-size: 12px; }}
    .live-tools button {{ width: auto; padding: 6px 9px; font-size: 12px; }}
    .live-tools label {{ display: flex; align-items: center; gap: 6px; margin: 0; }}
    .actions {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }}
    .task-panel {{ margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }}
    .task-title {{ display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }}
    .task-title h2 {{ margin: 0; }}
    .small-btn {{ width: auto; padding: 6px 9px; font-size: 12px; line-height: 1.1; }}
    .task-list {{ display: grid; gap: 8px; }}
    .task-empty {{ color: var(--muted); font-size: 13px; }}
    .task-row {{
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px;
      cursor: pointer;
      background: color-mix(in srgb, var(--panel), var(--bg) 25%);
    }}
    .task-row.selected {{ border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }}
    .task-row-top {{ display: flex; justify-content: space-between; gap: 8px; align-items: center; }}
    .task-id {{ font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }}
    .task-preview {{ margin-top: 6px; color: var(--fg); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }}
    .task-meta {{ margin-top: 5px; color: var(--muted); font-size: 12px; }}
    .task-buttons {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }}
    .task-buttons button {{ padding: 6px 5px; font-size: 12px; }}
    .status-badge {{ border-radius: 999px; padding: 3px 7px; font-size: 11px; font-weight: 700; white-space: nowrap; }}
    .status-queued {{ background: #e5e7eb; color: #374151; }}
    .status-running {{ background: #dbeafe; color: #1d4ed8; }}
    .status-done {{ background: #ccfbf1; color: #0f766e; }}
    .status-failed {{ background: #fee2e2; color: #b91c1c; }}
    .status-cancelled {{ background: #fef3c7; color: #92400e; }}
    .status-timeout {{ background: #ffedd5; color: #c2410c; }}
    .status-cancelling {{ background: #e0e7ff; color: #4338ca; }}
    .status-stale {{ background: #f3f4f6; color: #4b5563; }}
    .status-policy_violation {{ background: #fee2e2; color: #991b1b; }}
    @media (max-width: 800px) {{
      main {{ grid-template-columns: 1fr; }}
      .row, .actions {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Codex Bridge</h1>
      <form id="runForm">
        <label>Token<input id="token" name="token" type="password" autocomplete="off" placeholder="Bearer token"></label>
        <div class="meta">Logged in as: <span id="identity">not authenticated</span></div>
        <label>Project<select id="project" name="project">{project_options}</select></label>
        <label>Prompt<textarea id="prompt" name="prompt">请只读检查 README 和 package.json，总结这个项目是什么</textarea></label>
        <label class="check"><input id="dryRun" name="dry_run" type="checkbox"> Dry run</label>
        <button id="runBtn" type="submit">Run</button>
      </form>
      <div class="meta">Task: <span id="taskId">none</span></div>
      <div class="actions">
        <button id="statusBtn" type="button">Status</button>
        <button id="resultBtn" type="button">Result</button>
        <button id="logsBtn" type="button">Logs</button>
        <button id="cancelBtn" type="button">Cancel</button>
      </div>
      <div class="task-panel">
        <div class="task-title">
          <h2>Recent Tasks</h2>
          <button id="refreshTasksBtn" class="small-btn" type="button">Refresh</button>
        </div>
        <div id="taskList" class="task-list">
          <div class="task-empty">Authenticate to load tasks.</div>
        </div>
      </div>
    </section>
    <section>
      <h2>Response</h2>
      <div class="response-tabs">
        <button id="renderedTab" class="active" type="button">Rendered</button>
        <button id="rawTab" type="button">Raw Safe Text</button>
        <button id="liveTab" type="button">Live Logs</button>
      </div>
      <div id="liveTools" class="live-tools hidden">
        <span>Stream: <span id="streamState">disconnected</span></span>
        <label><input id="autoScroll" type="checkbox" checked> Auto-scroll</label>
        <button id="clearLiveBtn" type="button">Clear</button>
        <button id="reconnectBtn" type="button">Reconnect</button>
      </div>
      <div id="renderedOutput" class="markdown">Ready.</div>
      <pre id="output" class="hidden">Ready.</pre>
      <pre id="liveOutput" class="live hidden"></pre>
    </section>
  </main>
  <script>
    const form = document.getElementById("runForm");
    const output = document.getElementById("output");
    const renderedOutput = document.getElementById("renderedOutput");
    const renderedTab = document.getElementById("renderedTab");
    const rawTab = document.getElementById("rawTab");
    const liveTab = document.getElementById("liveTab");
    const liveTools = document.getElementById("liveTools");
    const liveOutput = document.getElementById("liveOutput");
    const streamState = document.getElementById("streamState");
    const autoScroll = document.getElementById("autoScroll");
    const clearLiveBtn = document.getElementById("clearLiveBtn");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const taskId = document.getElementById("taskId");
    const runBtn = document.getElementById("runBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    const identity = document.getElementById("identity");
    const taskList = document.getElementById("taskList");
    const refreshTasksBtn = document.getElementById("refreshTasksBtn");
    const taskStatuses = new Map();
    const fields = ["project", "token"];
    const finalStatuses = new Set(["done", "failed", "cancelled", "timeout", "stale", "policy_violation"]);
    const pollIntervalMs = 1800;
    const maxPolls = 240;
    let responseText = "Ready.";
    let responseMode = "rendered";
    let liveText = "";
    let eventSource = null;
    let currentStreamTask = "";

    function payload(extra = {{}}) {{
      const data = {{
        project: document.getElementById("project").value,
        ...extra
      }};
      return data;
    }}

    function markdownToHTML(text) {{
      const lines = String(text || "").split("\\n");
      let htmlText = "";
      let inCode = false;
      let inList = false;
      let paragraph = [];

      function flushParagraph() {{
        if (paragraph.length) {{
          htmlText += `<p>${{paragraph.join("<br>")}}</p>`;
          paragraph = [];
        }}
      }}
      function closeList() {{
        if (inList) {{
          htmlText += "</ul>";
          inList = false;
        }}
      }}

      for (const rawLine of lines) {{
        const line = rawLine.replace(/\\r$/, "");
        if (line.trim().startsWith("```")) {{
          flushParagraph();
          closeList();
          htmlText += inCode ? "</code></pre>" : "<pre><code>";
          inCode = !inCode;
          continue;
        }}
        if (inCode) {{
          htmlText += `${{escapeHTML(line)}}\\n`;
          continue;
        }}
        if (!line.trim()) {{
          flushParagraph();
          closeList();
          continue;
        }}
        const heading = line.match(/^(#{1,3})\\s+(.+)$/);
        if (heading) {{
          flushParagraph();
          closeList();
          const level = heading[1].length;
          htmlText += `<h${{level}}>${{escapeHTML(heading[2])}}</h${{level}}>`;
          continue;
        }}
        const bullet = line.match(/^[-*]\\s+(.+)$/);
        if (bullet) {{
          flushParagraph();
          if (!inList) {{
            htmlText += "<ul>";
            inList = true;
          }}
          htmlText += `<li>${{escapeHTML(bullet[1])}}</li>`;
          continue;
        }}
        paragraph.push(escapeHTML(line));
      }}
      flushParagraph();
      closeList();
      if (inCode) htmlText += "</code></pre>";
      return htmlText || "Ready.";
    }}

    function paintResponse() {{
      output.textContent = responseText;
      renderedOutput.innerHTML = markdownToHTML(responseText);
      const showRaw = responseMode === "raw";
      const showLive = responseMode === "live";
      output.classList.toggle("hidden", !showRaw);
      renderedOutput.classList.toggle("hidden", showRaw || showLive);
      liveOutput.classList.toggle("hidden", !showLive);
      liveTools.classList.toggle("hidden", !showLive);
      rawTab.classList.toggle("active", showRaw);
      renderedTab.classList.toggle("active", responseMode === "rendered");
      liveTab.classList.toggle("active", showLive);
    }}

    function render(value) {{
      responseText = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      paintResponse();
    }}

    function setStreamState(value) {{
      streamState.textContent = value;
    }}

    function appendLive(line) {{
      const text = String(line || "");
      if (!text) return;
      liveText += text.endsWith("\\n") ? text : `${{text}}\\n`;
      if (liveText.length > 60000) {{
        liveText = `[trimmed live view]\\n${{liveText.slice(-56000)}}`;
      }}
      liveOutput.textContent = liveText;
      if (autoScroll.checked) {{
        liveOutput.scrollTop = liveOutput.scrollHeight;
      }}
    }}

    function closeStream() {{
      if (eventSource) {{
        eventSource.close();
        eventSource = null;
      }}
    }}

    async function connectStream(id, clear = true) {{
      if (!id || id === "none") return;
      closeStream();
      currentStreamTask = id;
      responseMode = "live";
      paintResponse();
      if (clear) {{
        liveText = "";
        liveOutput.textContent = "";
      }}
      setStreamState("requesting token");
      try {{
        const tokenData = await request("/codex/stream-token", {{ task_id: id }});
        const url = `/codex/events?task_id=${{encodeURIComponent(id)}}&stream_token=${{encodeURIComponent(tokenData.stream_token)}}`;
        eventSource = new EventSource(url);
        setStreamState("connecting");

        eventSource.addEventListener("open", () => setStreamState("connected"));
        eventSource.addEventListener("snapshot", (event) => {{
          const data = JSON.parse(event.data);
          appendLive(`[snapshot] ${{data.task_id}} status=${{data.status}} project=${{data.project}}`);
        }});
        eventSource.addEventListener("status", (event) => {{
          const data = JSON.parse(event.data);
          taskStatuses.set(data.task_id, String(data.status || "").toLowerCase());
          updateSelectedTaskControls();
          appendLive(`[status] ${{data.status}}`);
        }});
        eventSource.addEventListener("log", (event) => {{
          const data = JSON.parse(event.data);
          appendLive(data.text || "");
        }});
        eventSource.addEventListener("result", (event) => {{
          const data = JSON.parse(event.data);
          appendLive(`[result] safe result ready for ${{data.task_id}}`);
        }});
        eventSource.addEventListener("done", async (event) => {{
          const data = JSON.parse(event.data);
          setStreamState("completed");
          appendLive(`[done] ${{data.status}}`);
          closeStream();
          await loadTasks();
          await queryForTask("result", data.task_id);
        }});
        eventSource.addEventListener("heartbeat", () => setStreamState("connected"));
        eventSource.addEventListener("error", (event) => {{
          if (event.data) {{
            try {{
              const data = JSON.parse(event.data);
              appendLive(`[error] ${{data.message || event.data}}`);
            }} catch {{
              appendLive(`[error] ${{event.data}}`);
            }}
            setStreamState("error");
          }}
        }});
        eventSource.onerror = () => {{
          if (eventSource) {{
            setStreamState("disconnected");
          }}
        }};
      }} catch (error) {{
        setStreamState("error");
        appendLive(String(error.message || error));
      }}
    }}

    function sleep(ms) {{
      return new Promise((resolve) => setTimeout(resolve, ms));
    }}

    function parseStatus(text) {{
      const match = String(text || "").match(/^status:\\s*([^\\s]+)/m);
      return match ? match[1] : "";
    }}

    function authHeaders(json = true) {{
      const headers = {{}};
      if (json) headers["Content-Type"] = "application/json";
      const token = document.getElementById("token").value.trim();
      if (token) headers["Authorization"] = `Bearer ${{token}}`;
      return headers;
    }}

    function makeIdempotencyKey() {{
      const random =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : `${{Date.now()}}-${{Math.random().toString(16).slice(2)}}`;
      return `web:${{random}}`;
    }}

    function apiErrorMessage(data) {{
      if (data && data.error && data.error.message) return data.error.message;
      if (data && data.text) return data.text;
      if (data && data.error) return JSON.stringify(data.error);
      return JSON.stringify(data);
    }}

    function escapeHTML(value) {{
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({{
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }}[ch]));
    }}

    function taskStatusClass(status) {{
      const safe = String(status || "unknown").toLowerCase();
      if (["queued", "running", "cancelling", "done", "failed", "cancelled", "timeout", "stale", "policy_violation"].includes(safe)) {{
        return `status-${{safe}}`;
      }}
      return "status-queued";
    }}

    function shortTime(value) {{
      return String(value || "").replace("T", " ").replace(/\\.\\d+Z$/, "Z");
    }}

    async function request(path, body) {{
      const response = await fetch(path, {{
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(body)
      }});
      const data = await response.json();
      if (!response.ok || data.ok === false) {{
        throw new Error(apiErrorMessage(data));
      }}
      return data;
    }}

    async function getJson(path) {{
      const response = await fetch(path, {{
        method: "GET",
        headers: authHeaders(false)
      }});
      const data = await response.json();
      if (!response.ok || data.ok === false) {{
        throw new Error(apiErrorMessage(data));
      }}
      return data;
    }}

    async function loadTasks() {{
      if (!document.getElementById("token").value.trim()) {{
        taskList.innerHTML = '<div class="task-empty">Authenticate to load tasks.</div>';
        return;
      }}
      try {{
        const data = await getJson("/codex/tasks?limit=50");
        renderTasks(data.tasks || []);
      }} catch (error) {{
        taskList.innerHTML = `<div class="task-empty">${{escapeHTML(error.message || error)}}</div>`;
      }}
    }}

    function renderTasks(tasks) {{
      taskStatuses.clear();
      if (!tasks.length) {{
        taskList.innerHTML = '<div class="task-empty">No tasks yet.</div>';
        updateSelectedTaskControls();
        return;
      }}
      const selectedId = taskId.textContent.trim();
      taskList.innerHTML = tasks.map((task) => {{
        taskStatuses.set(task.task_id, String(task.status || "").toLowerCase());
        const id = escapeHTML(task.task_id || "");
        const status = escapeHTML(task.status || "unknown");
        const selected = task.task_id === selectedId ? " selected" : "";
        const duration = task.duration_sec === null || task.duration_sec === undefined ? "" : `${{task.duration_sec}}s`;
        const writeInfo = task.mode === "workspace-write"
          ? `write:${{task.changed_files_count ?? 0}}${{task.protected_path_violation ? " protected" : ""}}`
          : "";
        const meta = [task.project, task.source || "unknown", task.mode || "", writeInfo, shortTime(task.created_at), duration].filter(Boolean).join(" | ");
        const canCancel = ["queued", "running"].includes(String(task.status || "").toLowerCase());
        const cancelLabel = String(task.status || "").toLowerCase() === "cancelling" ? "Cancelling" : "Cancel";
        return `
          <div class="task-row${{selected}}" data-task-id="${{id}}">
            <div class="task-row-top">
              <span class="task-id">${{id}}</span>
              <span class="status-badge ${{taskStatusClass(task.status)}}">${{status}}</span>
            </div>
            <div class="task-preview">${{escapeHTML(task.prompt_preview || "(empty prompt)")}}</div>
            <div class="task-meta">${{escapeHTML(meta)}}</div>
            <div class="task-buttons">
              <button type="button" data-command="status">Status</button>
              <button type="button" data-command="result">Result</button>
              <button type="button" data-command="logs">Logs</button>
              <button type="button" data-command="cancel" ${{canCancel ? "" : "disabled"}}>${{cancelLabel}}</button>
            </div>
          </div>
        `;
      }}).join("");
      updateSelectedTaskControls();
    }}

    function updateSelectedTaskControls() {{
      const id = taskId.textContent.trim();
      const status = taskStatuses.get(id);
      const canCancel = Boolean(id && id !== "none" && (!status || ["queued", "running"].includes(status)));
      cancelBtn.disabled = !canCancel;
      cancelBtn.textContent = status === "cancelling" ? "Cancelling" : "Cancel";
    }}

    function selectTask(id, loadResult = false) {{
      taskId.textContent = id;
      taskId.className = "pill";
      for (const row of taskList.querySelectorAll(".task-row")) {{
        row.classList.toggle("selected", row.dataset.taskId === id);
      }}
      updateSelectedTaskControls();
      const status = taskStatuses.get(id);
      if (["queued", "running", "cancelling", "cancel_requested"].includes(status)) {{
        connectStream(id, true);
      }} else if (loadResult) {{
        queryForTask("result", id);
      }}
    }}

    async function whoami() {{
      const response = await fetch("/whoami", {{
        method: "GET",
        headers: authHeaders(false)
      }});
      const data = await response.json();
      if (!response.ok || data.ok === false) {{
        identity.textContent = "not authenticated";
        identity.className = "warn";
        taskList.innerHTML = '<div class="task-empty">Authenticate to load tasks.</div>';
        throw new Error(apiErrorMessage(data));
      }}
      identity.textContent = `${{data.user}} (${{data.role}})`;
      identity.className = "pill";
      await loadTasks();
      return data;
    }}

    form.addEventListener("submit", async (event) => {{
      event.preventDefault();
      runBtn.disabled = true;
      render("Submitting task...");
      try {{
        await whoami();
        const data = await request("/codex/run", payload({{
          prompt: document.getElementById("prompt").value,
          dry_run: document.getElementById("dryRun").checked ? "true" : "false",
          source: "web",
          mode: "readonly",
          source_channel_id: "browser",
          idempotency_key: makeIdempotencyKey(),
          metadata: {{ client: "web-ui" }}
        }}));
        selectTask(data.task_id, false);
        await loadTasks();
        render(`Task ${{data.task_id}} queued.\\n\\nWaiting for final text...`);
        await connectStream(data.task_id, true);
      }} catch (error) {{
        render(String(error.message || error));
      }} finally {{
        runBtn.disabled = false;
      }}
    }});

    async function waitForFinalText(id) {{
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {{
        const statusData = await request("/codex/status", payload({{ task_id: id }}));
        const status = parseStatus(statusData.text);
        const elapsed = `${{attempt + 1}}/${{maxPolls}}`;

        if (status === "done") {{
          const resultData = await request("/codex/result", payload({{ task_id: id }}));
          render(resultData.text || "(empty result)");
          await loadTasks();
          return;
        }}

        if (finalStatuses.has(status)) {{
          const resultData = await request("/codex/result", payload({{ task_id: id }}));
          render(`Task ${{id}} finished with status: ${{status}}\\n\\n${{resultData.text || statusData.text}}`);
          await loadTasks();
          return;
        }}

        render(`Task ${{id}}\\nStatus: ${{status || "unknown"}}\\nPoll: ${{elapsed}}\\n\\n${{statusData.text}}\\n\\nWaiting for final text...`);
        await sleep(pollIntervalMs);
      }}

      render(`Task ${{id}} is still running. Use Status, Result, or Logs to check it later.`);
      await loadTasks();
    }}

    async function queryForTask(command, id) {{
      selectTask(id, false);
      if (!id || id === "none") {{
        render("No task selected.");
        return;
      }}
      if (responseMode === "live") {{
        responseMode = "rendered";
      }}
      render("Loading...");
      try {{
        const data = await request(`/codex/${{command}}`, payload({{ task_id: id }}));
        render(data.text || data);
        if (command === "cancel" || command === "status") await loadTasks();
      }} catch (error) {{
        render(String(error.message || error));
      }}
    }}

    async function query(command) {{
      const id = taskId.textContent.trim();
      await queryForTask(command, id);
    }}

    document.getElementById("statusBtn").addEventListener("click", () => query("status"));
    document.getElementById("resultBtn").addEventListener("click", () => query("result"));
    document.getElementById("logsBtn").addEventListener("click", () => query("logs"));
    document.getElementById("cancelBtn").addEventListener("click", () => query("cancel"));
    renderedTab.addEventListener("click", () => {{
      responseMode = "rendered";
      paintResponse();
    }});
    rawTab.addEventListener("click", () => {{
      responseMode = "raw";
      paintResponse();
    }});
    liveTab.addEventListener("click", () => {{
      responseMode = "live";
      paintResponse();
    }});
    clearLiveBtn.addEventListener("click", () => {{
      liveText = "";
      liveOutput.textContent = "";
    }});
    reconnectBtn.addEventListener("click", () => {{
      const id = taskId.textContent.trim();
      if (id && id !== "none") connectStream(id, false);
    }});
    refreshTasksBtn.addEventListener("click", () => loadTasks());
    taskList.addEventListener("click", (event) => {{
      const row = event.target.closest(".task-row");
      if (!row) return;
      const id = row.dataset.taskId;
      const button = event.target.closest("button[data-command]");
      if (button) {{
        event.stopPropagation();
        queryForTask(button.dataset.command, id);
        return;
      }}
      selectTask(id, true);
    }});

    for (const id of fields) {{
      const saved = sessionStorage.getItem(`codexBridge:${{id}}`);
      const el = document.getElementById(id);
      if (saved && el) el.value = saved;
      if (el) el.addEventListener("change", () => {{
        sessionStorage.setItem(`codexBridge:${{id}}`, el.value);
        if (id === "token") whoami().catch(() => {{}});
        if (id === "project") loadTasks().catch(() => {{}});
      }});
    }}
    if (document.getElementById("token").value.trim()) whoami().catch(() => {{}});
    updateSelectedTaskControls();
    paintResponse();
    loadTasks().catch(() => {{}});
  </script>
</body>
</html>
"""


class WatchdogBridgeHandler(BaseHTTPRequestHandler):
    config: BridgeConfig

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), redact_url_secrets(fmt % args)))

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_api_error(self, exc: BridgeError | Exception, status: int | None = None) -> None:
        if isinstance(exc, BridgeError):
            self.send_json(status or exc.status, api_error_payload(exc))
        else:
            self.send_json(status or 500, api_error_payload(exc))

    def send_html(self, status: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_sse_event(self, event: str, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        for line in data.splitlines() or [""]:
            self.wfile.write(f"data: {line}\n".encode("utf-8"))
        self.wfile.write(b"\n")
        self.wfile.flush()

    def handle_codex_events(self, payload: dict[str, str]) -> None:
        task_id = validate_task_id(payload.get("task_id", ""))
        principal = principal_from_stream_token(task_id, payload.get("stream_token", ""))
        authorize_codex_task(self.config, principal, task_id)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        last_status = ""
        last_log_text = ""
        sent_snapshot = False
        sent_result = False
        last_heartbeat = 0.0

        while True:
            try:
                task_dir, task = authorize_codex_task(self.config, principal, task_id)
                status = str(task.get("status", ""))

                if not sent_snapshot:
                    self.send_sse_event("snapshot", task_snapshot(task))
                    sent_snapshot = True
                    last_status = status
                elif status != last_status:
                    self.send_sse_event("status", {
                        "task_id": task_id,
                        "status": status,
                        "updated_at": str(task.get("updated_at", "")),
                        "remaining_sec": remaining_seconds(task),
                    })
                    last_status = status

                logs = safe_log_snapshot(self.config, task_id)
                log_text = str(logs.get("text", ""))
                if log_text != last_log_text:
                    if log_text.startswith(last_log_text):
                        delta = log_text[len(last_log_text) :]
                    else:
                        delta = "[log snapshot refreshed]\n" + log_text[-SSE_LOG_EVENT_MAX_CHARS:]
                    if len(delta) > SSE_LOG_EVENT_MAX_CHARS:
                        delta = "[log event trimmed]\n" + delta[-SSE_LOG_EVENT_MAX_CHARS:]
                    if delta.strip():
                        self.send_sse_event("log", {
                            "task_id": task_id,
                            "source": "safe logs",
                            "text": delta,
                            "redacted": bool(logs.get("redacted", True)),
                            "truncated": bool(logs.get("truncated", False)),
                        })
                    last_log_text = log_text

                if not sent_result and has_safe_result(task_dir):
                    self.send_sse_event("result", {
                        "task_id": task_id,
                        "has_result": True,
                        "safe": True,
                    })
                    sent_result = True

                if status in CODEX_FINAL_STATUSES:
                    self.send_sse_event("done", {
                        "task_id": task_id,
                        "status": status,
                        "exit_code": task.get("exit_code") if isinstance(task.get("exit_code"), int) else None,
                    })
                    return

                now = time.monotonic()
                if now - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                    self.send_sse_event("heartbeat", {"ts": utc_now().isoformat().replace("+00:00", "Z")})
                    last_heartbeat = now
                time.sleep(SSE_POLL_SECONDS)
            except (BrokenPipeError, ConnectionResetError):
                return
            except BridgeError as exc:
                self.send_sse_event("error", {"message": str(exc), "status": exc.status})
                return
            except Exception as exc:
                self.send_sse_event("error", {"message": f"bridge error: {exc}", "status": 500})
                return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if parsed.path == "/health/summary":
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                self.send_json(200, handle_health_summary(self.config, principal))
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path == "/whoami":
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                self.send_json(200, {"ok": True, "user": principal.user, "role": principal.role})
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path in {"/", "/codex"}:
            self.send_html(200, index_html(self.config))
            return
        if parsed.path == "/codex/events":
            payload = {key: values[-1] if values else "" for key, values in parse_qs(parsed.query).items()}
            try:
                self.handle_codex_events(payload)
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path == "/codex/workspaces":
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                self.send_json(200, handle_codex_workspaces(self.config, principal))
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path == "/codex/capabilities":
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                self.send_json(200, handle_codex_capabilities(self.config, principal))
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path == "/codex/tasks":
            payload = {key: values[-1] if values else "" for key, values in parse_qs(parsed.query).items()}
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                self.send_json(200, handle_codex_tasks(payload, self.config, principal))
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path == "/codex/result-page":
            payload = {key: values[-1] if values else "" for key, values in parse_qs(parsed.query).items()}
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                self.send_json(200, handle_codex_result_page(payload, self.config, principal))
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path in {"/codex/status", "/codex/result", "/codex/logs", "/codex/cancel"}:
            payload = {key: values[-1] if values else "" for key, values in parse_qs(parsed.query).items()}
            try:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                command = parsed.path.rsplit("/", 1)[-1]
                self.send_json(200, handle_codex_query(payload, self.config, command, principal))
            except BridgeError as exc:
                self.send_api_error(exc)
            except Exception as exc:
                self.send_api_error(exc)
            return
        if parsed.path.startswith("/codex"):
            self.send_api_error(BridgeError("not found", 404, "invalid_request"))
        else:
            self.send_json(404, mattermost_response("not found"))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        if route not in {
            "/mattermost/watchdog",
            "/codex/prepare",
            "/codex/run",
            "/codex/status",
            "/codex/result",
            "/codex/logs",
            "/codex/cancel",
            "/codex/result-page",
            "/codex/stream-token",
        }:
            if route.startswith("/codex"):
                self.send_api_error(BridgeError("not found", 404, "invalid_request"))
            else:
                self.send_json(404, mattermost_response("not found"))
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY_BYTES:
            self.send_json(413, mattermost_response("request body too large"))
            return
        raw = self.rfile.read(length)

        try:
            payload = parse_body(self.headers.get("Content-Type", ""), raw)
            if route == "/mattermost/watchdog":
                response = handle_watchdog(payload, self.config)
            else:
                principal = authenticate_bearer(self.headers.get("Authorization", ""), self.config)
                if route == "/codex/prepare":
                    response = handle_codex_prepare(payload, self.config, principal)
                    self.send_json(200, response)
                    return
                if route == "/codex/run":
                    response = handle_codex_run(payload, self.config, principal)
                    self.send_json(200, response)
                    return
                if route == "/codex/stream-token":
                    response = handle_stream_token(payload, self.config, principal)
                    self.send_json(200, response)
                    return
                if route == "/codex/result-page":
                    response = handle_codex_result_page(payload, self.config, principal)
                    self.send_json(200, response)
                    return
                command = route.rsplit("/", 1)[-1]
                response = handle_codex_query(payload, self.config, command, principal)
            self.send_json(200, response)
        except BridgeError as exc:
            if route == "/mattermost/watchdog":
                self.send_json(exc.status, mattermost_response(str(exc)))
            else:
                self.send_api_error(exc)
        except Exception as exc:  # Keep webhook failures visible but bounded.
            if route == "/mattermost/watchdog":
                self.send_json(500, {"ok": False, "text": f"bridge error: {exc}"})
            else:
                self.send_api_error(exc)


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


def validate_check_config(config: BridgeConfig) -> list[tuple[str, bool, str]]:
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
            project.default_mode in project.allowed_modes and set(project.allowed_modes).issubset(SUPPORTED_CODEX_MODES),
            f"default={project.default_mode} allowed={','.join(project.allowed_modes)}",
        )

    bridge_script = config.codex_bridge_root / "scripts" / "codex-bridge.js"
    add("codex-bridge script exists", bridge_script.exists(), str(bridge_script))
    state_dir = config.codex_bridge_root / ".codex-bridge" / "tasks"
    writable, detail = writable_directory_check(state_dir)
    add("codex task directory writable", writable, detail)
    add("node executable configured", bool(config.codex_bridge_node_bin), config.codex_bridge_node_bin)
    return checks


def check_config(config: BridgeConfig) -> int:
    failed = False
    for name, ok, detail in validate_check_config(config):
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


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config(Path(args.config))

    if args.check_config:
        return check_config(config)

    handler = type("ConfiguredWatchdogBridgeHandler", (WatchdogBridgeHandler,), {"config": config})
    server = ThreadingHTTPServer((config.host, config.port), handler)
    print(f"watchdog bridge listening on http://{config.host}:{config.port}/mattermost/watchdog", flush=True)
    print(f"codex bridge web UI listening on http://{config.host}:{config.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", file=sys.stderr)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
