from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any, Callable

from ..bridge.auth_policy import (
    can_access_intake as can_access_intake_payload,
    can_access_task as can_access_task_payload,
    is_admin as principal_is_admin,
)
from .codex_bridge_runtime import (
    bool_from_payload as parse_truthy_payload,
    parse_queued_task_id as parse_codex_bridge_queued_task_id,
    reconcile_codex_tasks as reconcile_bridge_tasks,
    require_success as require_codex_bridge_success,
    run_codex_bridge as execute_codex_bridge,
    write_codex_bridge_config as write_codex_bridge_runtime_config,
)
from .codex_tasking import (
    authorize_codex_task as authorize_codex_task_record,
    codex_task_summary as build_codex_task_summary,
    codex_tasks_root as resolve_codex_tasks_root,
    load_codex_task as load_codex_task_record,
    parse_iso_datetime as parse_codex_iso_datetime,
    prompt_preview as build_prompt_preview,
    task_adapter_metadata as parse_task_adapter_metadata,
    task_duration_sec as compute_task_duration_sec,
    task_intake_id as resolve_task_intake_id,
    task_sort_value as codex_task_sort_value,
    validate_task_id as validate_codex_task_id,
)

JsonObject = dict[str, Any]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class CodexTaskRuntimeBindings:
    bool_from_payload: Callable[[str], bool]
    run_codex_bridge: Callable[[Any, list[str], int], Any]
    write_codex_bridge_config: Callable[[Any], Path]
    require_success: Callable[[Any], str]
    reconcile_codex_tasks: Callable[[Any], None]
    parse_queued_task_id: Callable[[str], str]
    validate_task_id: Callable[[str], str]
    codex_tasks_root: Callable[[Any], Path]
    load_codex_task: Callable[[Any, str], tuple[Path, JsonObject]]
    task_adapter_metadata: Callable[[JsonObject], JsonObject]
    task_intake_id: Callable[[JsonObject], str]
    is_admin: Callable[[Any], bool]
    can_access_task: Callable[[JsonObject, Any], bool]
    can_access_intake: Callable[[JsonObject, Any], bool]
    authorize_codex_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    parse_iso_datetime: Callable[[Any], Any]
    task_duration_sec: Callable[[JsonObject], int | None]
    prompt_preview: Callable[[Any], str]
    task_sort_value: Callable[[JsonObject], str]
    codex_task_summary: Callable[[Path, JsonObject], JsonObject]


def build_codex_task_runtime_bindings(
    *,
    utc_now: Callable[[], Any],
    task_id_re: re.Pattern[str],
    intake_id_re: re.Pattern[str],
    prompt_preview_chars: int,
    error_factory: ErrorFactory,
) -> CodexTaskRuntimeBindings:
    def bool_from_payload(value: str) -> bool:
        return parse_truthy_payload(value)

    def run_codex_bridge(config: Any, args: list[str], timeout: int = 20) -> Any:
        return execute_codex_bridge(
            config,
            args,
            timeout=timeout,
            error_factory=error_factory,
        )

    def write_codex_bridge_config(config: Any) -> Path:
        return write_codex_bridge_runtime_config(config)

    def require_success(result: Any) -> str:
        return require_codex_bridge_success(
            result,
            error_factory=error_factory,
        )

    def reconcile_codex_tasks(config: Any) -> None:
        reconcile_bridge_tasks(
            config,
            run_bridge=lambda current_config, args, timeout: run_codex_bridge(
                current_config,
                args,
                timeout=timeout,
            ),
            error_factory=error_factory,
        )

    def parse_queued_task_id(output: str) -> str:
        return parse_codex_bridge_queued_task_id(
            output,
            error_factory=error_factory,
        )

    def validate_task_id(task_id: str) -> str:
        return validate_codex_task_id(
            task_id,
            task_id_re=task_id_re,
            error_factory=error_factory,
        )

    def codex_tasks_root(config: Any) -> Path:
        return resolve_codex_tasks_root(config)

    def load_codex_task(config: Any, task_id: str) -> tuple[Path, JsonObject]:
        return load_codex_task_record(
            config,
            task_id,
            task_id_re=task_id_re,
            error_factory=error_factory,
        )

    def task_adapter_metadata(task: JsonObject) -> JsonObject:
        return parse_task_adapter_metadata(task)

    def task_intake_id(task: JsonObject) -> str:
        return resolve_task_intake_id(task, intake_id_re=intake_id_re)

    def is_admin(principal: Any) -> bool:
        return principal_is_admin(principal)

    def can_access_task(task: JsonObject, principal: Any) -> bool:
        return can_access_task_payload(task, principal)

    def can_access_intake(intent: JsonObject, principal: Any) -> bool:
        return can_access_intake_payload(intent, principal)

    def authorize_codex_task(config: Any, principal: Any, task_id: str) -> tuple[Path, JsonObject]:
        return authorize_codex_task_record(
            config,
            principal,
            task_id,
            can_access_task=can_access_task,
            task_id_re=task_id_re,
            error_factory=error_factory,
        )

    def parse_iso_datetime(value: Any) -> Any:
        return parse_codex_iso_datetime(value)

    def task_duration_sec(task: JsonObject) -> int | None:
        return compute_task_duration_sec(task, utc_now=utc_now)

    def prompt_preview(prompt: Any) -> str:
        return build_prompt_preview(prompt, max_chars=prompt_preview_chars)

    def task_sort_value(task: JsonObject) -> str:
        return codex_task_sort_value(task)

    def codex_task_summary(task_dir: Path, task: JsonObject) -> JsonObject:
        return build_codex_task_summary(
            task_dir,
            task,
            utc_now=utc_now,
            prompt_preview_chars=prompt_preview_chars,
        )

    return CodexTaskRuntimeBindings(
        bool_from_payload=bool_from_payload,
        run_codex_bridge=run_codex_bridge,
        write_codex_bridge_config=write_codex_bridge_config,
        require_success=require_success,
        reconcile_codex_tasks=reconcile_codex_tasks,
        parse_queued_task_id=parse_queued_task_id,
        validate_task_id=validate_task_id,
        codex_tasks_root=codex_tasks_root,
        load_codex_task=load_codex_task,
        task_adapter_metadata=task_adapter_metadata,
        task_intake_id=task_intake_id,
        is_admin=is_admin,
        can_access_task=can_access_task,
        can_access_intake=can_access_intake,
        authorize_codex_task=authorize_codex_task,
        parse_iso_datetime=parse_iso_datetime,
        task_duration_sec=task_duration_sec,
        prompt_preview=prompt_preview,
        task_sort_value=task_sort_value,
        codex_task_summary=codex_task_summary,
    )
