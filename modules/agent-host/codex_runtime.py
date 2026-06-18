from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

JsonObject = dict[str, Any]
Payload = dict[str, str]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class CodexRunDependencies:
    reject_frontend_identity: Callable[[Payload], None]
    validate_intake_id: Callable[[str], str]
    load_prepared_run_context: Callable[[Any, str, Any], JsonObject]
    prepared_run_summary: Callable[[JsonObject], JsonObject]
    safe_intake_text: Callable[[str, int], str]
    validate_project: Callable[[Any, str], Any]
    safe_adapter_source: Callable[[str], str]
    safe_idempotency_key: Callable[[str], str]
    parse_adapter_metadata: Callable[[str], JsonObject]
    validate_task_id: Callable[[str], str]
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    prepared_run_prompt: Callable[[JsonObject, str, Callable[[str, int], str], int], str]
    compact_adapter_metadata_object: Callable[[JsonObject], str]
    bool_from_payload: Callable[[str], bool]
    run_codex_bridge: Callable[[Any, list[str]], Any]
    require_success: Callable[[Any], str]
    parse_queued_task_id: Callable[[str], str]
    parse_run_receipt: Callable[[str], JsonObject]
    append_jsonl: Callable[[Path, JsonObject], None]
    intake_dir: Callable[[Any, str], Path]
    utc_now: Callable[[], Any]
    error_factory: ErrorFactory


@dataclass(frozen=True)
class ResultPageDependencies:
    handle_codex_query: Callable[[Payload, Any, str, Any], JsonObject]
    error_factory: ErrorFactory


@dataclass(frozen=True)
class StreamTokenDependencies:
    reject_frontend_identity: Callable[[Payload], None]
    validate_task_id: Callable[[str], str]
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    cleanup_stream_tokens: Callable[[], None]
    issue_stream_token: Callable[[str, str, str], JsonObject]
    resolve_stream_principal: Callable[[str, str], tuple[str, str]]


