#!/usr/bin/env python3
"""Mattermost -> Watchdog task bridge.

This is intentionally a task intake service, not a remote shell. It accepts a
small `/watchdog ...` command surface and writes JSON task files into a
whitelisted project's `agent/inbox/` directory for the project's watchdog to
judge later.
"""

from __future__ import annotations

import datetime as dt
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
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from evidence_retrieval import maybe_run_evidence_retrieval
from execution_evaluation import (
    ExecutionEvaluationDependencies,
    maybe_attach_execution_evaluation,
)
from http_routes import HttpRouteDependencies, dispatch_get, dispatch_post
from result_streaming import (
    StreamLoopDependencies,
    cleanup_stream_tokens as cleanup_stream_token_records,
    issue_stream_token,
    redact_url_secrets,
    remaining_seconds as compute_remaining_seconds,
    resolve_stream_principal,
    safe_log_snapshot as load_safe_log_snapshot,
    stream_task_events,
    task_snapshot as build_task_snapshot,
)
from web_ui import render_index_html
from prepared_context import (
    count_jsonl_records,
    filter_source_task_artifact,
    load_intake_questions_from_sources,
    prepared_run_prompt,
    prepared_run_summary,
)
from prepare_intent import (
    build_experiment_decision_gate,
    build_gray_areas,
    clarification_questions,
    evidence_retrieval_summary,
    infer_objective,
    intake_risk_class,
    parse_intent_signals,
    read_plan_markdown,
    should_consult_evidence_index,
)
from startup_runtime import build_parser, check_config, serve_bridge


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


def task_adapter_metadata(task: dict[str, Any]) -> dict[str, Any]:
    raw = task.get("adapter_metadata")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if isinstance(data, dict):
            return data
    return {}


def task_intake_id(task: dict[str, Any]) -> str:
    value = str(task_adapter_metadata(task).get("intake_id") or "").strip()
    if value and INTAKE_ID_RE.match(value):
        return value
    return ""


def is_admin(principal: AuthPrincipal) -> bool:
    return principal.role.lower() == "admin"


def can_access_task(task: dict[str, Any], principal: AuthPrincipal) -> bool:
    if is_admin(principal):
        return True
    return str(task.get("user", "")) == principal.user


