from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from codex_runtime import (
    CodexRunDependencies,
    ResultPageDependencies,
    StreamTokenDependencies,
    handle_codex_result_page as render_codex_result_page,
    handle_codex_run as queue_codex_run,
    handle_stream_token as issue_codex_stream_token,
)
from codex_tasking import (
    CodexTaskListDependencies,
    CodexTaskQueryDependencies,
    handle_codex_query as query_codex_task,
    handle_codex_tasks as list_codex_tasks,
)

JsonObject = dict[str, Any]
Payload = dict[str, str]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class CodexExecutionHandlerSet:
    handle_codex_tasks: Callable[[Payload, Any, Any], JsonObject]
    handle_codex_run: Callable[[Payload, Any, Any], JsonObject]
    handle_codex_query: Callable[[Payload, Any, str, Any], JsonObject]
    handle_codex_result_page: Callable[[Payload, Any, Any], JsonObject]
    handle_stream_token: Callable[[Payload, Any, Any], JsonObject]


def build_codex_execution_handlers(
    *,
    reject_frontend_identity: Callable[[Payload], None],
    validate_project: Callable[[Any, str], Any],
    reconcile_tasks: Callable[[Any], None],
    can_access_task: Callable[[JsonObject, Any], bool],
    utc_now: Callable[[], Any],
    error_factory: ErrorFactory,
    task_id_re: re.Pattern[str],
    default_limit: int,
    max_limit: int,
    prompt_preview_chars: int,
    validate_intake_id: Callable[[str], str],
    load_prepared_run_context: Callable[[Any, str, Any], JsonObject],
    prepared_run_summary: Callable[[JsonObject], JsonObject],
    safe_intake_text: Callable[[str, int], str],
    safe_adapter_source: Callable[[str], str],
    safe_idempotency_key: Callable[[str], str],
    parse_adapter_metadata: Callable[[str], JsonObject],
    validate_task_id: Callable[[str], str],
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]],
    prepared_run_prompt: Callable[[JsonObject, str, Callable[[str, int], str], int], str],
    compact_adapter_metadata_object: Callable[[JsonObject], str],
    bool_from_payload: Callable[[str], bool],
    run_codex_bridge: Callable[[Any, list[str]], Any],
    require_success: Callable[[Any], str],
    parse_queued_task_id: Callable[[str], str],
    parse_run_receipt: Callable[[str], JsonObject],
    append_jsonl: Callable[[Path, JsonObject], None],
    intake_dir: Callable[[Any, str], Path],
    attach_execution_evaluation: Callable[[Any, Path, JsonObject, JsonObject], JsonObject],
    task_intake_id: Callable[[JsonObject], str],
    is_admin: Callable[[Any], bool],
    safe_status_text: Callable[[Any, JsonObject, str], str],
    final_statuses: set[str] | frozenset[str],
    max_task_chars: int,
    default_page_size: int,
    max_page_size: int,
    cleanup_stream_tokens: Callable[[], None],
    issue_stream_token: Callable[[str, str, str], JsonObject],
    resolve_stream_principal: Callable[[str, str], tuple[str, str]],
) -> CodexExecutionHandlerSet:
    def handle_codex_tasks(payload: Payload, config: Any, principal: Any) -> JsonObject:
        return list_codex_tasks(
            payload,
            config,
            principal,
            deps=CodexTaskListDependencies(
                reject_frontend_identity=reject_frontend_identity,
                validate_project=validate_project,
                reconcile_tasks=reconcile_tasks,
                can_access_task=can_access_task,
                utc_now=utc_now,
                error_factory=error_factory,
            ),
            task_id_re=task_id_re,
            default_limit=default_limit,
            max_limit=max_limit,
            prompt_preview_chars=prompt_preview_chars,
        )

    def handle_codex_run(payload: Payload, config: Any, principal: Any) -> JsonObject:
        return queue_codex_run(
            payload,
            config,
            principal,
            deps=CodexRunDependencies(
                reject_frontend_identity=reject_frontend_identity,
                validate_intake_id=validate_intake_id,
                load_prepared_run_context=load_prepared_run_context,
                prepared_run_summary=prepared_run_summary,
                safe_intake_text=safe_intake_text,
                validate_project=validate_project,
                safe_adapter_source=safe_adapter_source,
                safe_idempotency_key=safe_idempotency_key,
                parse_adapter_metadata=parse_adapter_metadata,
                validate_task_id=validate_task_id,
                authorize_task=authorize_task,
                prepared_run_prompt=prepared_run_prompt,
                compact_adapter_metadata_object=compact_adapter_metadata_object,
                bool_from_payload=bool_from_payload,
                run_codex_bridge=run_codex_bridge,
                require_success=require_success,
                parse_queued_task_id=parse_queued_task_id,
                parse_run_receipt=parse_run_receipt,
                append_jsonl=append_jsonl,
                intake_dir=intake_dir,
                utc_now=utc_now,
                error_factory=error_factory,
            ),
            max_task_chars=max_task_chars,
        )

    def handle_codex_query(payload: Payload, config: Any, command: str, principal: Any) -> JsonObject:
        return query_codex_task(
            payload,
            config,
            command,
            principal,
            deps=CodexTaskQueryDependencies(
                reject_frontend_identity=reject_frontend_identity,
                authorize_task=authorize_task,
                bool_from_payload=bool_from_payload,
                is_admin=is_admin,
                run_codex_bridge=run_codex_bridge,
                require_success=require_success,
                task_intake_id=task_intake_id,
                attach_execution_evaluation=attach_execution_evaluation,
                safe_status_text=safe_status_text,
                error_factory=error_factory,
            ),
            task_id_re=task_id_re,
            final_statuses=final_statuses,
        )

    def handle_codex_result_page(payload: Payload, config: Any, principal: Any) -> JsonObject:
        return render_codex_result_page(
            payload,
            config,
            principal,
            deps=ResultPageDependencies(
                handle_codex_query=handle_codex_query,
                error_factory=error_factory,
            ),
            default_page_size=default_page_size,
            max_page_size=max_page_size,
        )

    def handle_stream_token(payload: Payload, config: Any, principal: Any) -> JsonObject:
        return issue_codex_stream_token(
            payload,
            config,
            principal,
            deps=StreamTokenDependencies(
                reject_frontend_identity=reject_frontend_identity,
                validate_task_id=validate_task_id,
                authorize_task=authorize_task,
                cleanup_stream_tokens=cleanup_stream_tokens,
                issue_stream_token=issue_stream_token,
                resolve_stream_principal=resolve_stream_principal,
            ),
        )

    return CodexExecutionHandlerSet(
        handle_codex_tasks=handle_codex_tasks,
        handle_codex_run=handle_codex_run,
        handle_codex_query=handle_codex_query,
        handle_codex_result_page=handle_codex_result_page,
        handle_stream_token=handle_stream_token,
    )