def handle_codex_run(
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: CodexRunDependencies,
    max_task_chars: int,
) -> JsonObject:
    deps.reject_frontend_identity(payload)
    intake_id = (payload.get("intake_id") or "").strip()
    prepared_bundle: JsonObject | None = None
    prepared_intent: JsonObject = {}
    prepared_contract: JsonObject = {}
    prepared_taskbox: JsonObject = {}
    prepared_preflight: JsonObject = {}
    prepared_summary: JsonObject = {}
    if intake_id:
        intake_id = deps.validate_intake_id(intake_id)
        prepared_bundle = deps.load_prepared_run_context(config, intake_id, principal)
        prepared_intent = prepared_bundle["intent"]
        prepared_contract = prepared_bundle["contract"]
        prepared_taskbox = prepared_bundle["taskbox"]
        prepared_preflight = prepared_bundle["preflight"]
        prepared_summary = deps.prepared_run_summary(prepared_bundle)

    project = (payload.get("workspace") or payload.get("project", "")).strip() or str(prepared_intent.get("workspace") or "")
    prompt = deps.safe_intake_text(payload.get("prompt", "") or "", max_task_chars) if payload.get("prompt") else ""
    if not project:
        raise deps.error_factory("workspace is required", 400, "invalid_request")
    project_item = deps.validate_project(config, project)
    if prepared_intent and project != str(prepared_intent.get("workspace") or ""):
        raise deps.error_factory(
            f"workspace mismatch for intake {intake_id}: expected {prepared_intent.get('workspace')}",
            409,
            "prepare_workspace_mismatch",
        )
    prepared_mode = str(prepared_contract.get("mode") or prepared_intent.get("desired_mode") or "").strip()
    mode = (payload.get("mode") or prepared_mode or project_item.default_mode).strip() or project_item.default_mode
    if prepared_mode and mode != prepared_mode:
        raise deps.error_factory(
            f"mode mismatch for intake {intake_id}: expected {prepared_mode}",
            409,
            "prepare_mode_mismatch",
        )
    if mode not in project_item.allowed_modes:
        allowed = ", ".join(project_item.allowed_modes)
        raise deps.error_factory(
            f"mode {mode} is not allowed for workspace {project}; allowed: {allowed}",
            400,
            "invalid_request",
        )

    source = deps.safe_adapter_source(payload.get("source", "web"))
    idempotency_key = deps.safe_idempotency_key(payload.get("idempotency_key", ""))
    metadata_obj = deps.parse_adapter_metadata(payload.get("metadata", ""))
    reference_task_id = (
        payload.get("reference_task_id")
        or payload.get("referenceTaskId")
        or str(prepared_intent.get("reference_task_id") or "")
    ).strip()
    if reference_task_id:
        reference_task_id = deps.validate_task_id(reference_task_id)
        deps.authorize_task(config, principal, reference_task_id)

    if prepared_bundle:
        if not prepared_preflight.get("ok") or str(prepared_taskbox.get("status") or "") != "ready":
            reason_text = "; ".join(str(item) for item in prepared_preflight.get("reasons", [])[:2])
            required_action = str(prepared_preflight.get("required_action") or "prepare")
            message = f"prepared intake {intake_id} is not runnable; required_action={required_action}"
            if reason_text:
                message += f"; reasons: {reason_text}"
            raise deps.error_factory(message, 409, "prepare_not_runnable")
        prompt = deps.prepared_run_prompt(prepared_bundle, prompt, deps.safe_intake_text, max_task_chars)
        metadata_obj.update(
            {
                "intake_id": intake_id,
                "prepared_objective": prepared_summary.get("objective") or "",
                "prepared_workspace_mode": prepared_summary.get("workspace_mode") or "",
                "evidence_retrieval_decision": prepared_summary.get("evidence_retrieval_decision") or "",
            }
        )
    elif not prompt:
        raise deps.error_factory("prompt is required", 400, "invalid_request")

    metadata = deps.compact_adapter_metadata_object(metadata_obj)
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
    if deps.bool_from_payload(payload.get("dry_run", "")):
        args.append("--dry-run")
    args.append(prompt)

    output = deps.require_success(deps.run_codex_bridge(config, args))
    task_id = deps.parse_queued_task_id(output)
    receipt = deps.parse_run_receipt(output)
    if intake_id:
        deps.append_jsonl(
            deps.intake_dir(config, intake_id) / "TASK_INTAKE.events.jsonl",
            {
                "event": "run_queued",
                "intake_id": intake_id,
                "task_id": task_id,
                "workspace": project_item.name,
                "mode": mode,
                "user": principal.user,
                "timestamp": deps.utc_now().isoformat().replace("+00:00", "Z"),
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
        "idempotent_replay": bool(receipt["idempotent_replay"]),
        "output": output,
        "status_url": f"/codex/status?task_id={task_id}",
        "result_url": f"/codex/result?task_id={task_id}",
        "logs_url": f"/codex/logs?task_id={task_id}",
    }


def parse_positive_int(
    value: str | None,
    default: int,
    max_value: int,
    field: str,
    *,
    error_factory: ErrorFactory,
) -> int:
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise error_factory(f"{field} must be a number", 400, "invalid_request") from exc
    if parsed < 1:
        raise error_factory(f"{field} must be at least 1", 400, "invalid_request")
    return min(parsed, max_value)


def paginate_text(
    text: str,
    page: int,
    page_size: int,
    *,
    error_factory: ErrorFactory,
) -> JsonObject:
    value = str(text or "")
    total_chars = len(value)
    total_pages = max(1, (total_chars + page_size - 1) // page_size)
    if page > total_pages:
        raise error_factory(f"page out of range; total_pages={total_pages}", 400, "invalid_request")
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
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: ResultPageDependencies,
    default_page_size: int,
    max_page_size: int,
) -> JsonObject:
    page = parse_positive_int(payload.get("page"), 1, 1000000, "page", error_factory=deps.error_factory)
    page_size = parse_positive_int(
        payload.get("page_size") or payload.get("pageSize"),
        default_page_size,
        max_page_size,
        "page_size",
        error_factory=deps.error_factory,
    )
    result = deps.handle_codex_query(
        {
            "task_id": payload.get("task_id", ""),
            "max_chars": str(max_page_size * 100),
        },
        config,
        "result",
        principal,
    )
    if result.get("raw"):
        raise deps.error_factory("result pages only support safe output", 403, "permission_denied")
    page_data = paginate_text(str(result.get("text", "")), page, page_size, error_factory=deps.error_factory)
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


def handle_stream_token(
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: StreamTokenDependencies,
) -> JsonObject:
    deps.reject_frontend_identity(payload)
    task_id = deps.validate_task_id(payload.get("task_id", ""))
    deps.authorize_task(config, principal, task_id)
    deps.cleanup_stream_tokens()
    token_payload = deps.issue_stream_token(task_id, principal.user, principal.role)
    return {
        "ok": True,
        "task_id": task_id,
        **token_payload,
    }


def principal_from_stream_token(
    task_id: str,
    stream_token: str,
    *,
    resolve_stream_principal: Callable[[str, str], tuple[str, str]],
) -> tuple[str, str]:
    return resolve_stream_principal(task_id, stream_token)