def can_access_intake(intent: dict[str, Any], principal: AuthPrincipal) -> bool:
    if is_admin(principal):
        return True
    return str(intent.get("user", "")) == principal.user


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
        "commands": ["prepare", "intake", "run", "tasks", "status", "result", "logs", "cancel"],
        "features": {
            "auth": True,
            "safe_output": True,
            "sse": True,
            "cancel": True,
            "timeout": True,
            "resume": False,
            "write_mode": write_mode,
            "prepare_intake": True,
            "intake_lookup": True,
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


def load_intake_json_artifact(config: BridgeConfig, intake_id: str, filename: str) -> dict[str, Any]:
    path = intake_dir(config, intake_id) / filename
    if not path.exists():
        raise BridgeError(f"intake artifact is missing: {intake_id}/{filename}", 409, "prepare_artifact_missing")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise BridgeError(f"intake artifact is invalid: {intake_id}/{filename}: {exc}", 500) from exc
    if not isinstance(data, dict):
        raise BridgeError(f"intake artifact is invalid: {intake_id}/{filename}", 500)
    return data


def load_optional_intake_json_artifact(config: BridgeConfig, intake_id: str, filename: str) -> dict[str, Any] | None:
    path = intake_dir(config, intake_id) / filename
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise BridgeError(f"intake artifact is invalid: {intake_id}/{filename}: {exc}", 500) from exc
    if not isinstance(data, dict):
        raise BridgeError(f"intake artifact is invalid: {intake_id}/{filename}", 500)
    return data


def load_intake_questions(config: BridgeConfig, intake_id: str) -> list[str]:
    questions_data = load_optional_intake_json_artifact(config, intake_id, "QUESTIONS.json")
    path = intake_dir(config, intake_id) / "QUESTIONS.md"
    questions_markdown = path.read_text() if path.exists() else ""
    return load_intake_questions_from_sources(questions_data, questions_markdown)


def load_prepared_run_context(config: BridgeConfig, intake_id: str, principal: AuthPrincipal) -> dict[str, Any]:
    intent = load_intake_intent(config, intake_id)
    if not can_access_intake(intent, principal):
        raise BridgeError(f"permission denied for intake: {intake_id}", 403, "permission_denied")
    contract = load_intake_json_artifact(config, intake_id, "TASK_CONTRACT.json")
    taskbox = load_intake_json_artifact(config, intake_id, "TASKBOX_DRAFT.json")
    preflight = load_intake_json_artifact(config, intake_id, "POLICY_PREFLIGHT.json")
    evidence = load_intake_json_artifact(config, intake_id, "EVIDENCE_RETRIEVAL.json")
    return {
        "intake_id": intake_id,
        "intent": intent,
        "contract": contract,
        "taskbox": taskbox,
        "preflight": preflight,
        "evidence_retrieval": evidence,
    }


def handle_codex_intake(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    reject_frontend_identity(payload)
    intake_id = validate_intake_id((payload.get("intake_id") or "").strip())
    bundle = load_prepared_run_context(config, intake_id, principal)
    root = intake_dir(config, intake_id)
    gray_areas_artifact = load_optional_intake_json_artifact(config, intake_id, "GRAY_AREAS.json") or {}
    decision_gate = load_optional_intake_json_artifact(config, intake_id, "DECISION_GATE.json") or {}
    questions = load_intake_questions(config, intake_id)
    execution_evaluation = load_optional_intake_json_artifact(config, intake_id, "EXECUTION_EVALUATION.json")
    followup_task_draft = load_optional_intake_json_artifact(config, intake_id, "FOLLOWUP_TASK_DRAFT.json")
    ledger_note_draft = load_optional_intake_json_artifact(config, intake_id, "LEDGER_NOTE_DRAFT.json")
    review_proposal_draft = load_optional_intake_json_artifact(config, intake_id, "REVIEW_PROPOSAL_DRAFT.json")
    events_path = root / "TASK_INTAKE.events.jsonl"
    event_count = count_jsonl_records(events_path.read_text() if events_path.exists() else "")
    return {
        "ok": True,
        "intake_id": intake_id,
        "intent": bundle["intent"],
        "gray_areas": list(gray_areas_artifact.get("items") or []),
        "questions": questions,
        "contract": bundle["contract"],
        "taskbox": bundle["taskbox"],
        "preflight": bundle["preflight"],
        "decision_gate": decision_gate,
        "evidence_retrieval": bundle["evidence_retrieval"],
        "execution_evaluation": execution_evaluation,
        "followup_task_draft": followup_task_draft,
        "ledger_note_draft": ledger_note_draft,
        "review_proposal_draft": review_proposal_draft,
        "event_count": event_count,
        "ready_to_run": bool(bundle["preflight"].get("ok") and not questions),
    }


def load_followup_prepare_seed(config: BridgeConfig, followup_task_id: str, principal: AuthPrincipal) -> dict[str, Any]:
    _task_dir, task = authorize_codex_task(config, principal, followup_task_id)
    intake_id = task_intake_id(task)
    if not intake_id:
        raise BridgeError(
            f"follow-up draft is not available for task {followup_task_id}; the task is not linked to a prepared intake",
            409,
            "followup_draft_unavailable",
        )
    draft = load_intake_json_artifact(config, intake_id, "FOLLOWUP_TASK_DRAFT.json")
    if str(draft.get("source_task_id") or "") not in {"", followup_task_id}:
        raise BridgeError(
            f"follow-up draft source does not match task {followup_task_id}",
            409,
            "followup_draft_invalid",
        )
    root = intake_dir(config, intake_id)
    execution_evaluation = filter_source_task_artifact(
        read_json_object_if_exists(root / "EXECUTION_EVALUATION.json"),
        followup_task_id,
        "task_id",
    )
    ledger_note_draft = filter_source_task_artifact(
        read_json_object_if_exists(root / "LEDGER_NOTE_DRAFT.json"),
        followup_task_id,
        "source_task_id",
    )
    review_proposal_draft = filter_source_task_artifact(
        read_json_object_if_exists(root / "REVIEW_PROPOSAL_DRAFT.json"),
        followup_task_id,
        "source_task_id",
    )
    return {
        "task_id": followup_task_id,
        "source_intake_id": intake_id,
        "task": task,
        "draft": draft,
        "execution_evaluation": execution_evaluation,
        "ledger_note_draft": ledger_note_draft,
        "review_proposal_draft": review_proposal_draft,
    }


def read_json_object_if_exists(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if isinstance(data, dict):
        return data
    return {}


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


def execution_evaluation_dependencies() -> ExecutionEvaluationDependencies:
    return ExecutionEvaluationDependencies(
        utc_now=utc_now,
        intake_dir=intake_dir,
        read_json_object_if_exists=read_json_object_if_exists,
        write_json_atomic=write_json_atomic,
        write_text_atomic=write_text_atomic,
        append_jsonl=append_jsonl,
        task_intake_id=task_intake_id,
    )


def safe_intake_text(value: str, max_chars: int = 6000) -> str:
    text = str(value or "").strip()
    if len(text) > max_chars:
        raise BridgeError(f"text is too long; max {max_chars} chars", 400, "invalid_request")
    return text


def intake_answers_text(payload: dict[str, str]) -> str:
    return safe_intake_text(payload.get("answers") or payload.get("answer") or "", 4000)



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
    evidence_retrieval: dict[str, Any],
) -> dict[str, Any]:
    decision_source = "user+answers" if answers else "user"
    requires_human = risk_class == "high"
    decision_gate = build_experiment_decision_gate(prompt, answers, objective, signals)
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
        "experiment_decision_gate": decision_gate,
        "write_scope": write_scope,
        "blocked_actions": [
            "shared_file_promotion_without_human_review",
            "dataset_or_checkpoint_mutation",
            "external_send_without_human_review",
            "service_or_secret_mutation",
        ],
        "evidence_retrieval": evidence_retrieval_summary(evidence_retrieval),
        "signals": signals,
        "updated_at": utc_now().isoformat().replace("+00:00", "Z"),
    }


def make_taskbox_draft(contract: dict[str, Any]) -> dict[str, Any]:
    objective = str(contract.get("objective") or "")
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    retrieval = contract.get("evidence_retrieval") if isinstance(contract.get("evidence_retrieval"), dict) else {}
    gate_required = bool(decision_gate.get("required"))
    gate_blocking = bool(decision_gate.get("blocking"))
    gate_status = "blocked" if gate_blocking else ("required_ready" if gate_required else "not_required")
    if objective == "report_only":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "blocked" if gate_blocking else "ready",
            "allowed_runner": "report_only",
            "workspace_mode": "readonly",
            "allowed_write_paths": [],
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Report-only clarification result; no execution side effects.",
            "experiment_decision_gate": decision_gate,
            "experiment_gate_status": gate_status,
            "evidence_retrieval": retrieval,
        }
    if objective == "bounded_cpu_eval":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "blocked" if gate_blocking else "ready",
            "allowed_runner": "cpu",
            "workspace_mode": "readonly",
            "allowed_write_paths": ["runs/<task_id>/", "agent/status/", "agent/reports/"],
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Bounded CPU evaluation or smoke-check task." if not gate_blocking else "Bounded CPU evaluation draft exists, but experiment decisions are still unresolved.",
            "experiment_decision_gate": decision_gate,
            "experiment_gate_status": gate_status,
            "evidence_retrieval": retrieval,
        }
    if objective == "local_workspace_copy":
        return {
            "schema_version": 1,
            "intake_id": contract["intake_id"],
            "status": "blocked" if gate_blocking else "ready",
            "allowed_runner": "cpu",
            "workspace_mode": "project_local_copy",
            "allowed_write_paths": contract.get("write_scope", []),
            "blocked_actions": contract.get("blocked_actions", []),
            "summary": "Project-local copy task; shared files remain protected." if not gate_blocking else "Project-local copy draft exists, but experiment decisions are still unresolved.",
            "experiment_decision_gate": decision_gate,
            "experiment_gate_status": gate_status,
            "evidence_retrieval": retrieval,
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
        "experiment_decision_gate": decision_gate,
        "experiment_gate_status": gate_status,
        "evidence_retrieval": retrieval,
    }


