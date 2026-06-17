from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

JsonObject = dict[str, Any]
Payload = dict[str, str]
ErrorFactory = Callable[[str, int, str | None], Exception]
TASK_FILTER_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")


@dataclass(frozen=True)
class CodexTaskListDependencies:
    reject_frontend_identity: Callable[[Payload], None]
    validate_project: Callable[[Any, str], Any]
    reconcile_tasks: Callable[[Any], None]
    can_access_task: Callable[[JsonObject, Any], bool]
    utc_now: Callable[[], dt.datetime]
    error_factory: ErrorFactory


@dataclass(frozen=True)
class CodexTaskQueryDependencies:
    reject_frontend_identity: Callable[[Payload], None]
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    bool_from_payload: Callable[[str], bool]
    is_admin: Callable[[Any], bool]
    run_codex_bridge: Callable[[Any, list[str]], Any]
    require_success: Callable[[Any], str]
    task_intake_id: Callable[[JsonObject], str]
    attach_execution_evaluation: Callable[[Any, Path, JsonObject, JsonObject], JsonObject]
    safe_status_text: Callable[[Any, JsonObject, str], str]
    error_factory: ErrorFactory


def validate_task_id(
    task_id: str,
    *,
    task_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> str:
    if not task_id_re.match(task_id or ""):
        raise error_factory("invalid task_id", 400, None)
    return task_id


def codex_tasks_root(config: Any) -> Path:
    return Path(getattr(config, "codex_bridge_root")) / ".codex-bridge" / "tasks"


def load_codex_task(
    config: Any,
    task_id: str,
    *,
    task_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> tuple[Path, JsonObject]:
    task_id = validate_task_id(task_id, task_id_re=task_id_re, error_factory=error_factory)
    task_dir = codex_tasks_root(config) / task_id
    task_file = task_dir / "task.json"
    if not task_file.exists():
        raise error_factory(f"task not found: {task_id}", 404, "task_not_found")
    try:
        data = json.loads(task_file.read_text())
    except json.JSONDecodeError as exc:
        raise error_factory(f"task metadata is invalid: {task_id}: {exc}", 500, None) from exc
    if not isinstance(data, dict):
        raise error_factory(f"task metadata is invalid: {task_id}", 500, None)
    return task_dir, data


def task_adapter_metadata(task: JsonObject) -> JsonObject:
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


def task_intake_id(task: JsonObject, *, intake_id_re: re.Pattern[str]) -> str:
    value = str(task_adapter_metadata(task).get("intake_id") or "").strip()
    if value and intake_id_re.match(value):
        return value
    return ""


def authorize_codex_task(
    config: Any,
    principal: Any,
    task_id: str,
    *,
    can_access_task: Callable[[JsonObject, Any], bool],
    task_id_re: re.Pattern[str],
    error_factory: ErrorFactory,
) -> tuple[Path, JsonObject]:
    task_dir, task = load_codex_task(config, task_id, task_id_re=task_id_re, error_factory=error_factory)
    project = str(task.get("project", ""))
    if project and project not in getattr(config, "projects", {}):
        raise error_factory(f"task project is not allowlisted: {project}", 403, "permission_denied")
    if not can_access_task(task, principal):
        raise error_factory(
            f"unauthorized: task is not owned by {getattr(principal, 'user', '')}",
            403,
            "permission_denied",
        )
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


def task_duration_sec(
    task: JsonObject,
    *,
    utc_now: Callable[[], dt.datetime],
) -> int | None:
    start = parse_iso_datetime(task.get("started_at")) or parse_iso_datetime(task.get("created_at"))
    end = parse_iso_datetime(task.get("ended_at")) or parse_iso_datetime(task.get("updated_at"))
    if not start:
        return None
    if not end and str(task.get("status", "")) in {"queued", "running"}:
        end = utc_now()
    if not end:
        return None
    return max(0, int(round((end - start).total_seconds())))


def prompt_preview(prompt: Any, *, max_chars: int) -> str:
    text = re.sub(r"\s+", " ", str(prompt or "")).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def task_sort_value(task: JsonObject) -> str:
    value = task.get("updated_at") or task.get("created_at") or ""
    return str(value)


def codex_task_summary(
    task_dir: Path,
    task: JsonObject,
    *,
    utc_now: Callable[[], dt.datetime],
    prompt_preview_chars: int,
) -> JsonObject:
    task_id = str(task.get("task_id") or task_dir.name)
    return {
        "task_id": task_id,
        "owner": str(task.get("user", "")),
        "project": str(task.get("project", "")),
        "source": str(task.get("source", "unknown") or "unknown"),
        "status": str(task.get("status", "")),
        "created_at": str(task.get("created_at", "")),
        "updated_at": str(task.get("updated_at", "")),
        "duration_sec": task_duration_sec(task, utc_now=utc_now),
        "exit_code": task.get("exit_code") if isinstance(task.get("exit_code"), int) else None,
        "prompt_preview": prompt_preview(task.get("prompt", ""), max_chars=prompt_preview_chars),
        "has_result": (task_dir / "result.md").exists(),
        "has_logs": any((task_dir / name).exists() for name in ("bridge.log", "stdout.jsonl", "stderr.log")),
        "mode": str(task.get("mode", "")),
        "write_audit": bool(task.get("write_audit_path")),
        "changed_files_count": task.get("changed_files_count") if isinstance(task.get("changed_files_count"), int) else None,
        "protected_path_violation": bool(task.get("protected_path_violation")),
    }


def task_list_limit(
    value: str | None,
    *,
    default_limit: int,
    max_limit: int,
    error_factory: ErrorFactory,
) -> int:
    if not value:
        return default_limit
    try:
        parsed = int(value)
    except ValueError as exc:
        raise error_factory("limit must be a number", 400, None) from exc
    if parsed < 1:
        raise error_factory("limit must be at least 1", 400, None)
    return min(parsed, max_limit)


def read_visible_task_summaries(
    config: Any,
    principal: Any,
    *,
    can_access_task: Callable[[JsonObject, Any], bool],
    task_id_re: re.Pattern[str],
    utc_now: Callable[[], dt.datetime],
    prompt_preview_chars: int,
    status_filter: str = "",
    project_filter: str = "",
    limit: int | None = None,
) -> list[JsonObject]:
    root = codex_tasks_root(config)
    if not root.exists():
        return []

    items: list[tuple[str, JsonObject]] = []
    for task_file in root.glob("*/task.json"):
        task_dir = task_file.parent
        if not task_id_re.match(task_dir.name):
            continue
        try:
            task = json.loads(task_file.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(task, dict):
            continue
        task_project = str(task.get("project", ""))
        if task_project and task_project not in getattr(config, "projects", {}):
            continue
        if not can_access_task(task, principal):
            continue
        if status_filter and str(task.get("status", "")) != status_filter:
            continue
        if project_filter and task_project != project_filter:
            continue
        items.append(
            (
                task_sort_value(task),
                codex_task_summary(
                    task_dir,
                    task,
                    utc_now=utc_now,
                    prompt_preview_chars=prompt_preview_chars,
                ),
            )
        )

    items.sort(key=lambda item: item[0], reverse=True)
    summaries = [summary for _sort_value, summary in items]
    if limit is None:
        return summaries
    return summaries[: max(1, limit)]


def handle_codex_tasks(
    payload: Payload,
    config: Any,
    principal: Any,
    *,
    deps: CodexTaskListDependencies,
    task_id_re: re.Pattern[str],
    default_limit: int,
    max_limit: int,
    prompt_preview_chars: int,
) -> JsonObject:
    deps.reject_frontend_identity(payload)
    limit = task_list_limit(
        payload.get("limit"),
        default_limit=default_limit,
        max_limit=max_limit,
        error_factory=deps.error_factory,
    )
    status_filter = payload.get("status", "").strip()
    project_filter = payload.get("project", "").strip()

    if status_filter and not TASK_FILTER_RE.match(status_filter):
        raise deps.error_factory("status filter must be a safe status name", 400, None)
    if project_filter:
        deps.validate_project(config, project_filter)

    deps.reconcile_tasks(config)
    return {
        "ok": True,
        "tasks": read_visible_task_summaries(
            config,
            principal,
            can_access_task=deps.can_access_task,
            task_id_re=task_id_re,
            utc_now=deps.utc_now,
            prompt_preview_chars=prompt_preview_chars,
            status_filter=status_filter,
            project_filter=project_filter,
            limit=limit,
        ),
    }


def handle_codex_query(
    payload: Payload,
    config: Any,
    command: str,
    principal: Any,
    *,
    deps: CodexTaskQueryDependencies,
    task_id_re: re.Pattern[str],
    final_statuses: set[str] | frozenset[str],
) -> JsonObject:
    deps.reject_frontend_identity(payload)
    task_id = validate_task_id(payload.get("task_id", ""), task_id_re=task_id_re, error_factory=deps.error_factory)
    task_dir, task = deps.authorize_task(config, principal, task_id)
    raw_requested = deps.bool_from_payload(payload.get("raw", ""))
    if raw_requested and not deps.is_admin(principal):
        raise deps.error_factory("raw output requires admin role", 403, None)
    if command == "cancel" and str(task.get("status", "")) in final_statuses:
        raise deps.error_factory(
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

    output = deps.require_success(deps.run_codex_bridge(config, args))
    if command in {"result", "logs"}:
        try:
            rendered = json.loads(output)
        except json.JSONDecodeError as exc:
            raise deps.error_factory(f"codex-bridge returned invalid JSON: {exc}", 500, None) from exc
        if not isinstance(rendered, dict):
            raise deps.error_factory("codex-bridge returned invalid JSON object", 500, None)

        intake_id = deps.task_intake_id(task)
        if command == "result" and not raw_requested:
            rendered.update(deps.attach_execution_evaluation(config, task_dir, task, rendered))
        if intake_id:
            rendered["intake_id"] = intake_id
        rendered.update(
            {
                "ok": True,
                "task_id": task_id,
                "command": command,
                "user": getattr(principal, "user", ""),
            }
        )
        return rendered

    return {
        "ok": True,
        "task_id": task_id,
        "command": command,
        "user": getattr(principal, "user", ""),
        "text": deps.safe_status_text(config, task, output) if command == "status" else output,
    }
