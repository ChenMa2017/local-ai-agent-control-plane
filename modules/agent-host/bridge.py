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
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config_loader import (
    load_auth_tokens as parse_auth_tokens_from_config,
    load_config as parse_bridge_config_from_file,
)
from bridge_handler import (
    HandlerDependencies,
    build_http_route_dependencies,
    build_stream_loop_dependencies,
    build_watchdog_bridge_handler,
)
from auth_policy import (
    authenticate_bearer as authenticate_bearer_principal,
    can_access_intake as can_access_intake_payload,
    can_access_task as can_access_task_payload,
    is_admin as principal_is_admin,
    reject_frontend_identity as reject_frontend_payload_identity,
    validate_auth as validate_mattermost_auth,
)
from codex_execution_handlers import build_codex_execution_handlers
from health_bridge_bindings import build_health_bridge_bindings
from intake_bridge_bindings import build_intake_bridge_bindings
from watchdog_bridge_bindings import build_watchdog_bridge_bindings
from execution_evaluation import (
    maybe_attach_execution_evaluation,
)
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
    authorize_codex_task as authorize_codex_task_record,
    codex_task_summary as build_codex_task_summary,
    codex_tasks_root as resolve_codex_tasks_root,
    load_codex_task as load_codex_task_record,
    parse_iso_datetime as parse_codex_iso_datetime,
    prompt_preview as build_prompt_preview,
    read_visible_task_summaries,
    task_adapter_metadata as parse_task_adapter_metadata,
    task_duration_sec as compute_task_duration_sec,
    task_intake_id as resolve_task_intake_id,
    task_sort_value as codex_task_sort_value,
    validate_task_id as validate_codex_task_id,
)
from codex_runtime import (
    principal_from_stream_token as resolve_stream_session_principal,
)
from codex_bridge_runtime import (
    bool_from_payload as parse_truthy_payload,
    parse_queued_task_id as parse_codex_bridge_queued_task_id,
    reconcile_codex_tasks as reconcile_bridge_tasks,
    require_success as require_codex_bridge_success,
    run_codex_bridge as execute_codex_bridge,
    write_codex_bridge_config as write_codex_bridge_runtime_config,
)
from web_ui import render_index_html
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


WATCHDOG_BRIDGE_BINDINGS = build_watchdog_bridge_bindings(
    validate_auth=validate_auth,
    mattermost_response=mattermost_response,
    utc_now=utc_now,
    max_task_chars=MAX_TASK_CHARS,
    error_factory=lambda message, status, code: BridgeError(message, status, code),
)
get_project = WATCHDOG_BRIDGE_BINDINGS.get_project
parse_project_token = WATCHDOG_BRIDGE_BINDINGS.parse_project_token
safe_snippet = WATCHDOG_BRIDGE_BINDINGS.safe_snippet
latest_report_path = WATCHDOG_BRIDGE_BINDINGS.latest_report_path
status_text = WATCHDOG_BRIDGE_BINDINGS.status_text
brief_text = WATCHDOG_BRIDGE_BINDINGS.brief_text
inbox_text = WATCHDOG_BRIDGE_BINDINGS.inbox_text
write_task = WATCHDOG_BRIDGE_BINDINGS.write_task
help_text = WATCHDOG_BRIDGE_BINDINGS.help_text
handle_watchdog = WATCHDOG_BRIDGE_BINDINGS.handle_watchdog


def bool_from_payload(value: str) -> bool:
    return parse_truthy_payload(value)