def make_policy_preflight(
    project: Project,
    contract: dict[str, Any],
    taskbox: dict[str, Any],
    questions: list[str],
    evidence_retrieval: dict[str, Any],
) -> dict[str, Any]:
    objective = str(contract.get("objective") or "")
    risk_class = str(contract.get("risk_class") or "low")
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    blocked_by: list[str] = []
    reasons: list[str] = []
    if questions:
        blocked_by.append("clarification_required")
        reasons.append("Task intent still has unresolved gray areas.")
    if decision_gate.get("required") and decision_gate.get("blocking"):
        blocked_by.append("experiment_decision_gate_required")
        unresolved = ", ".join(str(item) for item in decision_gate.get("unresolved_items", []))
        reasons.append(f"Experiment decision gate is still unresolved: {unresolved}.")
    if risk_class == "high":
        blocked_by.append("human_review_required")
        reasons.append(f"Objective {objective} is intentionally held for human approval.")
    if str(contract.get("mode") or "") not in project.allowed_modes:
        blocked_by.append("workspace_mode_not_allowed")
        reasons.append(f"Workspace {project.name} does not allow mode={contract.get('mode')}.")
    if objective not in {"report_only", "bounded_cpu_eval", "local_workspace_copy"} and risk_class != "high":
        blocked_by.append("unsupported_objective")
        reasons.append(f"Objective {objective} is not yet supported by the prepare pipeline.")
    retrieval_decision = evidence_retrieval.get("decision")
    retrieval_warnings = evidence_retrieval.get("warnings") if isinstance(evidence_retrieval.get("warnings"), list) else []
    if evidence_retrieval.get("required"):
        if evidence_retrieval.get("consulted") and retrieval_decision and retrieval_decision != "safe_to_answer":
            reasons.append(
                f"Evidence retrieval returned decision={retrieval_decision}; keep formal conclusion claims bounded until the referenced evidence is reviewed."
            )
        elif not evidence_retrieval.get("consulted"):
            reasons.append("Evidence retrieval was expected for this request but is not currently available for the selected workspace.")
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
        "experiment_decision_gate_required": bool(decision_gate.get("required")),
        "evidence_retrieval_required": bool(evidence_retrieval.get("required")),
        "evidence_retrieval_consulted": bool(evidence_retrieval.get("consulted")),
        "evidence_retrieval_available": bool(evidence_retrieval.get("available")),
        "evidence_retrieval_decision": retrieval_decision,
        "evidence_retrieval_warnings": retrieval_warnings,
    }


