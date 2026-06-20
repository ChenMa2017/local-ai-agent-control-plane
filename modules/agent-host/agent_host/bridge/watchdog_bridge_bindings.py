from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..runtime.watchdog_commands import (
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

Payload = dict[str, str]


@dataclass(frozen=True)
class WatchdogBridgeBindings:
    get_project: Callable[[Any, str | None], Any]
    parse_project_token: Callable[[list[str], int], tuple[str | None, list[str]]]
    safe_snippet: Callable[[Path, int], str]
    latest_report_path: Callable[[Any], Path]
    status_text: Callable[[Any], str]
    brief_text: Callable[[Any], str]
    inbox_text: Callable[[Any], str]
    write_task: Callable[[Any, Payload, str, str, Any | None], tuple[str, Path]]
    help_text: Callable[[Any], str]
    handle_watchdog: Callable[[Payload, Any], dict[str, str]]


def build_watchdog_bridge_bindings(
    *,
    validate_auth: Callable[[Payload, Any], None],
    mattermost_response: Callable[[str, str], dict[str, str]],
    utc_now: Callable[[], Any],
    max_task_chars: int,
    error_factory: Callable[[str, int, str | None], Exception],
) -> WatchdogBridgeBindings:
    def get_project(config: Any, name: str | None) -> Any:
        return resolve_watchdog_project(
            name,
            projects=config.projects,
            error_factory=error_factory,
        )

    def parse_project_token(parts: list[str], start: int = 1) -> tuple[str | None, list[str]]:
        return parse_watchdog_project_token(parts, start=start)

    def safe_snippet(path: Path, max_chars: int = 1800) -> str:
        return read_watchdog_snippet(path, max_chars=max_chars)

    def latest_report_path(project: Any) -> Path:
        return resolve_watchdog_latest_report_path(project)

    def status_text(project: Any) -> str:
        return build_watchdog_status_text(project)

    def brief_text(project: Any) -> str:
        return build_watchdog_brief_text(project)

    def inbox_text(project: Any) -> str:
        return build_watchdog_inbox_text(project)

    def write_task(
        project: Any,
        payload: Payload,
        request: str,
        mode: str,
        now: Any | None = None,
    ) -> tuple[str, Path]:
        return persist_watchdog_task(
            project,
            payload,
            request,
            mode,
            now=now,
            now_factory=utc_now,
            max_task_chars=max_task_chars,
            error_factory=error_factory,
        )

    def help_text(config: Any) -> str:
        return build_watchdog_help_text(config.projects)

    def handle_watchdog(payload: Payload, config: Any) -> dict[str, str]:
        validate_auth(payload, config)

        text = payload.get("text", "").strip()
        if not text:
            return mattermost_response(help_text(config))

        try:
            parts = shlex.split(text)
        except ValueError as exc:
            raise error_factory(f"could not parse command text: {exc}", 400, None) from exc

        if not parts:
            return mattermost_response(help_text(config))

        subcommand = parts[0].lower()
        if subcommand in {"help", "-h", "--help"}:
            return mattermost_response(help_text(config))

        if subcommand in {"status", "brief", "inbox"}:
            project_name, rest = parse_project_token(parts)
            if rest:
                raise error_factory(f"`{subcommand}` does not accept extra arguments", 400, None)
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

        raise error_factory(f"unknown subcommand: {subcommand}", 400, None)

    return WatchdogBridgeBindings(
        get_project=get_project,
        parse_project_token=parse_project_token,
        safe_snippet=safe_snippet,
        latest_report_path=latest_report_path,
        status_text=status_text,
        brief_text=brief_text,
        inbox_text=inbox_text,
        write_task=write_task,
        help_text=help_text,
        handle_watchdog=handle_watchdog,
    )
