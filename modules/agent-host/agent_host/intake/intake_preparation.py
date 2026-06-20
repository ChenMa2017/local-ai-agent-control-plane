from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..research.execution_evaluation import ExecutionEvaluationDependencies
from .intake_store import (
    append_jsonl,
    intake_dir,
    intake_root,
    load_intake_intent,
    load_intake_json_artifact,
    load_intake_questions,
    load_optional_intake_json_artifact,
    load_prepared_run_context,
    new_intake_id,
    read_json_object_if_exists,
    validate_intake_id,
    write_json_atomic,
    write_text_atomic,
)
from .intake_views import handle_codex_intake, load_followup_prepare_seed
from .prepare_artifacts import (
    intake_summary_markdown,
    make_policy_preflight,
    make_task_contract,
    make_taskbox_draft,
    persist_intake_artifacts,
)
from .prepare_flow import (
    handle_codex_prepare,
    intake_answers_text,
    safe_intake_text,
    validate_codex_project,
)

JsonObject = dict[str, Any]
Payload = dict[str, str]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class IntakePreparationDependencies:
    utc_now: Callable[[], dt.datetime]
    reject_frontend_identity: Callable[[Payload], None]
    can_access_intake: Callable[[JsonObject, Any], bool]
    validate_task_id: Callable[[str], str]
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]]
    task_intake_id: Callable[[JsonObject], str]
    safe_adapter_source: Callable[[str], str]
    prompt_preview: Callable[[Any], str]
    project_name_re: Any
    error_factory: ErrorFactory


def execution_evaluation_dependencies(
    *,
    utc_now: Callable[[], dt.datetime],
    task_intake_id: Callable[[JsonObject], str],
    intake_id_re: Any,
    error_factory: ErrorFactory,
) -> ExecutionEvaluationDependencies:
    return ExecutionEvaluationDependencies(
        utc_now=utc_now,
        intake_dir=lambda config, intake_id: intake_dir(
            config,
            intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        ),
        read_json_object_if_exists=read_json_object_if_exists,
        write_json_atomic=write_json_atomic,
        write_text_atomic=write_text_atomic,
        append_jsonl=append_jsonl,
        task_intake_id=task_intake_id,
    )
