from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .intake_preparation import (
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

JsonObject = dict[str, Any]
Payload = dict[str, str]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class IntakeBridgeBindings:
    validate_codex_project: Callable[[Any, str], Any]
    validate_intake_id: Callable[[str], str]
    new_intake_id: Callable[[], str]
    intake_root: Callable[[Any], Path]
    intake_dir: Callable[[Any, str], Path]
    load_intake_intent: Callable[[Any, str], JsonObject]
    load_intake_json_artifact: Callable[[Any, str, str], JsonObject]
    load_optional_intake_json_artifact: Callable[[Any, str, str], JsonObject | None]
    load_intake_questions: Callable[[Any, str], list[str]]
    load_prepared_run_context: Callable[[Any, str, Any], JsonObject]
    handle_codex_intake: Callable[[Payload, Any, Any], JsonObject]
    load_followup_prepare_seed: Callable[[Any, str, Any], JsonObject]
    read_json_object_if_exists: Callable[[Path], JsonObject]
    write_json_atomic: Callable[[Path, JsonObject], None]
    write_text_atomic: Callable[[Path, str], None]
    append_jsonl: Callable[[Path, JsonObject], None]
    execution_evaluation_dependencies: Callable[[], Any]
    safe_intake_text: Callable[[str, int], str]
    intake_answers_text: Callable[[Payload], str]
    make_task_contract: Callable[..., JsonObject]
    make_taskbox_draft: Callable[[JsonObject], JsonObject]
    make_policy_preflight: Callable[[Any, JsonObject, JsonObject, list[str], JsonObject], JsonObject]
    intake_summary_markdown: Callable[[JsonObject, list[str], JsonObject], str]
    persist_intake_artifacts: Callable[..., None]
    handle_codex_prepare: Callable[[Payload, Any, Any], JsonObject]


def build_intake_bridge_bindings(
    *,
    utc_now: Callable[[], Any],
    reject_frontend_identity: Callable[[Payload], None],
    can_access_intake: Callable[[JsonObject, Any], bool],
    validate_task_id: Callable[[str], str],
    authorize_task: Callable[[Any, Any, str], tuple[Path, JsonObject]],
    task_intake_id: Callable[[JsonObject], str],
    safe_adapter_source: Callable[[str], str],
    prompt_preview: Callable[[Any], str],
    project_name_re: re.Pattern[str],
    error_factory: ErrorFactory,
    intake_id_re: re.Pattern[str],
    max_task_chars: int,
) -> IntakeBridgeBindings:
    def validate_codex_project(config: Any, project: str) -> Any:
        return resolve_codex_project(
            config,
            project,
            project_name_re=project_name_re,
            error_factory=error_factory,
        )

    def validate_intake_id(intake_id: str) -> str:
        return resolve_intake_id(
            intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def new_intake_id() -> str:
        return generate_intake_id(utc_now=utc_now)

    def intake_root(config: Any) -> Path:
        return resolve_intake_root(config)

    def intake_dir(config: Any, intake_id: str) -> Path:
        return resolve_intake_dir(
            config,
            intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def load_intake_intent(config: Any, intake_id: str) -> JsonObject:
        return load_intake_draft(
            config,
            intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def load_intake_json_artifact(config: Any, intake_id: str, filename: str) -> JsonObject:
        return load_intake_required_json_artifact(
            config,
            intake_id,
            filename,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def load_optional_intake_json_artifact(config: Any, intake_id: str, filename: str) -> JsonObject | None:
        return load_intake_optional_json_artifact(
            config,
            intake_id,
            filename,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def load_intake_questions(config: Any, intake_id: str) -> list[str]:
        return load_intake_question_list(
            config,
            intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def load_prepared_run_context(config: Any, intake_id: str, principal: Any) -> JsonObject:
        return load_prepared_intake_bundle(
            config,
            intake_id,
            principal,
            can_access_intake=can_access_intake,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def handle_codex_intake(payload: Payload, config: Any, principal: Any) -> JsonObject:
        return read_codex_intake(
            payload,
            config,
            principal,
            deps=IntakePreparationDependencies(
                utc_now=utc_now,
                reject_frontend_identity=reject_frontend_identity,
                can_access_intake=can_access_intake,
                validate_task_id=validate_task_id,
                authorize_task=authorize_task,
                task_intake_id=task_intake_id,
                safe_adapter_source=safe_adapter_source,
                prompt_preview=prompt_preview,
                project_name_re=project_name_re,
                error_factory=error_factory,
            ),
            intake_id_re=intake_id_re,
        )

    def load_followup_prepare_seed(config: Any, followup_task_id: str, principal: Any) -> JsonObject:
        return load_followup_seed(
            config,
            followup_task_id,
            principal,
            authorize_task=authorize_task,
            task_intake_id=task_intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def read_json_object_if_exists(path: Path) -> JsonObject:
        return read_intake_json_object_if_exists(path)

    def write_json_atomic(path: Path, data: JsonObject) -> None:
        write_intake_json_atomic(path, data)

    def write_text_atomic(path: Path, text: str) -> None:
        write_intake_text_atomic(path, text)

    def append_jsonl(path: Path, event: JsonObject) -> None:
        append_intake_jsonl(path, event)

    def execution_evaluation_dependencies() -> Any:
        return build_execution_evaluation_dependencies(
            utc_now=utc_now,
            task_intake_id=task_intake_id,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def safe_intake_text(value: str, max_chars: int = 6000) -> str:
        return validate_intake_text(
            value,
            max_chars,
            error_factory=error_factory,
        )

    def intake_answers_text(payload: Payload) -> str:
        return read_intake_answers_text(
            payload,
            error_factory=error_factory,
        )

    def make_task_contract(**kwargs: Any) -> JsonObject:
        return build_task_contract(
            **kwargs,
            prompt_preview=prompt_preview,
            utc_now=utc_now,
        )

    def make_taskbox_draft(contract: JsonObject) -> JsonObject:
        return build_taskbox_draft(contract)

    def make_policy_preflight(
        project: Any,
        contract: JsonObject,
        taskbox: JsonObject,
        questions: list[str],
        evidence_retrieval: JsonObject,
    ) -> JsonObject:
        return build_policy_preflight(project, contract, taskbox, questions, evidence_retrieval)

    def intake_summary_markdown(contract: JsonObject, questions: list[str], preflight: JsonObject) -> str:
        return render_intake_summary_markdown(contract, questions, preflight)

    def persist_intake_artifacts(**kwargs: Any) -> None:
        write_intake_artifacts(
            **kwargs,
            utc_now=utc_now,
            intake_id_re=intake_id_re,
            error_factory=error_factory,
        )

    def handle_codex_prepare(payload: Payload, config: Any, principal: Any) -> JsonObject:
        return prepare_codex_intake(
            payload,
            config,
            principal,
            deps=IntakePreparationDependencies(
                utc_now=utc_now,
                reject_frontend_identity=reject_frontend_identity,
                can_access_intake=can_access_intake,
                validate_task_id=validate_task_id,
                authorize_task=authorize_task,
                task_intake_id=task_intake_id,
                safe_adapter_source=safe_adapter_source,
                prompt_preview=prompt_preview,
                project_name_re=project_name_re,
                error_factory=error_factory,
            ),
            intake_id_re=intake_id_re,
            max_task_chars=max_task_chars,
        )

    return IntakeBridgeBindings(
        validate_codex_project=validate_codex_project,
        validate_intake_id=validate_intake_id,
        new_intake_id=new_intake_id,
        intake_root=intake_root,
        intake_dir=intake_dir,
        load_intake_intent=load_intake_intent,
        load_intake_json_artifact=load_intake_json_artifact,
        load_optional_intake_json_artifact=load_optional_intake_json_artifact,
        load_intake_questions=load_intake_questions,
        load_prepared_run_context=load_prepared_run_context,
        handle_codex_intake=handle_codex_intake,
        load_followup_prepare_seed=load_followup_prepare_seed,
        read_json_object_if_exists=read_json_object_if_exists,
        write_json_atomic=write_json_atomic,
        write_text_atomic=write_text_atomic,
        append_jsonl=append_jsonl,
        execution_evaluation_dependencies=execution_evaluation_dependencies,
        safe_intake_text=safe_intake_text,
        intake_answers_text=intake_answers_text,
        make_task_contract=make_task_contract,
        make_taskbox_draft=make_taskbox_draft,
        make_policy_preflight=make_policy_preflight,
        intake_summary_markdown=intake_summary_markdown,
        persist_intake_artifacts=persist_intake_artifacts,
        handle_codex_prepare=handle_codex_prepare,
    )
