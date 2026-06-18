from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

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

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class HealthBridgeBindings:
    workspace_summary: Callable[[Any], JsonObject]
    handle_codex_workspaces: Callable[[Any, Any], JsonObject]
    handle_codex_capabilities: Callable[[Any, Any], JsonObject]
    read_recent_task_summaries: Callable[[Any, Any, int], list[JsonObject]]
    safe_control_text: Callable[[Any, str], str]
    compact_control_text: Callable[[Any, str, int], str]
    read_limited_text: Callable[[Path, int], str]
    read_limited_json: Callable[[Path, int], JsonObject | None]
    safe_blocker_type: Callable[[Any], str]
    safe_count_text: Callable[[Any, Any], str]
    workspace_supervisor_signal: Callable[[Any, Any], JsonObject]
    workspace_supervisor_signals: Callable[[Any], list[JsonObject]]
    handle_health_summary: Callable[[Any, Any], JsonObject]
    safe_codex_status_text: Callable[[Any, JsonObject, str], str]


def build_health_bridge_bindings(
    *,
    can_access_task: Callable[[JsonObject, Any], bool],
    read_visible_task_summaries: Callable[..., list[JsonObject]],
    task_id_re: re.Pattern[str],
    utc_now: Callable[[], Any],
    prompt_preview_chars: int,
    version: str,
    active_statuses: set[str] | frozenset[str],
    final_statuses: set[str] | frozenset[str],
    allowed_blockers: set[str] | frozenset[str],
    supervisor_text_max_chars: int,
) -> HealthBridgeBindings:
    def workspace_summary(project: Any) -> JsonObject:
        return build_workspace_summary(project)

    def handle_codex_workspaces(config: Any, _principal: Any) -> JsonObject:
        return build_codex_workspaces(config)

    def handle_codex_capabilities(config: Any, _principal: Any) -> JsonObject:
        return build_codex_capabilities(config, version=version)

    def read_recent_task_summaries(config: Any, principal: Any, limit: int = 50) -> list[JsonObject]:
        return read_visible_task_summaries(
            config,
            principal,
            can_access_task=can_access_task,
            task_id_re=task_id_re,
            utc_now=utc_now,
            prompt_preview_chars=prompt_preview_chars,
            limit=max(1, limit),
        )

    def safe_control_text(config: Any, text: str) -> str:
        return build_safe_control_text(config, text)

    def compact_control_text(config: Any, text: str, max_chars: int = supervisor_text_max_chars) -> str:
        return compact_health_control_text(config, text, max_chars=max_chars)

    def read_limited_text(path: Path, max_chars: int = 8192) -> str:
        return read_health_limited_text(path, max_chars=max_chars)

    def read_limited_json(path: Path, max_chars: int = 65536) -> JsonObject | None:
        return read_health_limited_json(path, max_chars=max_chars)

    def safe_blocker_type(value: Any) -> str:
        return normalize_supervisor_blocker_type(value, allowed_blockers=allowed_blockers)

    def safe_count_text(config: Any, value: Any) -> str:
        return build_safe_count_text(config, value)

    def workspace_supervisor_signal(config: Any, project: Any) -> JsonObject:
        return build_workspace_supervisor_signal(
            config,
            project,
            allowed_blockers=allowed_blockers,
            supervisor_text_max_chars=supervisor_text_max_chars,
        )

    def workspace_supervisor_signals(config: Any) -> list[JsonObject]:
        return build_workspace_supervisor_signals(
            config,
            allowed_blockers=allowed_blockers,
            supervisor_text_max_chars=supervisor_text_max_chars,
        )

    def handle_health_summary(config: Any, principal: Any) -> JsonObject:
        return build_health_summary(
            config,
            principal,
            deps=HealthSummaryDependencies(read_recent_task_summaries=read_recent_task_summaries),
            version=version,
            active_statuses=active_statuses,
            final_statuses=final_statuses,
            allowed_blockers=allowed_blockers,
            supervisor_text_max_chars=supervisor_text_max_chars,
        )

    def safe_codex_status_text(config: Any, task: JsonObject, text: str) -> str:
        return build_safe_codex_status_text(config, task, text)

    return HealthBridgeBindings(
        workspace_summary=workspace_summary,
        handle_codex_workspaces=handle_codex_workspaces,
        handle_codex_capabilities=handle_codex_capabilities,
        read_recent_task_summaries=read_recent_task_summaries,
        safe_control_text=safe_control_text,
        compact_control_text=compact_control_text,
        read_limited_text=read_limited_text,
        read_limited_json=read_limited_json,
        safe_blocker_type=safe_blocker_type,
        safe_count_text=safe_count_text,
        workspace_supervisor_signal=workspace_supervisor_signal,
        workspace_supervisor_signals=workspace_supervisor_signals,
        handle_health_summary=handle_health_summary,
        safe_codex_status_text=safe_codex_status_text,
    )
