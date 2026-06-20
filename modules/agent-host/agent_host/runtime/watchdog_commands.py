from __future__ import annotations

import datetime as dt
import json
import os
import secrets
from pathlib import Path
from typing import Any, Callable, Iterable

Payload = dict[str, str]


def get_project(
    name: str | None,
    *,
    projects: dict[str, Any],
    error_factory: Callable[[str, int, str | None], Exception],
) -> Any:
    if not name:
        if len(projects) == 1:
            return next(iter(projects.values()))
        raise error_factory("project is required", 400, None)

    if name not in projects:
        available = ", ".join(sorted(projects))
        raise error_factory(f"unknown project {name!r}; available: {available}", 400, None)

    project = projects[name]
    root = Path(getattr(project, "root"))
    if not root.exists() or not root.is_dir():
        raise error_factory(f"project root does not exist: {root}", 500, None)
    return project


def parse_project_token(parts: list[str], start: int = 1) -> tuple[str | None, list[str]]:
    if len(parts) <= start:
        return None, []
    token = parts[start]
    if token.startswith("project="):
        return token.split("=", 1)[1], parts[start + 1 :]
    return token, parts[start + 1 :]


def safe_snippet(path: Path, max_chars: int = 1800) -> str:
    if not path.exists():
        return f"(missing: {path})"
    text = path.read_text(errors="replace")
    if len(text) > max_chars:
        return text[:max_chars].rstrip() + "\n...(truncated)"
    return text


def latest_report_path(project: Any) -> Path:
    return Path(getattr(project, "root")) / "agent" / "reports" / "latest.md"


def status_text(project: Any) -> str:
    root = Path(getattr(project, "root"))
    latest = latest_report_path(project)
    runtime = root / "agent" / "RUNTIME_STATE.md"
    morning = root / "agent" / "MORNING_BRIEF.md"
    inbox = root / "agent" / "inbox"

    lines = [
        f"Project `{project.name}`",
        f"Root: `{root}`",
        f"Latest report: `{latest.resolve() if latest.exists() else 'missing'}`",
        f"Runtime state: {'present' if runtime.exists() else 'missing'}",
        f"Morning brief: {'present' if morning.exists() else 'missing'}",
        f"Inbox items: {len(list(inbox.glob('*.json'))) if inbox.exists() else 0}",
    ]
    return "\n".join(lines)


def brief_text(project: Any) -> str:
    root = Path(getattr(project, "root"))
    morning = root / "agent" / "MORNING_BRIEF.md"
    latest = latest_report_path(project)
    if morning.exists():
        return f"Morning brief for `{project.name}`:\n\n{safe_snippet(morning)}"
    return f"Latest report for `{project.name}`:\n\n{safe_snippet(latest)}"


def inbox_text(project: Any) -> str:
    inbox = Path(getattr(project, "root")) / "agent" / "inbox"
    if not inbox.exists():
        return f"Inbox for `{project.name}` is empty."

    items = sorted(inbox.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not items:
        return f"Inbox for `{project.name}` is empty."

    lines = [f"Latest inbox items for `{project.name}`:"]
    for item in items[:10]:
        lines.append(f"- `{item.name}` ({item.stat().st_size} bytes)")
    return "\n".join(lines)


def write_task(
    project: Any,
    payload: Payload,
    request: str,
    mode: str,
    *,
    now: dt.datetime | None = None,
    max_task_chars: int = 4000,
    now_factory: Callable[[], dt.datetime] | None = None,
    task_id_suffix_factory: Callable[[], str] | None = None,
    error_factory: Callable[[str, int, str | None], Exception],
) -> tuple[str, Path]:
    request = request.strip()
    if not request:
        raise error_factory("task request is empty", 400, None)
    if len(request) > max_task_chars:
        raise error_factory(f"task request is too long; max {max_task_chars} chars", 400, None)

    now_factory = now_factory or (lambda: dt.datetime.now(dt.timezone.utc))
    task_id_suffix_factory = task_id_suffix_factory or (lambda: secrets.token_hex(4))
    now = now or now_factory()
    task_id = f"{now.strftime('%Y%m%dT%H%M%SZ')}_{task_id_suffix_factory()}"

    root = Path(getattr(project, "root"))
    inbox = root / "agent" / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    out = inbox / f"{task_id}_mattermost_task.json"
    tmp = inbox / f".{task_id}.tmp"

    task = {
        "id": task_id,
        "source": "mattermost",
        "project": project.name,
        "request": request,
        "mode": mode,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "status": "new",
        "mattermost": {
            "team_id": payload.get("team_id", ""),
            "team_domain": payload.get("team_domain", ""),
            "channel_id": payload.get("channel_id", ""),
            "channel_name": payload.get("channel_name", ""),
            "user_id": payload.get("user_id", ""),
            "user_name": payload.get("user_name", ""),
            "command": payload.get("command", ""),
            "text": payload.get("text", ""),
        },
        "safety": {
            "bridge_executed_shell": False,
            "bridge_started_watchdog": False,
            "bridge_modified_project_files": [str(out.relative_to(root))],
            "requires_watchdog_decision": True,
        },
    }

    tmp.write_text(json.dumps(task, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, out)
    return task_id, out


def help_text(project_names: Iterable[str]) -> str:
    projects = ", ".join(sorted(str(name) for name in project_names))
    return "\n".join(
        [
            "Watchdog bridge commands:",
            "`/watchdog task <project> <request>` - submit a task to project inbox",
            "`/watchdog status <project>` - show project status",
            "`/watchdog brief <project>` - show morning brief/latest report",
            "`/watchdog inbox <project>` - list queued inbox tasks",
            "`/watchdog run-once <project> <reason>` - submit a run-once request for watchdog to judge later",
            f"Projects: {projects}",
            "",
            "This bridge never executes shell commands directly.",
        ]
    )