def run_codex_bridge(config: BridgeConfig, args: list[str], timeout: int = 20) -> Any:
    return execute_codex_bridge(
        config,
        args,
        timeout=timeout,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def write_codex_bridge_config(config: BridgeConfig) -> Path:
    return write_codex_bridge_runtime_config(config)


def require_success(result: Any) -> str:
    return require_codex_bridge_success(
        result,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def reconcile_codex_tasks(config: BridgeConfig) -> None:
    reconcile_bridge_tasks(
        config,
        run_bridge=lambda current_config, args, timeout: run_codex_bridge(current_config, args, timeout=timeout),
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


def parse_queued_task_id(output: str) -> str:
    return parse_codex_bridge_queued_task_id(
        output,
        error_factory=lambda message, status, code: BridgeError(message, status, code),
    )


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


HEALTH_BRIDGE_BINDINGS = build_health_bridge_bindings(
    can_access_task=can_access_task,
    read_visible_task_summaries=read_visible_task_summaries,
    task_id_re=CODEX_TASK_ID_RE,
    utc_now=utc_now,
    prompt_preview_chars=PROMPT_PREVIEW_CHARS,
    version=AGENT_HOST_VERSION,
    active_statuses=CODEX_ACTIVE_STATUSES,
    final_statuses=CODEX_FINAL_STATUSES,
    allowed_blockers=SUPERVISOR_ALLOWED_BLOCKERS,
    supervisor_text_max_chars=SUPERVISOR_TEXT_MAX_CHARS,
)
workspace_summary = HEALTH_BRIDGE_BINDINGS.workspace_summary
handle_codex_workspaces = HEALTH_BRIDGE_BINDINGS.handle_codex_workspaces
handle_codex_capabilities = HEALTH_BRIDGE_BINDINGS.handle_codex_capabilities
read_recent_task_summaries = HEALTH_BRIDGE_BINDINGS.read_recent_task_summaries
safe_control_text = HEALTH_BRIDGE_BINDINGS.safe_control_text
compact_control_text = HEALTH_BRIDGE_BINDINGS.compact_control_text
read_limited_text = HEALTH_BRIDGE_BINDINGS.read_limited_text
read_limited_json = HEALTH_BRIDGE_BINDINGS.read_limited_json
safe_blocker_type = HEALTH_BRIDGE_BINDINGS.safe_blocker_type
safe_count_text = HEALTH_BRIDGE_BINDINGS.safe_count_text
workspace_supervisor_signal = HEALTH_BRIDGE_BINDINGS.workspace_supervisor_signal
workspace_supervisor_signals = HEALTH_BRIDGE_BINDINGS.workspace_supervisor_signals
handle_health_summary = HEALTH_BRIDGE_BINDINGS.handle_health_summary
safe_codex_status_text = HEALTH_BRIDGE_BINDINGS.safe_codex_status_text


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


INTAKE_BRIDGE_BINDINGS = build_intake_bridge_bindings(
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
    intake_id_re=INTAKE_ID_RE,
    max_task_chars=MAX_TASK_CHARS,
)
validate_codex_project = INTAKE_BRIDGE_BINDINGS.validate_codex_project
validate_intake_id = INTAKE_BRIDGE_BINDINGS.validate_intake_id
new_intake_id = INTAKE_BRIDGE_BINDINGS.new_intake_id
intake_root = INTAKE_BRIDGE_BINDINGS.intake_root
intake_dir = INTAKE_BRIDGE_BINDINGS.intake_dir
load_intake_intent = INTAKE_BRIDGE_BINDINGS.load_intake_intent
load_intake_json_artifact = INTAKE_BRIDGE_BINDINGS.load_intake_json_artifact
load_optional_intake_json_artifact = INTAKE_BRIDGE_BINDINGS.load_optional_intake_json_artifact
load_intake_questions = INTAKE_BRIDGE_BINDINGS.load_intake_questions
load_prepared_run_context = INTAKE_BRIDGE_BINDINGS.load_prepared_run_context
handle_codex_intake = INTAKE_BRIDGE_BINDINGS.handle_codex_intake
load_followup_prepare_seed = INTAKE_BRIDGE_BINDINGS.load_followup_prepare_seed
read_json_object_if_exists = INTAKE_BRIDGE_BINDINGS.read_json_object_if_exists
write_json_atomic = INTAKE_BRIDGE_BINDINGS.write_json_atomic
write_text_atomic = INTAKE_BRIDGE_BINDINGS.write_text_atomic
append_jsonl = INTAKE_BRIDGE_BINDINGS.append_jsonl
execution_evaluation_dependencies = INTAKE_BRIDGE_BINDINGS.execution_evaluation_dependencies
safe_intake_text = INTAKE_BRIDGE_BINDINGS.safe_intake_text
intake_answers_text = INTAKE_BRIDGE_BINDINGS.intake_answers_text
make_task_contract = INTAKE_BRIDGE_BINDINGS.make_task_contract
make_taskbox_draft = INTAKE_BRIDGE_BINDINGS.make_taskbox_draft
make_policy_preflight = INTAKE_BRIDGE_BINDINGS.make_policy_preflight
intake_summary_markdown = INTAKE_BRIDGE_BINDINGS.intake_summary_markdown
persist_intake_artifacts = INTAKE_BRIDGE_BINDINGS.persist_intake_artifacts
handle_codex_prepare = INTAKE_BRIDGE_BINDINGS.handle_codex_prepare


def parse_run_receipt(output: str) -> dict[str, Any]:
    return parse_bridge_run_receipt(output)


def attach_execution_evaluation(
    current_config: BridgeConfig,
    task_dir: Path,
    task: dict[str, Any],
    rendered: dict[str, Any],
) -> dict[str, Any]:
    return maybe_attach_execution_evaluation(
        current_config,
        task_dir,
        task,
        rendered,
        execution_evaluation_dependencies(),
    )


def cleanup_stream_tokens() -> None:
    cleanup_stream_token_records(STREAM_TOKENS, STREAM_TOKEN_LOCK, utc_now)


def create_stream_token_payload(task_id: str, user: str, role: str) -> dict[str, Any]:
    return issue_stream_token(
        task_id,
        user,
        role,
        STREAM_TOKENS,
        STREAM_TOKEN_LOCK,
        utc_now,
        STREAM_TOKEN_TTL_SECONDS,
    )


def resolve_active_stream_principal(task_id: str, stream_token: str) -> tuple[str, str]:
    return resolve_stream_principal(
        task_id,
        stream_token,
        STREAM_TOKENS,
        STREAM_TOKEN_LOCK,
        utc_now,
        lambda message, status: BridgeError(message, status),
    )


CODEX_EXECUTION_HANDLERS = build_codex_execution_handlers(
    reject_frontend_identity=reject_frontend_identity,
    validate_project=validate_codex_project,
    reconcile_tasks=reconcile_codex_tasks,
    can_access_task=can_access_task,
    utc_now=utc_now,
    error_factory=lambda message, status, code: BridgeError(message, status, code),
    task_id_re=CODEX_TASK_ID_RE,
    default_limit=TASK_LIST_DEFAULT_LIMIT,
    max_limit=TASK_LIST_MAX_LIMIT,
    prompt_preview_chars=PROMPT_PREVIEW_CHARS,
    validate_intake_id=validate_intake_id,
    load_prepared_run_context=load_prepared_run_context,
    prepared_run_summary=prepared_run_summary,
    safe_intake_text=safe_intake_text,
    safe_adapter_source=safe_adapter_source,
    safe_idempotency_key=safe_idempotency_key,
    parse_adapter_metadata=parse_adapter_metadata,
    validate_task_id=validate_task_id,
    authorize_task=authorize_codex_task,
    prepared_run_prompt=prepared_run_prompt,
    compact_adapter_metadata_object=compact_adapter_metadata_object,
    bool_from_payload=bool_from_payload,
    run_codex_bridge=run_codex_bridge,
    require_success=require_success,
    parse_queued_task_id=parse_queued_task_id,
    parse_run_receipt=parse_run_receipt,
    append_jsonl=append_jsonl,
    intake_dir=intake_dir,
    attach_execution_evaluation=attach_execution_evaluation,
    task_intake_id=task_intake_id,
    is_admin=is_admin,
    safe_status_text=safe_codex_status_text,
    final_statuses=CODEX_FINAL_STATUSES,
    max_task_chars=MAX_TASK_CHARS,
    default_page_size=RESULT_PAGE_DEFAULT_SIZE,
    max_page_size=RESULT_PAGE_MAX_SIZE,
    cleanup_stream_tokens=cleanup_stream_tokens,
    issue_stream_token=create_stream_token_payload,
    resolve_stream_principal=resolve_active_stream_principal,
)
handle_codex_tasks = CODEX_EXECUTION_HANDLERS.handle_codex_tasks
handle_codex_run = CODEX_EXECUTION_HANDLERS.handle_codex_run
handle_codex_query = CODEX_EXECUTION_HANDLERS.handle_codex_query
handle_codex_result_page = CODEX_EXECUTION_HANDLERS.handle_codex_result_page
handle_stream_token = CODEX_EXECUTION_HANDLERS.handle_stream_token


def principal_from_stream_token(task_id: str, stream_token: str) -> AuthPrincipal:
    user, role = resolve_stream_session_principal(
        task_id,
        stream_token,
        resolve_stream_principal=resolve_active_stream_principal,
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


def build_handler_dependencies() -> HandlerDependencies:
    return HandlerDependencies(
        bridge_error_type=BridgeError,
        api_error_payload=api_error_payload,
        mattermost_response=mattermost_response,
        max_body_bytes=MAX_BODY_BYTES,
        redact_log_text=redact_url_secrets,
        validate_task_id=validate_task_id,
        principal_from_stream_token=principal_from_stream_token,
        authorize_task=authorize_codex_task,
        stream_task_events=stream_task_events,
        stream_loop_dependencies=lambda handler: build_stream_loop_dependencies(
            handler,
            authorize_task=authorize_codex_task,
            safe_log_snapshot=safe_log_snapshot,
            has_safe_result=has_safe_result,
            task_snapshot=task_snapshot,
            remaining_seconds=remaining_seconds,
            utc_now=utc_now,
            final_statuses=CODEX_FINAL_STATUSES,
            heartbeat_seconds=SSE_HEARTBEAT_SECONDS,
            poll_seconds=SSE_POLL_SECONDS,
            log_event_max_chars=SSE_LOG_EVENT_MAX_CHARS,
        ),
        http_route_dependencies=lambda: build_http_route_dependencies(
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
        ),
    )


WatchdogBridgeHandler = build_watchdog_bridge_handler(build_handler_dependencies())


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config(Path(args.config))

    if args.check_config:
        return check_config(config, SUPPORTED_CODEX_MODES)

    return serve_bridge(config, WatchdogBridgeHandler)


if __name__ == "__main__":
    raise SystemExit(main())
