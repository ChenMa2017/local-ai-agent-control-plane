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
import shlex
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from config_loader import (
    load_auth_tokens as parse_auth_tokens_from_config,
    load_config as parse_bridge_config_from_file,
)
from auth_policy import (
    authenticate_bearer as authenticate_bearer_principal,
    can_access_intake as can_access_intake_payload,
    can_access_task as can_access_task_payload,
    is_admin as principal_is_admin,
    reject_frontend_identity as reject_frontend_payload_identity,
    validate_auth as validate_mattermost_auth,
)
from execution_evaluation import (
    ExecutionEvaluationDependencies,
    maybe_attach_execution_evaluation,
)
from http_routes import HttpRouteDependencies, dispatch_get, dispatch_post
from request_contracts import (
    api_error_payload as build_api_error_payload,
    compact_adapter_metadata as compact_adapter_metadata_text,
    compact_adapter_metadata_object as compact_adapter_metadata_mapping,
    error_code_for as resolve_api_error_code,
    mattermost_response as build_mattermost_response,
    parse_adapter_metadata as parse_adapter_metadata_text,
    parse_body as parse_request_body,
    parse_run_receipt as parse_bridge_run_receipt,
    safe_adapter_source as validate_adapter_source,
    safe_idempotency_key as validate_idempotency_key,
)
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
from codex_tasking import (
    CodexTaskListDependencies,
    CodexTaskQueryDependencies,
    authorize_codex_task as authorize_codex_task_record,
    codex_task_summary as build_codex_task_summary,
    codex_tasks_root as resolve_codex_tasks_root,
    handle_codex_query as query_codex_task,
    handle_codex_tasks as list_codex_tasks,
    load_codex_task as load_codex_task_record,
    parse_iso_datetime as parse_codex_iso_datetime,
    prompt_preview as build_prompt_preview,
    read_visible_task_summaries,
    task_adapter_metadata as parse_task_adapter_metadata,
    task_duration_sec as compute_task_duration_sec,
    task_intake_id as resolve_task_intake_id,
    task_list_limit as parse_task_list_limit,
    task_sort_value as codex_task_sort_value,
    validate_task_id as validate_codex_task_id,
)
from health_summary import (
    HealthSummaryDependencies,
    compact_control_text as compact_health_control_text,
    handle_codex_capabilities as build_codex_capabilities,
    handle_codex_workspaces as build_codex_workspaces,
    handle_health_summary as build_health_summary,
    read_limited_json as read_health_limited_json,
    read_limited_text as read_health_limited_text,
    safe_blocker_type as normalize_supervisor_blocker_type,
    safe_codex_status_text as build_safe_codex_status_text,
    safe_control_text as build_safe_control_text,
    safe_count_text as build_safe_count_text,
    workspace_summary as build_workspace_summary,
    workspace_supervisor_signal as build_workspace_supervisor_signal,
    workspace_supervisor_signals as build_workspace_supervisor_signals,
)
from intake_preparation import (
    IntakePreparationDependencies,
    append_jsonl as append_intake_jsonl,
    execution_evaluation_dependencies as build_execution_evaluation_dependencies,
    handle_codex_intake as read_codex_intake,
    handle_codex_prepare as prepare_codex_intake,
    intake_answers_text as read_intake_answers_text,
    intake_dir as resolve_intake_dir,
    intake_root as resolve_intake_root,
    intake_summary_markdown as render_intake_summary_markdown,
    load_followup_prepare_seed as load_followup_seed,
    load_intake_intent as load_intake_draft,
    load_intake_json_artifact as load_intake_required_json_artifact,
    load_intake_questions as load_intake_question_list,
    load_optional_intake_json_artifact as load_intake_optional_json_artifact,
    load_prepared_run_context as load_prepared_intake_bundle,
    make_policy_preflight as build_policy_preflight,
    make_task_contract as build_task_contract,
    make_taskbox_draft as build_taskbox_draft,
    new_intake_id as generate_intake_id,
    persist_intake_artifacts as write_intake_artifacts,
    read_json_object_if_exists as read_intake_json_object_if_exists,
    safe_intake_text as validate_intake_text,
    validate_codex_project as resolve_codex_project,
    validate_intake_id as resolve_intake_id,
    write_json_atomic as write_intake_json_atomic,
    write_text_atomic as write_intake_text_atomic,
)
from web_ui import render_index_html
from watchdog_commands import (
    brief_text as build_watchdog_brief_text,
    get_project as resolve_watchdog_project,
    help_text as build_watchdog_help_text,
    inbox_text as build_watchdog_inbox_text,
    latest_report_path as resolve_watchdog_latest_report_path,
    parse_project_token as parse_watchdog_project_token,
    safe_snippet as read_watchdog_snippet,
    status_text as build_watchdog_status_text,
    write_task as persist_watchdog_task,
)
from prepared_context import (
    prepared_run_prompt,
    prepared_run_summary,
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
    default_codex_bridge_root = Path(__file__).resolve().parents[1] / "codex-bridge"
    return parse_bridge_config_from_file(
        path,
        default_codex_bridge_root=default_codex_bridge_root,
        project_name_re=PROJECT_NAME_RE,
        supported_modes=SUPPORTED_CODEX_MODES,
        project_factory=Project,
        bridge_config_factory=BridgeConfig,
        auth_principal_factory=AuthPrincipal,
        error_factory=lambda message, status: BridgeError(message, status),
    )


def load_auth_tokens(data: dict[str, Any]) -> dict[str, AuthPrincipal]:
    return parse_auth_tokens_from_config(
        data,
        auth_principal_factory=AuthPrincipal,
        error_factory=lambda message, status: BridgeError(message, status),
    )


def parse_body(content_type: str, raw: bytes) -> dict[str, str]:
    return parse_request_body(
        content_type,
        raw,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def mattermost_response(text: str, response_type: str = "ephemeral") -> dict[str, str]:
    return build_mattermost_response(
        text,
        max_response_chars=MAX_RESPONSE_CHARS,
        response_type=response_type,
    )


def error_code_for(exc: BridgeError) -> str:
    return resolve_api_error_code(exc)


def api_error_payload(exc: BridgeError | Exception) -> dict[str, Any]:
    return build_api_error_payload(exc)


def validate_auth(payload: dict[str, str], config: BridgeConfig) -> None:
    validate_mattermost_auth(
        payload,
        mattermost_tokens=config.mattermost_tokens,
        allowed_users=config.allowed_users,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def authenticate_bearer(authorization: str, config: BridgeConfig) -> AuthPrincipal:
    return authenticate_bearer_principal(
        authorization,
        auth_tokens=config.auth_tokens,
        allowed_users=config.allowed_users,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def reject_frontend_identity(payload: dict[str, str]) -> None:
    reject_frontend_payload_identity(
        payload,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def get_project(config: BridgeConfig, name: str | None) -> Project:
    return resolve_watchdog_project(
        name,
        projects=config.projects,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def parse_project_token(parts: list[str], start: int = 1) -> tuple[str | None, list[str]]:
    return parse_watchdog_project_token(parts, start=start)


def safe_snippet(path: Path, max_chars: int = 1800) -> str:
    return read_watchdog_snippet(path, max_chars=max_chars)


def latest_report_path(project: Project) -> Path:
    return resolve_watchdog_latest_report_path(project)


def status_text(project: Project) -> str:
    return build_watchdog_status_text(project)


def brief_text(project: Project) -> str:
    return build_watchdog_brief_text(project)


def inbox_text(project: Project) -> str:
    return build_watchdog_inbox_text(project)


def write_task(
    project: Project,
    payload: dict[str, str],
    request: str,
    mode: str,
    now: dt.datetime | None = None,
) -> tuple[str, Path]:
    return persist_watchdog_task(
        project,
        payload,
        request,
        mode,
        now=now,
        now_factory=utc_now,
        max_task_chars=MAX_TASK_CHARS,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def help_text(config: BridgeConfig) -> str:
    return build_watchdog_help_text(config.projects)


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
    return validate_codex_task_id(
        task_id,
        task_id_re=CODEX_TASK_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def codex_tasks_root(config: BridgeConfig) -> Path:
    return resolve_codex_tasks_root(config)


def load_codex_task(config: BridgeConfig, task_id: str) -> tuple[Path, dict[str, Any]]:
    return load_codex_task_record(
        config,
        task_id,
        task_id_re=CODEX_TASK_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def task_adapter_metadata(task: dict[str, Any]) -> dict[str, Any]:
    return parse_task_adapter_metadata(task)


def task_intake_id(task: dict[str, Any]) -> str:
    return resolve_task_intake_id(task, intake_id_re=INTAKE_ID_RE)


def is_admin(principal: AuthPrincipal) -> bool:
    return principal_is_admin(principal)


def can_access_task(task: dict[str, Any], principal: AuthPrincipal) -> bool:
    return can_access_task_payload(task, principal)


def can_access_intake(intent: dict[str, Any], principal: AuthPrincipal) -> bool:
    return can_access_intake_payload(intent, principal)


def authorize_codex_task(
    config: BridgeConfig,
    principal: AuthPrincipal,
    task_id: str,
) -> tuple[Path, dict[str, Any]]:
    return authorize_codex_task_record(
        config,
        principal,
        task_id,
        can_access_task=can_access_task,
        task_id_re=CODEX_TASK_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def parse_iso_datetime(value: Any) -> dt.datetime | None:
    return parse_codex_iso_datetime(value)


def task_duration_sec(task: dict[str, Any]) -> int | None:
    return compute_task_duration_sec(task, utc_now=utc_now)


def prompt_preview(prompt: Any) -> str:
    return build_prompt_preview(prompt, max_chars=PROMPT_PREVIEW_CHARS)


def task_sort_value(task: dict[str, Any]) -> str:
    return codex_task_sort_value(task)


def codex_task_summary(task_dir: Path, task: dict[str, Any]) -> dict[str, Any]:
    return build_codex_task_summary(
        task_dir,
        task,
        utc_now=utc_now,
        prompt_preview_chars=PROMPT_PREVIEW_CHARS,
    )


def task_list_limit(value: str | None) -> int:
    return parse_task_list_limit(
        value,
        default_limit=TASK_LIST_DEFAULT_LIMIT,
        max_limit=TASK_LIST_MAX_LIMIT,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def handle_codex_tasks(
    payload: dict[str, str],
    config: BridgeConfig,
    principal: AuthPrincipal,
) -> dict[str, Any]:
    return list_codex_tasks(
        payload,
        config,
        principal,
        deps=CodexTaskListDependencies(
            reject_frontend_identity=reject_frontend_identity,
            validate_project=validate_codex_project,
            reconcile_tasks=reconcile_codex_tasks,
            can_access_task=can_access_task,
            utc_now=utc_now,
            error_factory=lambda message, status, code: BridgeError(message, status, code),
        ),
        task_id_re=CODEX_TASK_ID_RE,
        default_limit=TASK_LIST_DEFAULT_LIMIT,
        max_limit=TASK_LIST_MAX_LIMIT,
        prompt_preview_chars=PROMPT_PREVIEW_CHARS,
    )


def workspace_summary(project: Project) -> dict[str, Any]:
    return build_workspace_summary(project)


def handle_codex_workspaces(config: BridgeConfig, _principal: AuthPrincipal) -> dict[str, Any]:
    return build_codex_workspaces(config)


def handle_codex_capabilities(config: BridgeConfig, _principal: AuthPrincipal) -> dict[str, Any]:
    return build_codex_capabilities(config, version=AGENT_HOST_VERSION)


def read_recent_task_summaries(config: BridgeConfig, principal: AuthPrincipal, limit: int = 50) -> list[dict[str, Any]]:
    return read_visible_task_summaries(
        config,
        principal,
        can_access_task=can_access_task,
        task_id_re=CODEX_TASK_ID_RE,
        utc_now=utc_now,
        prompt_preview_chars=PROMPT_PREVIEW_CHARS,
        limit=max(1, limit),
    )


def safe_control_text(config: BridgeConfig, text: str) -> str:
    return build_safe_control_text(config, text)


def compact_control_text(config: BridgeConfig, text: str, max_chars: int = SUPERVISOR_TEXT_MAX_CHARS) -> str:
    return compact_health_control_text(config, text, max_chars=max_chars)


def read_limited_text(path: Path, max_chars: int = 8192) -> str:
    return read_health_limited_text(path, max_chars=max_chars)


def read_limited_json(path: Path, max_chars: int = 65536) -> dict[str, Any] | None:
    return read_health_limited_json(path, max_chars=max_chars)


def safe_blocker_type(value: Any) -> str:
    return normalize_supervisor_blocker_type(value, allowed_blockers=SUPERVISOR_ALLOWED_BLOCKERS)


def safe_count_text(config: BridgeConfig, value: Any) -> str:
    return build_safe_count_text(config, value)


def workspace_supervisor_signal(config: BridgeConfig, project: Project) -> dict[str, Any]:
    return build_workspace_supervisor_signal(
        config,
        project,
        allowed_blockers=SUPERVISOR_ALLOWED_BLOCKERS,
        supervisor_text_max_chars=SUPERVISOR_TEXT_MAX_CHARS,
    )


def workspace_supervisor_signals(config: BridgeConfig) -> list[dict[str, Any]]:
    return build_workspace_supervisor_signals(
        config,
        allowed_blockers=SUPERVISOR_ALLOWED_BLOCKERS,
        supervisor_text_max_chars=SUPERVISOR_TEXT_MAX_CHARS,
    )


def handle_health_summary(config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    return build_health_summary(
        config,
        principal,
        deps=HealthSummaryDependencies(read_recent_task_summaries=read_recent_task_summaries),
        version=AGENT_HOST_VERSION,
        active_statuses=CODEX_ACTIVE_STATUSES,
        final_statuses=CODEX_FINAL_STATUSES,
        allowed_blockers=SUPERVISOR_ALLOWED_BLOCKERS,
        supervisor_text_max_chars=SUPERVISOR_TEXT_MAX_CHARS,
    )


def safe_codex_status_text(config: BridgeConfig, task: dict[str, Any], text: str) -> str:
    return build_safe_codex_status_text(config, task, text)


def validate_codex_project(config: BridgeConfig, project: str) -> Project:
    return resolve_codex_project(
        config,
        project,
        project_name_re=PROJECT_NAME_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def validate_intake_id(intake_id: str) -> str:
    return resolve_intake_id(
        intake_id,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def new_intake_id() -> str:
    return generate_intake_id(utc_now=utc_now)


def intake_root(config: BridgeConfig) -> Path:
    return resolve_intake_root(config)


def intake_dir(config: BridgeConfig, intake_id: str) -> Path:
    return resolve_intake_dir(
        config,
        intake_id,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def load_intake_intent(config: BridgeConfig, intake_id: str) -> dict[str, Any]:
    return load_intake_draft(
        config,
        intake_id,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def load_intake_json_artifact(config: BridgeConfig, intake_id: str, filename: str) -> dict[str, Any]:
    return load_intake_required_json_artifact(
        config,
        intake_id,
        filename,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def load_optional_intake_json_artifact(config: BridgeConfig, intake_id: str, filename: str) -> dict[str, Any] | None:
    return load_intake_optional_json_artifact(
        config,
        intake_id,
        filename,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def load_intake_questions(config: BridgeConfig, intake_id: str) -> list[str]:
    return load_intake_question_list(
        config,
        intake_id,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def load_prepared_run_context(config: BridgeConfig, intake_id: str, principal: AuthPrincipal) -> dict[str, Any]:
    return load_prepared_intake_bundle(
        config,
        intake_id,
        principal,
        can_access_intake=can_access_intake,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def handle_codex_intake(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    return read_codex_intake(
        payload,
        config,
        principal,
        deps=IntakePreparationDependencies(
            utc_now=utc_now,
            reject_frontend_identity=reject_frontend_identity,
            can_access_intake=can_access_intake,
            validate_task_id=validate_task_id,
            authorize_task=authorize_codex_task,
            task_intake_id=task_intake_id,
            safe_adapter_source=safe_adapter_source,
            prompt_preview=prompt_preview,
            project_name_re=PROJECT_NAME_RE,
            error_factory=lambda message, status, code: BridgeError(message, status, code),
        ),
        intake_id_re=INTAKE_ID_RE,
    )


def load_followup_prepare_seed(config: BridgeConfig, followup_task_id: str, principal: AuthPrincipal) -> dict[str, Any]:
    return load_followup_seed(
        config,
        followup_task_id,
        principal,
        authorize_task=authorize_codex_task,
        task_intake_id=task_intake_id,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def read_json_object_if_exists(path: Path) -> dict[str, Any]:
    return read_intake_json_object_if_exists(path)


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    write_intake_json_atomic(path, data)


def write_text_atomic(path: Path, text: str) -> None:
    write_intake_text_atomic(path, text)


def append_jsonl(path: Path, event: dict[str, Any]) -> None:
    append_intake_jsonl(path, event)


def execution_evaluation_dependencies() -> ExecutionEvaluationDependencies:
    return build_execution_evaluation_dependencies(
        utc_now=utc_now,
        task_intake_id=task_intake_id,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def safe_intake_text(value: str, max_chars: int = 6000) -> str:
    return validate_intake_text(
        value,
        max_chars,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def intake_answers_text(payload: dict[str, str]) -> str:
    return read_intake_answers_text(
        payload,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )



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
    return build_task_contract(
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
        prompt_preview=prompt_preview,
        utc_now=utc_now,
    )


def make_taskbox_draft(contract: dict[str, Any]) -> dict[str, Any]:
    return build_taskbox_draft(contract)


def make_policy_preflight(
    project: Project,
    contract: dict[str, Any],
    taskbox: dict[str, Any],
    questions: list[str],
    evidence_retrieval: dict[str, Any],
) -> dict[str, Any]:
    return build_policy_preflight(project, contract, taskbox, questions, evidence_retrieval)


def intake_summary_markdown(contract: dict[str, Any], questions: list[str], preflight: dict[str, Any]) -> str:
    return render_intake_summary_markdown(contract, questions, preflight)


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
    write_intake_artifacts(
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
        event_type=event_type,
        utc_now=utc_now,
        intake_id_re=INTAKE_ID_RE,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def handle_codex_prepare(payload: dict[str, str], config: BridgeConfig, principal: AuthPrincipal) -> dict[str, Any]:
    return prepare_codex_intake(
        payload,
        config,
        principal,
        deps=IntakePreparationDependencies(
            utc_now=utc_now,
            reject_frontend_identity=reject_frontend_identity,
            can_access_intake=can_access_intake,
            validate_task_id=validate_task_id,
            authorize_task=authorize_codex_task,
            task_intake_id=task_intake_id,
            safe_adapter_source=safe_adapter_source,
            prompt_preview=prompt_preview,
            project_name_re=PROJECT_NAME_RE,
            error_factory=lambda message, status, code: BridgeError(message, status, code),
        ),
        intake_id_re=INTAKE_ID_RE,
        max_task_chars=MAX_TASK_CHARS,
    )


def safe_adapter_source(value: str) -> str:
    return validate_adapter_source(
        value,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def safe_idempotency_key(value: str) -> str:
    return validate_idempotency_key(
        value,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def parse_adapter_metadata(value: str) -> dict[str, Any]:
    return parse_adapter_metadata_text(
        value,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def compact_adapter_metadata(value: str) -> str:
    return compact_adapter_metadata_text(
        value,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def compact_adapter_metadata_object(data: dict[str, Any]) -> str:
    return compact_adapter_metadata_mapping(
        data,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def parse_run_receipt(output: str) -> dict[str, Any]:
    return parse_bridge_run_receipt(output)


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
    return query_codex_task(
        payload,
        config,
        command,
        principal,
        deps=CodexTaskQueryDependencies(
            reject_frontend_identity=reject_frontend_identity,
            authorize_task=authorize_codex_task,
            bool_from_payload=bool_from_payload,
            is_admin=is_admin,
            run_codex_bridge=run_codex_bridge,
            require_success=require_success,
            task_intake_id=task_intake_id,
            attach_execution_evaluation=lambda current_config, task_dir, task, rendered: maybe_attach_execution_evaluation(
                current_config,
                task_dir,
                task,
                rendered,
                execution_evaluation_dependencies(),
            ),
            safe_status_text=safe_codex_status_text,
            error_factory=lambda message, status, code: BridgeError(message, status, code),
        ),
        task_id_re=CODEX_TASK_ID_RE,
        final_statuses=CODEX_FINAL_STATUSES,
    )


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
