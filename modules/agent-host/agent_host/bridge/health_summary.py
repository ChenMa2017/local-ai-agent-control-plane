from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class HealthSummaryDependencies:
    read_recent_task_summaries: Callable[[Any, Any, int], list[JsonObject]]


def workspace_summary(project: Any) -> JsonObject:
    return {
        "id": project.name,
        "label": getattr(project, "label", "") or project.name,
        "default_mode": getattr(project, "default_mode", "readonly"),
        "allowed_modes": list(getattr(project, "allowed_modes", ("readonly",))),
        "description": getattr(project, "description", ""),
    }


def handle_codex_workspaces(config: Any) -> JsonObject:
    return {
        "ok": True,
        "workspaces": [
            workspace_summary(project)
            for project in sorted(getattr(config, "projects", {}).values(), key=lambda item: item.name)
        ],
    }


def handle_codex_capabilities(config: Any, *, version: str) -> JsonObject:
    projects = getattr(config, "projects", {}).values()
    modes = sorted({mode for project in projects for mode in getattr(project, "allowed_modes", ())})
    write_mode = any("workspace-write" in getattr(project, "allowed_modes", ()) for project in projects)
    return {
        "ok": True,
        "version": version,
        "commands": ["prepare", "intake", "run", "tasks", "status", "result", "logs", "cancel"],
        "features": {
            "auth": True,
            "safe_output": True,
            "sse": True,
            "cancel": True,
            "timeout": True,
            "resume": False,
            "write_mode": write_mode,
            "prepare_intake": True,
            "intake_lookup": True,
            "raw_admin_access": True,
        },
        "modes": modes,
    }


