#!/usr/bin/env python3
"""Mattermost -> Watchdog task bridge.

This is intentionally a task intake service, not a remote shell. It accepts a
small `/watchdog ...` command surface and writes JSON task files into a
whitelisted project's `agent/inbox/` directory for the project's watchdog to
judge later.
"""

from __future__ import annotations

import datetime as dt
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from api_bridge_bindings import build_api_bridge_bindings
from bridge_runtime_bindings import build_bridge_runtime_bindings
from codex_execution_handlers import build_codex_execution_handlers
from codex_task_runtime_bindings import build_codex_task_runtime_bindings
from execution_evaluation import (
    maybe_attach_execution_evaluation,
)
from health_bridge_bindings import build_health_bridge_bindings
from intake_bridge_bindings import build_intake_bridge_bindings
from stream_bridge_bindings import build_stream_bridge_bindings
from watchdog_bridge_bindings import build_watchdog_bridge_bindings
from result_streaming import redact_url_secrets
from codex_tasking import (
    read_visible_task_summaries,
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


API_BRIDGE_BINDINGS = build_api_bridge_bindings(
    default_codex_bridge_root=Path(__file__).resolve().parents[1] / "codex-bridge",
    project_name_re=PROJECT_NAME_RE,
    supported_modes=SUPPORTED_CODEX_MODES,
    project_factory=Project,
    bridge_config_factory=BridgeConfig,
    auth_principal_factory=AuthPrincipal,
    max_response_chars=MAX_RESPONSE_CHARS,
    config_error_factory=lambda message, status: BridgeError(message, status),
    error_factory=lambda message, status, code: BridgeError(message, status, code),
)
load_config = API_BRIDGE_BINDINGS.load_config
load_auth_tokens = API_BRIDGE_BINDINGS.load_auth_tokens
parse_body = API_BRIDGE_BINDINGS.parse_body
mattermost_response = API_BRIDGE_BINDINGS.mattermost_response
error_code_for = API_BRIDGE_BINDINGS.error_code_for
api_error_payload = API_BRIDGE_BINDINGS.api_error_payload
validate_auth = API_BRIDGE_BINDINGS.validate_auth
authenticate_bearer = API_BRIDGE_BINDINGS.authenticate_bearer
reject_frontend_identity = API_BRIDGE_BINDINGS.reject_frontend_identity
safe_adapter_source = API_BRIDGE_BINDINGS.safe_adapter_source
safe_idempotency_key = API_BRIDGE_BINDINGS.safe_idempotency_key
parse_adapter_metadata = API_BRIDGE_BINDINGS.parse_adapter_metadata
compact_adapter_metadata = API_BRIDGE_BINDINGS.compact_adapter_metadata
compact_adapter_metadata_object = API_BRIDGE_BINDINGS.compact_adapter_metadata_object
parse_run_receipt = API_BRIDGE_BINDINGS.parse_run_receipt


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


CODEX_TASK_RUNTIME_BINDINGS = build_codex_task_runtime_bindings(
    utc_now=utc_now,
    task_id_re=CODEX_TASK_ID_RE,
    intake_id_re=INTAKE_ID_RE,
    prompt_preview_chars=PROMPT_PREVIEW_CHARS,
    error_factory=lambda message, status, code: BridgeError(message, status, code),
)
bool_from_payload = CODEX_TASK_RUNTIME_BINDINGS.bool_from_payload
run_codex_bridge = CODEX_TASK_RUNTIME_BINDINGS.run_codex_bridge
write_codex_bridge_config = CODEX_TASK_RUNTIME_BINDINGS.write_codex_bridge_config
require_success = CODEX_TASK_RUNTIME_BINDINGS.require_success
reconcile_codex_tasks = CODEX_TASK_RUNTIME_BINDINGS.reconcile_codex_tasks
parse_queued_task_id = CODEX_TASK_RUNTIME_BINDINGS.parse_queued_task_id
validate_task_id = CODEX_TASK_RUNTIME_BINDINGS.validate_task_id
codex_tasks_root = CODEX_TASK_RUNTIME_BINDINGS.codex_tasks_root
load_codex_task = CODEX_TASK_RUNTIME_BINDINGS.load_codex_task
task_adapter_metadata = CODEX_TASK_RUNTIME_BINDINGS.task_adapter_metadata
task_intake_id = CODEX_TASK_RUNTIME_BINDINGS.task_intake_id
is_admin = CODEX_TASK_RUNTIME_BINDINGS.is_admin
can_access_task = CODEX_TASK_RUNTIME_BINDINGS.can_access_task
can_access_intake = CODEX_TASK_RUNTIME_BINDINGS.can_access_intake
authorize_codex_task = CODEX_TASK_RUNTIME_BINDINGS.authorize_codex_task
parse_iso_datetime = CODEX_TASK_RUNTIME_BINDINGS.parse_iso_datetime
task_duration_sec = CODEX_TASK_RUNTIME_BINDINGS.task_duration_sec
prompt_preview = CODEX_TASK_RUNTIME_BINDINGS.prompt_preview
task_sort_value = CODEX_TASK_RUNTIME_BINDINGS.task_sort_value
codex_task_summary = CODEX_TASK_RUNTIME_BINDINGS.codex_task_summary


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


STREAM_BRIDGE_BINDINGS = build_stream_bridge_bindings(
    stream_tokens=STREAM_TOKENS,
    stream_token_lock=STREAM_TOKEN_LOCK,
    utc_now=utc_now,
    stream_token_ttl_seconds=STREAM_TOKEN_TTL_SECONDS,
    auth_principal_factory=AuthPrincipal,
    parse_iso_datetime=parse_iso_datetime,
    run_codex_bridge=run_codex_bridge,
    require_success=require_success,
    sse_log_tail_lines=SSE_LOG_TAIL_LINES,
    sse_log_max_chars=SSE_LOG_MAX_CHARS,
    status_error_factory=lambda message, status: BridgeError(message, status),
)
cleanup_stream_tokens = STREAM_BRIDGE_BINDINGS.cleanup_stream_tokens
create_stream_token_payload = STREAM_BRIDGE_BINDINGS.create_stream_token_payload
resolve_active_stream_principal = STREAM_BRIDGE_BINDINGS.resolve_active_stream_principal
principal_from_stream_token = STREAM_BRIDGE_BINDINGS.principal_from_stream_token
remaining_seconds = STREAM_BRIDGE_BINDINGS.remaining_seconds
task_snapshot = STREAM_BRIDGE_BINDINGS.task_snapshot
safe_log_snapshot = STREAM_BRIDGE_BINDINGS.safe_log_snapshot
has_safe_result = STREAM_BRIDGE_BINDINGS.has_safe_result
index_html = STREAM_BRIDGE_BINDINGS.index_html


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


BRIDGE_RUNTIME_BINDINGS = build_bridge_runtime_bindings(
    bridge_error_type=BridgeError,
    api_error_payload=api_error_payload,
    mattermost_response=mattermost_response,
    max_body_bytes=MAX_BODY_BYTES,
    validate_task_id=validate_task_id,
    principal_from_stream_token=principal_from_stream_token,
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
)
build_handler_dependencies = BRIDGE_RUNTIME_BINDINGS.build_handler_dependencies
WatchdogBridgeHandler = BRIDGE_RUNTIME_BINDINGS.watchdog_bridge_handler


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config(Path(args.config))

    if args.check_config:
        return check_config(config, SUPPORTED_CODEX_MODES)

    return serve_bridge(config, WatchdogBridgeHandler)


if __name__ == "__main__":
    raise SystemExit(main())