def intake_summary_markdown(contract: dict[str, Any], questions: list[str], preflight: dict[str, Any]) -> str:
    decision_gate = contract.get("experiment_decision_gate") if isinstance(contract.get("experiment_decision_gate"), dict) else {}
    retrieval = contract.get("evidence_retrieval") if isinstance(contract.get("evidence_retrieval"), dict) else {}
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
        f"- experiment_decision_gate_required: {'true' if decision_gate.get('required') else 'false'}",
        f"- evidence_retrieval_required: {'true' if retrieval.get('required') else 'false'}",
        f"- evidence_retrieval_consulted: {'true' if retrieval.get('consulted') else 'false'}",
        f"- evidence_retrieval_decision: {retrieval.get('decision') or 'none'}",
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
    if decision_gate.get("required"):
        lines.append("## Experiment Decision Gate")
        lines.append("")
        lines.append(f"- resolved_count: {decision_gate.get('resolved_count', 0)} / {decision_gate.get('decision_count', 0)}")
        lines.append(f"- blocking: {'true' if decision_gate.get('blocking') else 'false'}")
        for item in decision_gate.get("decisions", []):
            lines.append(
                f"- {item.get('decision_id')}: {item.get('title')} -> {'resolved' if item.get('resolved') else 'missing'}"
            )
        lines.append("")
    if retrieval.get("required"):
        lines.append("## Evidence Retrieval")
        lines.append("")
        lines.append(f"- decision: {retrieval.get('decision') or 'none'}")
        lines.append(f"- available: {'true' if retrieval.get('available') else 'false'}")
        lines.append(f"- consulted: {'true' if retrieval.get('consulted') else 'false'}")
        for warning in retrieval.get("warnings", []):
            lines.append(f"- warning: {warning}")
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
    evidence_retrieval: dict[str, Any],
    answers: str,
    event_type: str,
) -> None:
    root = intake_dir(config, intake_id)
    write_json_atomic(root / "INTENT_DRAFT.json", intent)
    write_json_atomic(root / "GRAY_AREAS.json", {"schema_version": 1, "intake_id": intake_id, "items": gray_areas})
    write_json_atomic(root / "QUESTIONS.json", {"schema_version": 1, "intake_id": intake_id, "items": questions})
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
    write_json_atomic(root / "DECISION_GATE.json", contract.get("experiment_decision_gate", {}))
    write_json_atomic(root / "EVIDENCE_RETRIEVAL.json", evidence_retrieval)
    write_text_atomic(root / "READ_PLAN.md", read_plan_markdown(evidence_retrieval))
    write_text_atomic(
        root / "ASSUMPTIONS.md",
        "\n".join([
            "# Assumptions",
            "",
            f"- objective_guess: {contract.get('objective')}",
            f"- risk_class: {contract.get('risk_class')}",
            f"- workspace_mode: {taskbox.get('workspace_mode')}",
            f"- experiment_decision_gate_required: {'true' if (contract.get('experiment_decision_gate') or {}).get('required') else 'false'}",
            f"- evidence_retrieval_decision: {(evidence_retrieval.get('decision') or 'none')}",
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
            "evidence_retrieval_decision": evidence_retrieval.get("decision"),
            "timestamp": utc_now().isoformat().replace("+00:00", "Z"),
        },
    )


def handle_codex_prepare(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    reject_frontend_identity(payload)
    intake_id = (payload.get("intake_id") or "").strip()
    followup_task_id = (payload.get("followup_task_id") or payload.get("followupTaskId") or "").strip()
    if intake_id and followup_task_id:
        raise BridgeError("intake_id and followup_task_id cannot be used together", 400, "invalid_request")
    existing_intent: dict[str, Any] = {}
    followup_seed: dict[str, Any] = {}
    if intake_id:
        intake_id = validate_intake_id(intake_id)
        existing_intent = load_intake_intent(config, intake_id)
    else:
        intake_id = new_intake_id()
    if followup_task_id:
        followup_task_id = validate_task_id(followup_task_id)
        followup_seed = load_followup_prepare_seed(config, followup_task_id, principal)
    followup_draft = followup_seed.get("draft") if isinstance(followup_seed.get("draft"), dict) else {}

    project_name = (
        (payload.get("workspace") or payload.get("project", "")).strip()
        or str(existing_intent.get("workspace") or "")
        or str(followup_draft.get("workspace") or "")
        or str((followup_seed.get("task") or {}).get("project") or "")
    )
    prompt = safe_intake_text(
        payload.get("prompt", "")
        or str(existing_intent.get("prompt") or "")
        or str(followup_draft.get("prompt") or ""),
        MAX_TASK_CHARS,
    )
    if not prompt:
        raise BridgeError("prompt is required", 400, "invalid_request")
    project = validate_codex_project(config, project_name)
    mode = (
        payload.get("mode")
        or str(existing_intent.get("desired_mode") or "")
        or str(followup_draft.get("suggested_mode") or "")
        or project.default_mode
    ).strip() or project.default_mode
    if mode not in project.allowed_modes:
        allowed = ", ".join(project.allowed_modes)
        raise BridgeError(f"mode {mode} is not allowed for workspace {project.name}; allowed: {allowed}", 400, "invalid_request")

    answers = intake_answers_text(payload)
    reference_task_id = (
        payload.get("reference_task_id")
        or payload.get("referenceTaskId")
        or str(existing_intent.get("reference_task_id") or "")
        or str(followup_draft.get("reference_task_id") or "")
    ).strip()
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
    evidence_retrieval = maybe_run_evidence_retrieval(
        project.root,
        prompt,
        answers,
        objective,
        signals,
        safe_intake_text,
        should_consult_evidence_index,
    )
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
        evidence_retrieval=evidence_retrieval,
    )
    taskbox = make_taskbox_draft(contract)
    preflight = make_policy_preflight(project, contract, taskbox, questions, evidence_retrieval)
    intent = {
        "schema_version": 1,
        "intake_id": intake_id,
        "workspace": project.name,
        "source": source,
        "user": principal.user,
        "reference_task_id": reference_task_id or "",
        "followup_task_id": followup_task_id or "",
        "followup_source_intake_id": str(followup_seed.get("source_intake_id") or ""),
        "prompt": prompt,
        "prompt_preview": prompt_preview(prompt),
        "desired_mode": mode,
        "status": status,
        "objective_guess": objective,
        "signals": signals,
        "gray_area_count": len(gray_areas),
        "experiment_decision_gate_required": bool((contract.get("experiment_decision_gate") or {}).get("required")),
        "evidence_retrieval_required": bool(evidence_retrieval.get("required")),
        "evidence_retrieval_consulted": bool(evidence_retrieval.get("consulted")),
        "evidence_retrieval_decision": evidence_retrieval.get("decision"),
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
        evidence_retrieval=evidence_retrieval,
        answers=answers,
        event_type="intake_replied" if answers and existing_intent else ("intake_created_from_followup" if followup_task_id else "intake_created"),
    )
    return {
        "ok": True,
        "intake_id": intake_id,
        "workspace": project.name,
        "followup_task_id": followup_task_id or None,
        "followup_source_intake_id": str(followup_seed.get("source_intake_id") or "") or None,
        "followup_context": {
            "source_task_id": followup_task_id or None,
            "source_intake_id": str(followup_seed.get("source_intake_id") or "") or None,
            "execution_evaluation": (
                followup_seed.get("execution_evaluation")
                if isinstance(followup_seed.get("execution_evaluation"), dict) and followup_seed.get("execution_evaluation")
                else None
            ),
            "followup_task_draft": followup_draft or None,
            "ledger_note_draft": (
                followup_seed.get("ledger_note_draft")
                if isinstance(followup_seed.get("ledger_note_draft"), dict) and followup_seed.get("ledger_note_draft")
                else None
            ),
            "review_proposal_draft": (
                followup_seed.get("review_proposal_draft")
                if isinstance(followup_seed.get("review_proposal_draft"), dict) and followup_seed.get("review_proposal_draft")
                else None
            ),
        } if followup_task_id else None,
        "status": "blocked" if risk_class == "high" else ("need_user_reply" if questions else ("blocked" if not preflight.get("ok") else "prepared")),
        "questions": questions,
        "gray_areas": gray_areas,
        "decision_gate": contract.get("experiment_decision_gate"),
        "contract": contract,
        "taskbox": taskbox,
        "preflight": preflight,
        "evidence_retrieval": evidence_retrieval,
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
    return compact_adapter_metadata_object(data)


def compact_adapter_metadata_object(data: dict[str, Any]) -> str:
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
    intake_id = (payload.get("intake_id") or "").strip()
    prepared_bundle: dict[str, Any] | None = None
    prepared_intent: dict[str, Any] = {}
    prepared_contract: dict[str, Any] = {}
    prepared_taskbox: dict[str, Any] = {}
    prepared_preflight: dict[str, Any] = {}
    prepared_summary: dict[str, Any] = {}
    if intake_id:
        intake_id = validate_intake_id(intake_id)
        prepared_bundle = load_prepared_run_context(config, intake_id, principal)
        prepared_intent = prepared_bundle["intent"]
        prepared_contract = prepared_bundle["contract"]
        prepared_taskbox = prepared_bundle["taskbox"]
        prepared_preflight = prepared_bundle["preflight"]
        prepared_summary = prepared_run_summary(prepared_bundle)
    project = (payload.get("workspace") or payload.get("project", "")).strip() or str(prepared_intent.get("workspace") or "")
    prompt = safe_intake_text(payload.get("prompt", "") or "", MAX_TASK_CHARS) if payload.get("prompt") else ""
    if not project:
        raise BridgeError("workspace is required", 400, "invalid_request")
    project_item = validate_codex_project(config, project)
    if prepared_intent and project != str(prepared_intent.get("workspace") or ""):
        raise BridgeError(
            f"workspace mismatch for intake {intake_id}: expected {prepared_intent.get('workspace')}",
            409,
            "prepare_workspace_mismatch",
        )
    prepared_mode = str(prepared_contract.get("mode") or prepared_intent.get("desired_mode") or "").strip()
    mode = (payload.get("mode") or prepared_mode or project_item.default_mode).strip() or project_item.default_mode
    if prepared_mode and mode != prepared_mode:
        raise BridgeError(
            f"mode mismatch for intake {intake_id}: expected {prepared_mode}",
            409,
            "prepare_mode_mismatch",
        )
    if mode not in project_item.allowed_modes:
        allowed = ", ".join(project_item.allowed_modes)
        raise BridgeError(f"mode {mode} is not allowed for workspace {project}; allowed: {allowed}", 400, "invalid_request")

    source = safe_adapter_source(payload.get("source", "web"))
    idempotency_key = safe_idempotency_key(payload.get("idempotency_key", ""))
    metadata_obj = parse_adapter_metadata(payload.get("metadata", ""))
    reference_task_id = (
        payload.get("reference_task_id")
        or payload.get("referenceTaskId")
        or str(prepared_intent.get("reference_task_id") or "")
    ).strip()
    if reference_task_id:
        reference_task_id = validate_task_id(reference_task_id)
        authorize_codex_task(config, principal, reference_task_id)
    if prepared_bundle:
        if not prepared_preflight.get("ok") or str(prepared_taskbox.get("status") or "") != "ready":
            reason_text = "; ".join(str(item) for item in prepared_preflight.get("reasons", [])[:2])
            required_action = str(prepared_preflight.get("required_action") or "prepare")
            message = f"prepared intake {intake_id} is not runnable; required_action={required_action}"
            if reason_text:
                message += f"; reasons: {reason_text}"
            raise BridgeError(message, 409, "prepare_not_runnable")
        prompt = prepared_run_prompt(prepared_bundle, prompt, safe_intake_text, MAX_TASK_CHARS)
        metadata_obj.update({
            "intake_id": intake_id,
            "prepared_objective": prepared_summary.get("objective") or "",
            "prepared_workspace_mode": prepared_summary.get("workspace_mode") or "",
            "evidence_retrieval_decision": prepared_summary.get("evidence_retrieval_decision") or "",
        })
    elif not prompt:
        raise BridgeError("prompt is required", 400, "invalid_request")
    metadata = compact_adapter_metadata_object(metadata_obj)
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
    if intake_id:
        append_jsonl(
            intake_dir(config, intake_id) / "TASK_INTAKE.events.jsonl",
            {
                "event": "run_queued",
                "intake_id": intake_id,
                "task_id": task_id,
                "workspace": project_item.name,
                "mode": mode,
                "user": principal.user,
                "timestamp": utc_now().isoformat().replace("+00:00", "Z"),
            },
        )
    return {
        "ok": True,
        "task_id": task_id,
        "status": "queued",
        "mode": mode,
        "source": source,
        "intake_id": intake_id or None,
        "prepare_context": prepared_summary or None,
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
    task_dir, task = authorize_codex_task(config, principal, task_id)
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
        intake_id = task_intake_id(task)
        if command == "result" and not raw_requested:
            rendered.update(
                maybe_attach_execution_evaluation(
                    config,
                    task_dir,
                    task,
                    rendered,
                    execution_evaluation_dependencies(),
                )
            )
        if intake_id:
            rendered["intake_id"] = intake_id
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
        "intake_id": result.get("intake_id"),
        "command": "result-page",
        "redacted": bool(result.get("redacted", True)),
        "raw": False,
        "source_truncated": bool(result.get("truncated", False)),
        "execution_evaluation": result.get("execution_evaluation") if isinstance(result.get("execution_evaluation"), dict) else None,
        "followup_task_draft": result.get("followup_task_draft") if isinstance(result.get("followup_task_draft"), dict) else None,
        "ledger_note_draft": result.get("ledger_note_draft") if isinstance(result.get("ledger_note_draft"), dict) else None,
        "review_proposal_draft": result.get("review_proposal_draft") if isinstance(result.get("review_proposal_draft"), dict) else None,
        **page_data,
    }


def cleanup_stream_tokens() -> None:
    cleanup_stream_token_records(STREAM_TOKENS, STREAM_TOKEN_LOCK, utc_now)


def stream_loop_dependencies(handler: Any) -> StreamLoopDependencies:
    return StreamLoopDependencies(
        authorize_task=authorize_codex_task,
        safe_log_snapshot=safe_log_snapshot,
        has_safe_result=has_safe_result,
        send_sse_event=handler.send_sse_event,
        task_snapshot=task_snapshot,
        remaining_seconds=remaining_seconds,
        utc_now=utc_now,
        monotonic=time.monotonic,
        sleep=time.sleep,
        final_statuses=CODEX_FINAL_STATUSES,
        heartbeat_seconds=SSE_HEARTBEAT_SECONDS,
        poll_seconds=SSE_POLL_SECONDS,
        log_event_max_chars=SSE_LOG_EVENT_MAX_CHARS,
    )


def http_route_dependencies() -> HttpRouteDependencies:
    return HttpRouteDependencies(
        authenticate_bearer=authenticate_bearer,
        handle_health_summary=handle_health_summary,
        handle_codex_workspaces=handle_codex_workspaces,
        handle_codex_capabilities=handle_codex_capabilities,
        handle_codex_tasks=handle_codex_tasks,
        handle_codex_intake=handle_codex_intake,
        handle_codex_result_page=handle_codex_result_page,
        handle_codex_query=handle_codex_query,
        handle_watchdog=handle_watchdog,
        handle_codex_prepare=handle_codex_prepare,
        handle_codex_run=handle_codex_run,
        handle_stream_token=handle_stream_token,
        index_html=index_html,
        parse_body=parse_body,
        mattermost_response=mattermost_response,
        bridge_error_type=BridgeError,
    )


def handle_stream_token(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    reject_frontend_identity(payload)
    task_id = validate_task_id(payload.get("task_id", ""))
    authorize_codex_task(config, principal, task_id)
    cleanup_stream_tokens()
    token_payload = issue_stream_token(
        task_id,
        principal.user,
        principal.role,
        STREAM_TOKENS,
        STREAM_TOKEN_LOCK,
        utc_now,
        STREAM_TOKEN_TTL_SECONDS,
    )
    return {
        "ok": True,
        "task_id": task_id,
        **token_payload,
    }


def principal_from_stream_token(task_id: str, stream_token: str) -> AuthPrincipal:
    user, role = resolve_stream_principal(
        task_id,
        stream_token,
        STREAM_TOKENS,
        STREAM_TOKEN_LOCK,
        utc_now,
        lambda message, status: BridgeError(message, status),
    )
    return AuthPrincipal(user=user, role=role)


def remaining_seconds(task: dict[str, Any]) -> int | None:
    return compute_remaining_seconds(task, parse_iso_datetime, utc_now)


def task_snapshot(task: dict[str, Any]) -> dict[str, Any]:
    return build_task_snapshot(task, remaining_seconds)


def safe_log_snapshot(config: BridgeConfig, task_id: str) -> dict[str, Any]:
    return load_safe_log_snapshot(
        config,
        task_id,
        run_codex_bridge,
        require_success,
        tail_lines=SSE_LOG_TAIL_LINES,
        max_chars=SSE_LOG_MAX_CHARS,
        timeout=10,
        error_factory=lambda message, status: BridgeError(message, status),
    )


def has_safe_result(task_dir: Path) -> bool:
    return (task_dir / "result.safe.md").exists() or (task_dir / "result.md").exists()


def index_html(config: BridgeConfig) -> str:
    return render_index_html(list(config.projects))


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

        try:
            stream_task_events(self.config, task_id, principal, stream_loop_dependencies(self))
        except (BrokenPipeError, ConnectionResetError):
            return
        except BridgeError as exc:
            self.send_sse_event("error", {"message": str(exc), "status": exc.status})
        except Exception as exc:
            self.send_sse_event("error", {"message": f"bridge error: {exc}", "status": 500})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        dispatch_get(
            self,
            path=parsed.path,
            query=parsed.query,
            authorization=self.headers.get("Authorization", ""),
            config=self.config,
            deps=http_route_dependencies(),
        )

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY_BYTES:
            self.send_json(413, mattermost_response("request body too large"))
            return
        raw = self.rfile.read(length)
        dispatch_post(
            self,
            route=route,
            content_type=self.headers.get("Content-Type", ""),
            raw=raw,
            authorization=self.headers.get("Authorization", ""),
            config=self.config,
            deps=http_route_dependencies(),
        )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config(Path(args.config))

    if args.check_config:
        return check_config(config, SUPPORTED_CODEX_MODES)

    return serve_bridge(config, WatchdogBridgeHandler)


if __name__ == "__main__":
    raise SystemExit(main())