def safe_control_text(config: Any, text: str) -> str:
    safe = str(text or "")
    projects = getattr(config, "projects", {})
    replacements = [(str(project.root), f"[workspace:{name}]") for name, project in projects.items()]
    for raw_path, replacement in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        if raw_path:
            safe = re.sub(re.escape(raw_path), replacement, safe)

    home = str(Path.home())
    if home:
        safe = re.sub(re.escape(home), "~", safe)

    safe = re.sub(r"Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+", "Authorization: Bearer [REDACTED]", safe, flags=re.I)
    safe = re.sub(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b", "[REDACTED_OPENAI_KEY]", safe)
    safe = re.sub(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b", "[REDACTED_GITHUB_TOKEN]", safe)
    safe = re.sub(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b", "[REDACTED_DISCORD_TOKEN]", safe)
    safe = re.sub(
        r"(?im)\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s]+)",
        r"\1=[REDACTED_SECRET]",
        safe,
    )
    safe = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        "[REDACTED_PRIVATE_KEY]",
        safe,
    )
    return safe


def compact_control_text(config: Any, text: str, *, max_chars: int) -> str:
    safe = " ".join(safe_control_text(config, text).split())
    if len(safe) > max_chars:
        return safe[: max(0, max_chars - 16)].rstrip() + "...(truncated)"
    return safe


def read_limited_text(path: Path, max_chars: int = 8192) -> str:
    if not path.exists() or not path.is_file():
        return ""
    try:
        return path.read_text(errors="replace")[:max_chars]
    except OSError:
        return ""


def read_limited_json(path: Path, max_chars: int = 65536) -> JsonObject | None:
    text = read_limited_text(path, max_chars=max_chars)
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def safe_blocker_type(value: Any, *, allowed_blockers: set[str] | frozenset[str]) -> str:
    blocker = str(value or "unknown").strip().lower().replace("-", "_")
    if blocker not in allowed_blockers:
        return "unknown"
    return blocker


def safe_count_text(config: Any, value: Any) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return "unknown"
    if not re.fullmatch(r"[0-9]{1,12}", text):
        return "unknown"
    return compact_control_text(config, text, max_chars=16)


def workspace_supervisor_signal(
    config: Any,
    project: Any,
    *,
    allowed_blockers: set[str] | frozenset[str],
    supervisor_text_max_chars: int,
) -> JsonObject:
    agent_dir = Path(project.root) / "agent"
    run_state_path = agent_dir / "RUN_STATE.json"
    next_action_path = agent_dir / "NEXT_ACTION.md"
    blockers_path = agent_dir / "BLOCKERS.md"
    run_state = read_limited_json(run_state_path) or {}
    next_action = run_state.get("next_action") if isinstance(run_state.get("next_action"), dict) else {}
    role = str(run_state.get("role") or "unknown").strip().lower()
    if role not in {"runner", "supervisor"}:
        role = "unknown"

    description = str(next_action.get("description") or "")
    if not description:
        description = read_limited_text(next_action_path, max_chars=2000)

    return {
        "workspace": project.name,
        "role": role,
        "supervisor_mode": compact_control_text(
            config,
            str(run_state.get("supervisor_mode") or "unknown"),
            max_chars=80,
        ),
        "runner_started_count": safe_count_text(config, run_state.get("runner_started_count")),
        "runner_completed_count": safe_count_text(
            config,
            run_state.get("runner_completed_count") or run_state.get("runner_run_count"),
        ),
        "runner_failure_drift": safe_count_text(config, run_state.get("runner_failure_drift")),
        "status": compact_control_text(config, str(run_state.get("status") or "unknown"), max_chars=80),
        "blocker_type": safe_blocker_type(run_state.get("blocker_type"), allowed_blockers=allowed_blockers),
        "requires_human_review": bool(run_state.get("requires_human_review", False)),
        "updated_utc": compact_control_text(config, str(run_state.get("updated_utc") or ""), max_chars=80),
        "next_action": {
            "kind": compact_control_text(config, str(next_action.get("kind") or "unknown"), max_chars=80),
            "description": compact_control_text(config, description, max_chars=supervisor_text_max_chars),
            "can_execute_automatically": bool(next_action.get("can_execute_automatically", False)),
            "reason": compact_control_text(config, str(next_action.get("reason") or ""), max_chars=240),
        },
        "blockers_preview": compact_control_text(
            config,
            read_limited_text(blockers_path, max_chars=3000),
            max_chars=supervisor_text_max_chars,
        ),
        "files": {
            "run_state": run_state_path.exists(),
            "next_action": next_action_path.exists(),
            "blockers": blockers_path.exists(),
            "current_state": (agent_dir / "CURRENT_STATE.md").exists(),
            "anti_snowball": (agent_dir / "ANTI_SNOWBALL.md").exists(),
        },
    }


def workspace_supervisor_signals(
    config: Any,
    *,
    allowed_blockers: set[str] | frozenset[str],
    supervisor_text_max_chars: int,
) -> list[JsonObject]:
    return [
        workspace_supervisor_signal(
            config,
            project,
            allowed_blockers=allowed_blockers,
            supervisor_text_max_chars=supervisor_text_max_chars,
        )
        for project in sorted(getattr(config, "projects", {}).values(), key=lambda item: item.name)
    ]


def handle_health_summary(
    config: Any,
    principal: Any,
    *,
    deps: HealthSummaryDependencies,
    version: str,
    active_statuses: set[str] | frozenset[str],
    final_statuses: set[str] | frozenset[str],
    allowed_blockers: set[str] | frozenset[str],
    supervisor_text_max_chars: int,
) -> JsonObject:
    recent = deps.read_recent_task_summaries(config, principal, 50)
    active = [task for task in recent if task.get("status") in active_statuses]
    terminal = [task for task in recent if task.get("status") in final_statuses]
    projects = getattr(config, "projects", {})
    modes = sorted({mode for project in projects.values() for mode in getattr(project, "allowed_modes", ())})
    supervisor_signals = workspace_supervisor_signals(
        config,
        allowed_blockers=allowed_blockers,
        supervisor_text_max_chars=supervisor_text_max_chars,
    )
    blocked = [item for item in supervisor_signals if item.get("blocker_type") not in {"none", "unknown"}]
    review_required = [item for item in supervisor_signals if item.get("requires_human_review")]
    runner_drift = [
        item
        for item in supervisor_signals
        if str(item.get("runner_failure_drift") or "0").isdigit()
        and int(str(item.get("runner_failure_drift") or "0")) > 0
    ]
    return {
        "ok": True,
        "agent_host": {
            "active": True,
            "version": version,
        },
        "workspaces": {
            "count": len(projects),
            "modes": modes,
            "items": [
                {
                    "id": project.name,
                    "default_mode": getattr(project, "default_mode", "readonly"),
                    "allowed_modes": list(getattr(project, "allowed_modes", ("readonly",))),
                }
                for project in sorted(projects.values(), key=lambda item: item.name)
            ],
        },
        "tasks": {
            "recent_count": len(recent),
            "active_count": len(active),
            "terminal_count": len(terminal),
            "latest_terminal": terminal[0] if terminal else None,
        },
        "supervisor": {
            "workspace_count": len(supervisor_signals),
            "blocked_count": len(blocked),
            "review_required_count": len(review_required),
            "runner_drift_count": len(runner_drift),
            "signals": supervisor_signals,
        },
        "safety": {
            "safe_output": True,
            "raw_output": False,
            "host_ops_direct": False,
        },
    }


def safe_codex_status_text(config: Any, task: JsonObject, text: str) -> str:
    safe = str(text or "")
    project_alias = str(task.get("project") or "")
    project_path = str(task.get("project_path") or "")
    replacements: list[tuple[str, str]] = []
    if project_alias and project_path:
        replacements.append((project_path, f"[workspace:{project_alias}]"))
    for name, project in getattr(config, "projects", {}).items():
        replacements.append((str(project.root), f"[workspace:{name}]"))

    seen: set[str] = set()
    for raw_path, replacement in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        if not raw_path or raw_path in seen:
            continue
        seen.add(raw_path)
        safe = re.sub(re.escape(raw_path), replacement, safe)

    home = str(Path.home())
    if home:
        safe = re.sub(re.escape(home), "~", safe)

    if project_alias:
        safe = re.sub(
            r"^project_path:\s*.+$",
            f"project_path: [workspace:{project_alias}]",
            safe,
            flags=re.MULTILINE,
        )
    return safe_control_text(config, safe)
