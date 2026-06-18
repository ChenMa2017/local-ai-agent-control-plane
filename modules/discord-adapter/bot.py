#!/usr/bin/env python3
"""Discord slash-command adapter for the local Agent Host API."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent_host_client import AgentHostClient, AgentHostError, parse_status_text, truncate_text

try:
    import discord
    from discord import app_commands
except ImportError:  # pragma: no cover - tested without requiring discord.py.
    discord = None
    app_commands = None


class PermissionDenied(Exception):
    pass


@dataclass(frozen=True)
class DiscordUser:
    internal_user: str
    role: str


@dataclass(frozen=True)
class AdapterConfig:
    agent_host_base_url: str
    agent_host_token: str
    agent_host_timeout_seconds: int
    discord_bot_token: str
    discord_guild_id: str
    allowed_guild_ids: tuple[str, ...]
    allowed_channel_ids: tuple[str, ...]
    default_workspace: str
    command_prefix: str
    users: dict[str, DiscordUser]
    max_prompt_chars: int
    max_result_chars: int
    state_dir: Path
    watcher_interval_seconds: int


def safe_command_prefix(value: Any) -> str:
    prefix = str(value or "agent").strip().lower().replace(" ", "_")
    if not re.match(r"^[a-z0-9_-]{1,20}$", prefix):
        raise ValueError("discord.command_prefix must be 1-20 lowercase letters, numbers, underscore, or dash")
    for action in ("status", "health", "workspaces", "prepare", "intake", "run", "task", "task_page", "cancel"):
        if len(slash_command_name(prefix, action)) > 32:
            raise ValueError("discord.command_prefix makes slash command names too long")
    return prefix


def slash_command_name(prefix: str, action: str) -> str:
    return f"{prefix}_{action}"


def load_config(path: Path) -> AdapterConfig:
    data = json.loads(path.read_text())
    agent_host = data.get("agent_host", {})
    discord_config = data.get("discord", {})
    limits = data.get("limits", {})
    state_dir = Path(str(data.get("state_dir", "state")))
    if not state_dir.is_absolute():
        state_dir = (path.parent / state_dir).resolve()

    agent_host_token = env_value(str(agent_host.get("token_env", "AGENT_HOST_TOKEN")))
    discord_bot_token = env_value(str(discord_config.get("bot_token_env", "DISCORD_BOT_TOKEN")))
    discord_guild_id = env_value(str(discord_config.get("guild_id_env", "DISCORD_GUILD_ID")), required=False)

    users: dict[str, DiscordUser] = {}
    for user_id, raw_user in dict(discord_config.get("users", {})).items():
        if not isinstance(raw_user, dict):
            raise ValueError("discord.users entries must be objects")
        users[str(user_id)] = DiscordUser(
            internal_user=str(raw_user.get("internal_user", "")),
            role=str(raw_user.get("role", "user") or "user"),
        )

    return AdapterConfig(
        agent_host_base_url=str(agent_host.get("base_url", "http://127.0.0.1:8787")).rstrip("/"),
        agent_host_token=agent_host_token,
        agent_host_timeout_seconds=int(agent_host.get("timeout_seconds", 30)),
        discord_bot_token=discord_bot_token,
        discord_guild_id=discord_guild_id,
        allowed_guild_ids=tuple(str(item) for item in discord_config.get("allowed_guild_ids", []) if str(item)),
        allowed_channel_ids=tuple(str(item) for item in discord_config.get("allowed_channel_ids", []) if str(item)),
        default_workspace=str(discord_config.get("default_workspace", "") or "").strip(),
        command_prefix=safe_command_prefix(discord_config.get("command_prefix", "agent")),
        users=users,
        max_prompt_chars=int(limits.get("max_prompt_chars", 3000)),
        max_result_chars=int(limits.get("max_result_chars", 1800)),
        state_dir=state_dir,
        watcher_interval_seconds=max(3, int(data.get("watcher_interval_seconds", 10))),
    )


def env_value(name: str, required: bool = True) -> str:
    value = os.environ.get(name, "").strip()
    if required and not value:
        raise ValueError(f"environment variable {name} is required")
    return value


def channel_candidates(channel_id: Any, channel: Any = None) -> tuple[str, ...]:
    candidates: list[str] = []
    for value in (
        channel_id,
        getattr(channel, "id", None) if channel is not None else None,
        getattr(channel, "parent_id", None) if channel is not None else None,
    ):
        text = str(value or "").strip()
        if text and text not in candidates:
            candidates.append(text)
    return tuple(candidates)


def authorize_candidates(config: AdapterConfig, guild_id: Any, candidate_channel_ids: tuple[str, ...], user_id: Any) -> DiscordUser:
    guild = str(guild_id or "")
    user = str(user_id or "")
    if config.allowed_guild_ids and guild not in config.allowed_guild_ids:
        raise PermissionDenied("Permission denied: guild is not allowlisted.")
    if config.allowed_channel_ids and not any(channel in config.allowed_channel_ids for channel in candidate_channel_ids):
        raise PermissionDenied("Permission denied: channel is not allowlisted.")
    if user not in config.users:
        raise PermissionDenied("Permission denied: user is not allowlisted.")
    return config.users[user]


def authorize(config: AdapterConfig, guild_id: Any, channel_id: Any, user_id: Any) -> DiscordUser:
    return authorize_candidates(config, guild_id, (str(channel_id or ""),), user_id)


def ensure_prompt_allowed(prompt: str, max_chars: int) -> str:
    text = str(prompt or "").strip()
    if not text:
        raise ValueError("prompt is required")
    if len(text) > max_chars:
        raise ValueError(f"prompt is too long; max {max_chars} chars")
    return text


def safe_reference_task_id(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    import re

    if not re.match(r"^task_[A-Za-z0-9_.-]+$", text):
        raise ValueError("reference_task_id must be a valid task id")
    return text


def safe_followup_task_id(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    import re

    if not re.match(r"^task_[A-Za-z0-9_.-]+$", text):
        raise ValueError("followup_task_id must be a valid task id")
    return text


def safe_intake_id(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if not re.match(r"^intake_[A-Za-z0-9_.-]+$", text):
        raise ValueError("intake_id must be a valid intake id")
    return text


def extract_task_id_from_text(text: str) -> str:
    for pattern in (
        r"(?im)^task_id:\s*(task_[A-Za-z0-9_.-]+)\s*$",
        r"(?im)^Task:\s*(task_[A-Za-z0-9_.-]+)\s*$",
        r"\b(task_[A-Za-z0-9_.-]+)\b",
    ):
        match = re.search(pattern, str(text or ""))
        if match:
            return match.group(1)
    return ""


FINAL_TASK_STATUSES = {"done", "failed", "cancelled", "timeout", "stale", "policy_violation"}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sanitize_discord_text(text: str) -> str:
    value = str(text or "")
    home = str(Path.home())
    if home:
        value = value.replace(home, "~")
    value = re.sub(r"/home/[^/\s]+", "~", value)
    value = json_safe_redactions(value)
    return value


def split_discord_text(text: str, max_chars: int = 1900) -> list[str]:
    value = sanitize_discord_text(text).strip() or "(empty message)"
    if len(value) <= max_chars:
        return [value]

    def split_unit(unit: str, limit: int) -> list[str]:
        piece = unit.strip()
        if not piece:
            return []
        if len(piece) <= limit:
            return [piece]

        chunks: list[str] = []
        current = ""
        for line in piece.splitlines():
            candidate = line if not current else f"{current}\n{line}"
            if len(candidate) <= limit:
                current = candidate
                continue
            if current:
                chunks.append(current)
                current = ""
            if len(line) <= limit:
                current = line
                continue
            words = line.split(" ")
            word_current = ""
            for word in words:
                word_candidate = word if not word_current else f"{word_current} {word}"
                if len(word_candidate) <= limit:
                    word_current = word_candidate
                    continue
                if word_current:
                    chunks.append(word_current)
                    word_current = ""
                if len(word) <= limit:
                    word_current = word
                    continue
                start = 0
                while start < len(word):
                    chunks.append(word[start:start + limit])
                    start += limit
            if word_current:
                current = word_current
        if current:
            chunks.append(current)
        return chunks

    paragraphs = value.split("\n\n")
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        parts = split_unit(paragraph, max_chars)
        if not parts:
            continue
        for part in parts:
            candidate = part if not current else f"{current}\n\n{part}"
            if len(candidate) <= max_chars:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                current = part
    if current:
        chunks.append(current)

    if len(chunks) <= 1:
        return chunks or [value[:max_chars]]

    labeled: list[str] = []
    total = len(chunks)
    for index, chunk in enumerate(chunks, start=1):
        label = f"[{index}/{total}] "
        if len(label) + len(chunk) <= max_chars:
            labeled.append(f"{label}{chunk}")
        else:
            labeled.append(f"{label}{chunk[: max_chars - len(label)]}".rstrip())
    return labeled


def json_safe_redactions(text: str) -> str:
    import re

    value = str(text or "")
    value = re.sub(r"Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+", "Authorization: Bearer [REDACTED]", value, flags=re.I)
    value = re.sub(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b", "[REDACTED_OPENAI_KEY]", value)
    value = re.sub(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b", "[REDACTED_GITHUB_TOKEN]", value)
    value = re.sub(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b", "[REDACTED_DISCORD_TOKEN]", value)
    value = re.sub(
        r"(?im)\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s]+)",
        r"\1=[REDACTED_SECRET]",
        value,
    )
    value = re.sub(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        "[REDACTED_PRIVATE_KEY]",
        value,
    )
    return value


def prompt_preview(prompt: str, max_chars: int = 500) -> str:
    text = " ".join(str(prompt or "").split())
    if len(text) <= max_chars:
        return sanitize_discord_text(text)
    return sanitize_discord_text(text[: max_chars - 1].rstrip() + "…")


def short_task_id(task_id: str) -> str:
    text = str(task_id or "task")
    if text.startswith("task_"):
        text = text[5:]
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in text)[-18:] or "task"


def thread_name(task_id: str, workspace: str) -> str:
    safe_workspace = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(workspace or "workspace"))
    return f"task-{short_task_id(task_id)}-{safe_workspace}"[:90]


def format_status(
    capabilities: dict[str, Any],
    tasks: dict[str, Any],
    workspaces: dict[str, Any] | None = None,
    command_prefix: str = "agent",
) -> str:
    features = capabilities.get("features", {})
    workspace_names = []
    if workspaces:
        workspace_names = [str(item.get("id", "")) for item in workspaces.get("workspaces", []) if item.get("id")]
    workspace_text = ", ".join(workspace_names) if workspace_names else "use /agent_workspaces to view them"
    write_enabled = bool(features.get("write_mode"))
    modes = ", ".join(str(mode) for mode in capabilities.get("modes", []) if mode) or "readonly"
    run_command = f"/{slash_command_name(command_prefix, 'run')}"
    intake_command = f"/{slash_command_name(command_prefix, 'intake')}"
    task_command = f"/{slash_command_name(command_prefix, 'task')}"
    lines = [
        "我在线，可以接收 Codex 任务。",
        "",
        "当前状态：",
        f"- 最近任务：{len(tasks.get('tasks', []))} 个",
        f"- 可用工作区：{workspace_text}",
        f"- 可用模式：{modes}",
        f"- 修改代码：{'已开启' if write_enabled else '未开启'}",
        f"- 取消/超时保护：{'可用' if features.get('cancel') and features.get('timeout') else '未完整启用'}",
        "",
        f"你可以用 {run_command} 创建任务，用 {intake_command} 查看 prepare intake，或用 {task_command} 查询结果。",
        "",
        f"系统版本：{capabilities.get('version', 'unknown')}",
    ]
    return "\n".join(lines)


def format_health_summary(data: dict[str, Any], command_prefix: str = "agent") -> str:
    agent = data.get("agent_host", {}) if isinstance(data.get("agent_host"), dict) else {}
    workspaces = data.get("workspaces", {}) if isinstance(data.get("workspaces"), dict) else {}
    tasks = data.get("tasks", {}) if isinstance(data.get("tasks"), dict) else {}
    supervisor = data.get("supervisor", {}) if isinstance(data.get("supervisor"), dict) else {}
    latest = tasks.get("latest_terminal") if isinstance(tasks.get("latest_terminal"), dict) else None
    workspace_items = workspaces.get("items") if isinstance(workspaces.get("items"), list) else []
    workspace_text = ", ".join(str(item.get("id")) for item in workspace_items if isinstance(item, dict) and item.get("id")) or "(none)"
    latest_text = "none"
    if latest:
        latest_text = f"{latest.get('task_id')} / {latest.get('status')}"
    lines = [
        "Agent Host 健康摘要：",
        "",
        f"- Agent Host: {'active' if agent.get('active') else 'unknown'}",
        f"- Version: {agent.get('version', 'unknown')}",
        f"- Workspaces: {workspace_text}",
        f"- Modes: {', '.join(workspaces.get('modes', []) or []) or '(none)'}",
        f"- Recent tasks: {tasks.get('recent_count', 0)}",
        f"- Active tasks: {tasks.get('active_count', 0)}",
        f"- Latest terminal task: {latest_text}",
    ]
    signals = supervisor.get("signals") if isinstance(supervisor.get("signals"), list) else []
    if signals:
        lines.extend(
            [
                "",
                "Supervisor signals:",
                f"- Blocked workspaces: {supervisor.get('blocked_count', 0)}",
                f"- Review required: {supervisor.get('review_required_count', 0)}",
                f"- Runner drift warnings: {supervisor.get('runner_drift_count', 0)}",
            ]
        )
        for signal in signals[:3]:
            if not isinstance(signal, dict):
                continue
            next_action = signal.get("next_action") if isinstance(signal.get("next_action"), dict) else {}
            next_text = str(next_action.get("description") or next_action.get("kind") or "none")
            if len(next_text) > 110:
                next_text = next_text[:107].rstrip() + "..."
            lines.append(
                f"- {signal.get('workspace', 'unknown')}: "
                f"status={signal.get('status', 'unknown')}, "
                f"mode={signal.get('supervisor_mode', 'unknown')}, "
                f"drift={signal.get('runner_failure_drift', 'unknown')}, "
                f"blocker={signal.get('blocker_type', 'unknown')}, "
                f"next={next_text or 'none'}"
            )
    lines.extend(
        [
            "",
            f"分页查看长结果：/{slash_command_name(command_prefix, 'task_page')} task_id:<id> page:1",
        ]
    )
    return sanitize_discord_text("\n".join(lines))


def format_workspaces(data: dict[str, Any]) -> str:
    workspaces = data.get("workspaces", [])
    if not workspaces:
        return "No workspaces available."
    lines = ["Available workspaces:", ""]
    for workspace in workspaces:
        modes = ", ".join(workspace.get("allowed_modes", [])) or workspace.get("default_mode", "readonly")
        lines.append(f"- {workspace.get('id')} ({modes})")
    return "\n".join(lines)


def format_run_response(
    data: dict[str, Any],
    workspace: str,
    thread_ref: str = "",
    reference_task_id: str = "",
    command_prefix: str = "agent",
) -> str:
    task_command = f"/{slash_command_name(command_prefix, 'task')}"
    thread_line = f"我会在这个 thread 里发送完成通知：{thread_ref}" if thread_ref else f"Thread 暂不可用；你仍可用 {task_command} 查询。"
    mode = data.get("mode", "readonly")
    lines = [
        "我开始处理了。",
        "",
        f"任务：{data.get('task_id')}",
        f"工作区：{workspace}",
        f"模式：{mode}",
    ]
    if data.get("intake_id"):
        lines.append(f"intake_id: {data.get('intake_id')}")
    if reference_task_id:
        lines.append(f"参考任务：{reference_task_id}")
    prepare_context = data.get("prepare_context") if isinstance(data.get("prepare_context"), dict) else {}
    if prepare_context.get("used"):
        lines.append(f"prepare: {prepare_context.get('objective') or 'unknown'}")
        if prepare_context.get("evidence_retrieval_decision"):
            lines.append(f"evidence: {prepare_context.get('evidence_retrieval_decision')}")
    lines.append(f"状态：{data.get('status', 'queued')}")
    if mode == "workspace-write":
        lines.append("写入审计：任务完成后会报告 changed files / protected path 状态。")
    if data.get("idempotent_replay"):
        lines.append("Idempotent replay: yes")
    lines.extend(["", thread_line])
    return "\n".join(lines).strip()


def format_prepare_response(
    data: dict[str, Any],
    workspace: str,
    command_prefix: str = "agent",
) -> str:
    intake_id = str(data.get("intake_id") or "")
    status = str(data.get("status") or "unknown")
    followup_task_id = str(data.get("followup_task_id") or "")
    contract = data.get("contract") if isinstance(data.get("contract"), dict) else {}
    preflight = data.get("preflight") if isinstance(data.get("preflight"), dict) else {}
    questions = data.get("questions") if isinstance(data.get("questions"), list) else []
    evidence = data.get("evidence_retrieval") if isinstance(data.get("evidence_retrieval"), dict) else {}
    followup_context = data.get("followup_context") if isinstance(data.get("followup_context"), dict) else {}
    lines = [
        "任务准备结果：",
        "",
        f"intake_id: {intake_id or '(missing)'}",
        f"workspace: {workspace}",
        f"status: {status}",
        f"objective: {contract.get('objective', 'unknown')}",
        f"risk_class: {contract.get('risk_class', 'unknown')}",
        f"preflight: {'ok' if preflight.get('ok') else 'blocked'}",
    ]
    if followup_task_id:
        lines.append(f"followup_from_task: {followup_task_id}")
    if followup_context:
        execution = followup_context.get("execution_evaluation") if isinstance(followup_context.get("execution_evaluation"), dict) else {}
        review_proposal = followup_context.get("review_proposal_draft") if isinstance(followup_context.get("review_proposal_draft"), dict) else {}
        ledger_note = followup_context.get("ledger_note_draft") if isinstance(followup_context.get("ledger_note_draft"), dict) else {}
        if execution:
            lines.append(
                "previous_result: "
                + sanitize_discord_text(
                    f"{execution.get('execution_decision') or 'unknown'} -> {execution.get('recommended_next_action') or 'review'}"
                )
            )
        if review_proposal:
            lines.append(
                "previous_review: "
                + sanitize_discord_text(
                    f"{review_proposal.get('review_scope') or 'none'} / "
                    + ("required" if review_proposal.get("requires_human_review") else "recommended")
                )
            )
        if ledger_note:
            lines.append("previous_ledger_note: ready")
    if evidence.get("required"):
        lines.append(f"evidence: {evidence.get('decision') or 'unavailable'}")
    if questions:
        lines.extend(["", "还需要你补充："])
        for idx, question in enumerate(questions, start=1):
            lines.append(f"{idx}. {sanitize_discord_text(str(question))}")
        lines.extend([
            "",
            f"继续方式：再次执行 /{slash_command_name(command_prefix, 'prepare')}，带上同一个 intake_id，并把回复写进 answers。",
        ])
    else:
        lines.extend([
            "",
            f"下一步：{preflight.get('required_action', 'review')}",
        ])
        if data.get("ready_to_run"):
            lines.append(f"这份 contract 已可执行；确认后可用 /{slash_command_name(command_prefix, 'run')} 正式创建任务。")
    reasons = preflight.get("reasons") if isinstance(preflight.get("reasons"), list) else []
    if reasons:
        lines.extend(["", "预检说明："])
        for reason in reasons[:3]:
            lines.append(f"- {sanitize_discord_text(str(reason))}")
    warnings = evidence.get("warnings") if isinstance(evidence.get("warnings"), list) else []
    if warnings:
        lines.extend(["", "证据提醒："])
        for warning in warnings[:3]:
            lines.append(f"- {sanitize_discord_text(str(warning))}")
    read_plan = evidence.get("read_plan") if isinstance(evidence.get("read_plan"), list) else []
    if read_plan:
        lines.extend(["", "建议先读："])
        for item in read_plan[:3]:
            if not isinstance(item, dict):
                continue
            path = sanitize_discord_text(str(item.get("path") or "unknown"))
            reason = sanitize_discord_text(str(item.get("reason") or ""))
            lines.append(f"- {path}" + (f": {reason}" if reason else ""))
    if evidence.get("required") and evidence.get("decision") not in {None, "", "safe_to_answer"}:
        lines.extend([
            "",
            "这类请求当前不应被当作正式已确认结论；请先按上面的 read plan 核对证据，或继续用 "
            f"/{slash_command_name(command_prefix, 'prepare')} 补充上下文。",
        ])
    return "\n".join(lines).strip()


def format_intake_response(data: dict[str, Any], command_prefix: str = "agent") -> str:
    intake_id = str(data.get("intake_id") or "")
    intent = data.get("intent") if isinstance(data.get("intent"), dict) else {}
    contract = data.get("contract") if isinstance(data.get("contract"), dict) else {}
    preflight = data.get("preflight") if isinstance(data.get("preflight"), dict) else {}
    evidence = data.get("evidence_retrieval") if isinstance(data.get("evidence_retrieval"), dict) else {}
    questions = data.get("questions") if isinstance(data.get("questions"), list) else []
    lines = [
        "Intake 状态：",
        "",
        f"intake_id: {intake_id or '(missing)'}",
        f"workspace: {intent.get('workspace') or contract.get('workspace') or 'unknown'}",
        f"status: {intent.get('status') or contract.get('status') or 'unknown'}",
        f"objective: {contract.get('objective', 'unknown')}",
        f"risk_class: {contract.get('risk_class', 'unknown')}",
        f"preflight: {'ok' if preflight.get('ok') else 'blocked'}",
        f"ready_to_run: {'yes' if data.get('ready_to_run') else 'no'}",
    ]
    if evidence.get("required"):
        lines.append(f"evidence: {evidence.get('decision') or 'unavailable'}")
    if questions:
        lines.extend(["", "还需要你补充："])
        for idx, question in enumerate(questions[:5], start=1):
            lines.append(f"{idx}. {sanitize_discord_text(str(question))}")
        lines.extend([
            "",
            f"继续方式：再次执行 /{slash_command_name(command_prefix, 'prepare')}，带上同一个 intake_id，并把回复写进 answers。",
        ])
    evaluation = data.get("execution_evaluation") if isinstance(data.get("execution_evaluation"), dict) else {}
    followup = data.get("followup_task_draft") if isinstance(data.get("followup_task_draft"), dict) else {}
    ledger_note = data.get("ledger_note_draft") if isinstance(data.get("ledger_note_draft"), dict) else {}
    review_proposal = data.get("review_proposal_draft") if isinstance(data.get("review_proposal_draft"), dict) else {}
    if evaluation:
        lines.extend(["", format_execution_evaluation(evaluation)])
    if followup:
        lines.extend(["", format_followup_task_draft(followup, command_prefix)])
    if ledger_note:
        lines.extend(["", format_ledger_note_draft(ledger_note)])
    if review_proposal:
        lines.extend(["", format_review_proposal_draft(review_proposal)])
    reasons = preflight.get("reasons") if isinstance(preflight.get("reasons"), list) else []
    if reasons:
        lines.extend(["", "预检说明："])
        for reason in reasons[:3]:
            lines.append(f"- {sanitize_discord_text(str(reason))}")
    return "\n".join(lines).strip()


def format_thread_intro(task_id: str, workspace: str, mode: str, prompt: str, reference_task_id: str = "") -> str:
    lines = [
        "任务已创建。",
        "",
        f"task_id: {task_id}",
        f"workspace: {workspace}",
        f"mode: {mode}",
    ]
    if reference_task_id:
        lines.append(f"reference_task_id: {reference_task_id}")
    if mode == "workspace-write":
        lines.extend([
            "",
            "Write audit:",
            "这是 workspace-write 任务。任务完成后会附带 changed files 和 protected path 检查摘要。",
        ])
    lines.extend([
        "",
        "**👤 你的提问**",
        prompt_preview(prompt, 900) or "(empty)",
        "",
        "**⏳ 等待 AI 回答**",
        "我会在这里发送完成通知。",
    ])
    return "\n".join(lines)


def format_execution_evaluation(evaluation: dict[str, Any]) -> str:
    decision = sanitize_discord_text(str(evaluation.get("execution_decision") or "unknown"))
    next_action = sanitize_discord_text(str(evaluation.get("recommended_next_action") or "review"))
    lines = [
        "Evaluation:",
        f"- decision: {decision}",
        f"- next: {next_action}",
    ]
    warnings = evaluation.get("warnings") if isinstance(evaluation.get("warnings"), list) else []
    if warnings:
        lines.append(f"- warning: {sanitize_discord_text(str(warnings[0]))}")
    return "\n".join(lines)


def format_followup_task_draft(draft: dict[str, Any], command_prefix: str = "agent") -> str:
    title = sanitize_discord_text(str(draft.get("title") or "Prepare the next bounded step"))
    next_action = sanitize_discord_text(str(draft.get("recommended_next_action") or "review"))
    lines = [
        "Follow-up draft:",
        f"- title: {title}",
        f"- next: {next_action}",
    ]
    if draft.get("requires_prepare"):
        source_task_id = sanitize_discord_text(str(draft.get("source_task_id") or draft.get("reference_task_id") or ""))
        prepare_command = f"/{slash_command_name(command_prefix, 'prepare')}"
        if source_task_id:
            lines.append(f"- use: {prepare_command} followup_task_id:{source_task_id}")
        else:
            lines.append(f"- use: {prepare_command}")
    return "\n".join(lines)


def format_ledger_note_draft(draft: dict[str, Any]) -> str:
    title = sanitize_discord_text(str(draft.get("title") or "Proposed ledger note"))
    target = sanitize_discord_text(str(draft.get("target_path_hint") or "research/LEDGER_NOTES.md"))
    lines = [
        "Ledger note draft:",
        f"- title: {title}",
        f"- target: {target}",
    ]
    return "\n".join(lines)


def format_review_proposal_draft(draft: dict[str, Any]) -> str:
    title = sanitize_discord_text(str(draft.get("title") or "Review proposal"))
    scope = sanitize_discord_text(str(draft.get("review_scope") or "none"))
    lines = [
        "Review proposal draft:",
        f"- title: {title}",
        f"- scope: {scope}",
        f"- required: {'yes' if draft.get('requires_human_review') else 'recommended'}",
    ]
    return "\n".join(lines)


def format_task_response(status_data: dict[str, Any], result_data: dict[str, Any], max_chars: int, command_prefix: str = "agent") -> str:
    status_text = str(status_data.get("text", ""))
    status = parse_status_text(status_text)
    result_text = str(result_data.get("text", "") or "")
    if status not in {"done", "policy_violation"}:
        return "\n".join([
            f"Task status: {status}",
            "",
            status_text.strip() or "(no status text)",
        ])
    summary = sanitize_discord_text(result_text.strip() or "(empty result)")
    title = "Task done." if status == "done" else "Task finished with policy violation."
    evaluation = result_data.get("execution_evaluation") if isinstance(result_data.get("execution_evaluation"), dict) else {}
    followup = result_data.get("followup_task_draft") if isinstance(result_data.get("followup_task_draft"), dict) else {}
    ledger_note = result_data.get("ledger_note_draft") if isinstance(result_data.get("ledger_note_draft"), dict) else {}
    review_proposal = result_data.get("review_proposal_draft") if isinstance(result_data.get("review_proposal_draft"), dict) else {}
    body = [title]
    if evaluation:
        body.extend(["", format_execution_evaluation(evaluation)])
    if followup:
        body.extend(["", format_followup_task_draft(followup, command_prefix)])
    if ledger_note:
        body.extend(["", format_ledger_note_draft(ledger_note)])
    if review_proposal:
        body.extend(["", format_review_proposal_draft(review_proposal)])
    body.extend(["", "Result:", summary])
    return "\n".join(body)


def format_task_page_response(data: dict[str, Any], max_chars: int, command_prefix: str = "agent") -> str:
    task_id = str(data.get("task_id") or "")
    intake_id = str(data.get("intake_id") or "")
    page = data.get("page", "?")
    total_pages = data.get("total_pages", "?")
    text = sanitize_discord_text(str(data.get("text") or ""))
    text, truncated = truncate_text(text, max_chars)
    evaluation = data.get("execution_evaluation") if isinstance(data.get("execution_evaluation"), dict) else {}
    followup = data.get("followup_task_draft") if isinstance(data.get("followup_task_draft"), dict) else {}
    ledger_note = data.get("ledger_note_draft") if isinstance(data.get("ledger_note_draft"), dict) else {}
    review_proposal = data.get("review_proposal_draft") if isinstance(data.get("review_proposal_draft"), dict) else {}
    suffix = ""
    if data.get("has_next"):
        suffix += f"\n\nNext page: {int(data.get('page', 1)) + 1}"
    if data.get("source_truncated"):
        suffix += "\n\nSource safe result was truncated by Agent Host limits."
    if truncated:
        suffix += "\n\nDiscord page output truncated."
    lines = [
        "Task result page",
        "",
        f"Task: {task_id}",
        f"Page: {page}/{total_pages}",
    ]
    if intake_id:
        lines.append(f"intake_id: {intake_id}")
    if page == 1:
        if evaluation:
            lines.extend(["", format_execution_evaluation(evaluation)])
        if followup:
            lines.extend(["", format_followup_task_draft(followup, command_prefix)])
        if ledger_note:
            lines.extend(["", format_ledger_note_draft(ledger_note)])
        if review_proposal:
            lines.extend(["", format_review_proposal_draft(review_proposal)])
    lines.extend(["", text + suffix])
    return "\n".join(lines)


def format_completion_message(
    task_id: str,
    status_data: dict[str, Any],
    result_data: dict[str, Any] | None,
    max_chars: int,
    command_prefix: str = "agent",
) -> str:
    status_text = str(status_data.get("text", ""))
    status = parse_status_text(status_text)
    if status in {"done", "policy_violation"} and result_data is not None:
        result_text = str(result_data.get("text", "") or "")
        title = "任务完成。" if status == "done" else "任务触碰了 protected path policy，已结束。"
        summary = sanitize_discord_text(result_text.strip() or "(empty result)")
        evaluation = result_data.get("execution_evaluation") if isinstance(result_data.get("execution_evaluation"), dict) else {}
        followup = result_data.get("followup_task_draft") if isinstance(result_data.get("followup_task_draft"), dict) else {}
        ledger_note = result_data.get("ledger_note_draft") if isinstance(result_data.get("ledger_note_draft"), dict) else {}
        review_proposal = result_data.get("review_proposal_draft") if isinstance(result_data.get("review_proposal_draft"), dict) else {}
        lines = [
            "**🤖 AI 回答**",
            "",
            title,
            "",
            f"Task: {task_id}",
        ]
        if evaluation:
            lines.extend(["", format_execution_evaluation(evaluation)])
        if followup:
            lines.extend(["", format_followup_task_draft(followup, command_prefix)])
        if ledger_note:
            lines.extend(["", format_ledger_note_draft(ledger_note)])
        if review_proposal:
            lines.extend(["", format_review_proposal_draft(review_proposal)])
        lines.extend(["", "Result:", summary])
        return "\n".join(lines)
    short_status, _truncated = truncate_text(status_text.strip() or status, min(max_chars, 1000))
    return f"**🤖 AI 回答**\n\n任务已结束：{status}\n\nTask: {task_id}\n\n{sanitize_discord_text(short_status)}"


class ThreadStateStore:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.path = state_dir / "task_threads.json"
        self.message_path = state_dir / "task_thread_messages.json"

    def load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text())
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(key): value for key, value in data.items() if isinstance(value, dict)}

    def save(self, records: dict[str, dict[str, Any]]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
        os.replace(temp, self.path)

    def load_messages(self) -> dict[str, dict[str, Any]]:
        if not self.message_path.exists():
            return {}
        try:
            data = json.loads(self.message_path.read_text())
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(key): value for key, value in data.items() if isinstance(value, dict)}

    def save_messages(self, records: dict[str, dict[str, Any]]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        temp = self.message_path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
        os.replace(temp, self.message_path)

    def upsert_thread(
        self,
        *,
        task_id: str,
        guild_id: str,
        channel_id: str,
        thread_id: str,
        created_by: str,
        workspace: str,
        status: str,
        reference_task_id: str = "",
    ) -> dict[str, Any]:
        records = self.load()
        existing = records.get(task_id, {})
        record = {
            **existing,
            "task_id": task_id,
            "guild_id": guild_id,
            "channel_id": channel_id,
            "thread_id": thread_id,
            "created_by": created_by,
            "workspace": workspace,
            "reference_task_id": reference_task_id or existing.get("reference_task_id") or "",
            "last_status": status,
            "notified_done": bool(existing.get("notified_done", False)),
            "created_at": existing.get("created_at") or utc_now(),
            "updated_at": utc_now(),
        }
        records[task_id] = record
        self.save(records)
        return record

    def remember_message(
        self,
        *,
        message_id: str,
        task_id: str,
        thread_id: str,
        workspace: str,
        kind: str,
    ) -> None:
        key = str(message_id or "").strip()
        if not key:
            return
        records = self.load_messages()
        records[key] = {
            "message_id": key,
            "task_id": task_id,
            "thread_id": thread_id,
            "workspace": workspace,
            "kind": kind,
            "updated_at": utc_now(),
        }
        self.save_messages(records)

    def task_id_for_thread(self, thread_id: str) -> str:
        thread = str(thread_id or "")
        if not thread:
            return ""
        matches = [
            record for record in self.load().values()
            if str(record.get("thread_id") or "") == thread
        ]
        if not matches:
            return ""
        matches.sort(key=lambda record: str(record.get("updated_at") or record.get("created_at") or ""), reverse=True)
        return str(matches[0].get("task_id") or "")

    def latest_record_for_thread(self, thread_id: str) -> dict[str, Any]:
        thread = str(thread_id or "")
        if not thread:
            return {}
        matches = [
            record for record in self.load().values()
            if str(record.get("thread_id") or "") == thread
        ]
        if not matches:
            return {}
        matches.sort(key=lambda record: str(record.get("updated_at") or record.get("created_at") or ""), reverse=True)
        return matches[0]

    def task_id_for_message(self, message_id: str) -> str:
        record = self.load_messages().get(str(message_id or "").strip(), {})
        return str(record.get("task_id") or "")

    def pending(self) -> list[dict[str, Any]]:
        return [record for record in self.load().values() if not record.get("notified_done")]

    def update_status(self, task_id: str, status: str) -> None:
        records = self.load()
        if task_id in records:
            records[task_id]["last_status"] = status
            records[task_id]["updated_at"] = utc_now()
            self.save(records)

    def mark_notified(self, task_id: str, status: str, repaired: bool = False) -> None:
        records = self.load()
        if task_id in records:
            records[task_id]["last_status"] = status
            records[task_id]["notified_done"] = True
            records[task_id]["notified_at"] = utc_now()
            if repaired:
                records[task_id]["repaired_at"] = utc_now()
            records[task_id]["updated_at"] = utc_now()
            self.save(records)


async def process_completion_notifications(
    *,
    store: ThreadStateStore,
    agent: AgentHostClient,
    notifier: Any,
    max_result_chars: int,
    command_prefix: str = "agent",
) -> int:
    sent = 0
    for record in store.pending():
        task_id = str(record.get("task_id") or "")
        if not task_id:
            continue
        try:
            status_data = agent.status(task_id)
        except AgentHostError:
            continue
        status = parse_status_text(str(status_data.get("text", "")))
        previous_status = str(record.get("last_status") or "")
        store.update_status(task_id, status)
        if status not in FINAL_TASK_STATUSES:
            continue
        repaired = previous_status in FINAL_TASK_STATUSES
        result_data = agent.result(task_id, max_chars=None) if status in {"done", "policy_violation"} else None
        message = format_completion_message(task_id, status_data, result_data, max_result_chars, command_prefix)
        await notifier.send(record, message)
        store.mark_notified(task_id, status, repaired=repaired)
        sent += 1
    return sent


def default_mode_for_workspace(workspaces: dict[str, Any], workspace: str) -> str:
    for item in workspaces.get("workspaces", []):
        if str(item.get("id", "")) == workspace:
            return str(item.get("default_mode") or "readonly")
    return "readonly"


def resolve_reference_task_id_from_reply(
    store: ThreadStateStore,
    *,
    thread_id: str,
    referenced_message_id: str = "",
    referenced_message_text: str = "",
) -> str:
    task_id = store.task_id_for_message(referenced_message_id)
    if task_id:
        return task_id
    task_id = extract_task_id_from_text(referenced_message_text)
    if task_id:
        return task_id
    return store.task_id_for_thread(thread_id)


def format_error(error: Exception) -> str:
    if isinstance(error, AgentHostError):
        return f"{error.code}: {error}"
    return str(error)


def build_client(config: AdapterConfig) -> AgentHostClient:
    return AgentHostClient(
        base_url=config.agent_host_base_url,
        token=config.agent_host_token,
        timeout_seconds=config.agent_host_timeout_seconds,
    )


def validate_check_config(config: AdapterConfig, cwd: Path | None = None) -> list[tuple[str, bool, str]]:
    cwd = (cwd or Path.cwd()).resolve()
    checks: list[tuple[str, bool, str]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, ok, detail))

    add("DISCORD_BOT_TOKEN present", bool(config.discord_bot_token))
    add("DISCORD_GUILD_ID present", bool(config.discord_guild_id))
    add("AGENT_HOST_TOKEN present", bool(config.agent_host_token))
    add("allowed_guild_ids nonempty", bool(config.allowed_guild_ids))
    add("allowed_channel_ids nonempty", bool(config.allowed_channel_ids))
    add("default_workspace configured", bool(config.default_workspace), config.default_workspace)
    add("command_prefix configured", bool(config.command_prefix), config.command_prefix)
    add("users mapping nonempty", bool(config.users))

    client = build_client(config)
    try:
        health = client.health()
        add("Agent Host /health", health.get("ok") is True)
    except Exception as error:
        add("Agent Host /health", False, safe_check_error(error))

    try:
        capabilities = client.capabilities()
        add("/codex/capabilities", capabilities.get("ok") is True and bool(capabilities.get("features")))
    except Exception as error:
        add("/codex/capabilities", False, safe_check_error(error))

    try:
        workspaces = client.workspaces()
        text = json.dumps(workspaces, ensure_ascii=False)
        leaked = any(
            marker and marker in text
            for marker in (
                str(Path.home()),
                str(cwd),
                os.getcwd(),
            )
        )
        add("/codex/workspaces", workspaces.get("ok") is True and bool(workspaces.get("workspaces")))
        add("/codex/workspaces path redaction", not leaked)
        workspace_ids = {str(item.get("id", "")) for item in workspaces.get("workspaces", [])}
        add("default_workspace available", bool(config.default_workspace) and config.default_workspace in workspace_ids)
    except Exception as error:
        add("/codex/workspaces", False, safe_check_error(error))
        add("/codex/workspaces path redaction", False, "workspaces unavailable")
        add("default_workspace available", False, "workspaces unavailable")

    return checks


def safe_check_error(error: Exception) -> str:
    text = format_error(error)
    for value in (os.environ.get("DISCORD_BOT_TOKEN", ""), os.environ.get("AGENT_HOST_TOKEN", "")):
        if value:
            text = text.replace(value, "[REDACTED]")
    return text


def run_check_config(config: AdapterConfig) -> int:
    checks = validate_check_config(config)
    failed = False
    for name, ok, detail in checks:
        status = "OK" if ok else "FAIL"
        suffix = f" - {detail}" if detail else ""
        print(f"{status} {name}{suffix}")
        failed = failed or not ok
    return 1 if failed else 0


def build_discord_bot(
    config: AdapterConfig,
    *,
    discord_module: Any | None = None,
    app_commands_module: Any | None = None,
    agent: AgentHostClient | None = None,
) -> Any:
    discord_module = discord if discord_module is None else discord_module
    app_commands_module = app_commands if app_commands_module is None else app_commands_module
    if discord_module is None or app_commands_module is None:
        raise RuntimeError("discord.py is not installed. Run: python3 -m pip install -r requirements.txt")

    intents = discord_module.Intents.default()
    intents.message_content = True
    agent_client = agent or build_client(config)

    class AgentDiscordBot(discord_module.Client):
        def __init__(self) -> None:
            super().__init__(intents=intents)
            self.tree = app_commands_module.CommandTree(self)
            self.agent = agent_client
            self.thread_store = ThreadStateStore(config.state_dir)
            self._watcher_task: asyncio.Task[Any] | None = None
            self.register_commands()

        async def setup_hook(self) -> None:
            if config.discord_guild_id:
                guild = discord_module.Object(id=int(config.discord_guild_id))
                self.tree.copy_global_to(guild=guild)
                await self.tree.sync(guild=guild)
            else:
                await self.tree.sync()

        async def on_ready(self) -> None:
            assert self.user is not None
            print(f"discord agent adapter logged in as {self.user} ({self.user.id})", flush=True)
            if self._watcher_task is None or self._watcher_task.done():
                self._watcher_task = asyncio.create_task(self.completion_watcher())

        async def close(self) -> None:
            if self._watcher_task is not None:
                self._watcher_task.cancel()
            await super().close()

        def require_user(self, interaction: Any) -> DiscordUser:
            return authorize_candidates(
                config,
                interaction.guild_id,
                channel_candidates(interaction.channel_id, getattr(interaction, "channel", None)),
                interaction.user.id,
            )

        def require_message_user(self, message: Any) -> DiscordUser:
            return authorize_candidates(
                config,
                getattr(message.guild, "id", None),
                channel_candidates(getattr(message.channel, "id", None), message.channel),
                getattr(message.author, "id", None),
            )

        async def reply_error(self, interaction: Any, error: Exception) -> None:
            text = format_error(error)
            if interaction.response.is_done():
                await self.send_followup_text(interaction, text, ephemeral=True)
            else:
                await self.send_response_text(interaction, text, ephemeral=True)

        async def send_response_text(self, interaction: Any, text: str, *, ephemeral: bool) -> None:
            chunks = split_discord_text(text, 1900)
            if not chunks:
                return
            await interaction.response.send_message(chunks[0], ephemeral=ephemeral)
            for chunk in chunks[1:]:
                await interaction.followup.send(chunk, ephemeral=ephemeral)

        async def send_followup_text(self, interaction: Any, text: str, *, ephemeral: bool) -> None:
            chunks = split_discord_text(text, 1900)
            for chunk in chunks:
                await interaction.followup.send(chunk, ephemeral=ephemeral)

        async def send_target_text(self, target: Any, text: str) -> list[Any]:
            sent_messages: list[Any] = []
            for chunk in split_discord_text(text, 1900):
                sent_messages.append(await target.send(chunk))
            return sent_messages

        async def completion_watcher(self) -> None:
            await self.wait_until_ready()
            while not self.is_closed():
                try:
                    await process_completion_notifications(
                        store=self.thread_store,
                        agent=self.agent,
                        notifier=self,
                        max_result_chars=config.max_result_chars,
                        command_prefix=config.command_prefix,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    print(f"completion watcher error: {safe_check_error(error)}", file=sys.stderr, flush=True)
                await asyncio.sleep(config.watcher_interval_seconds)

        async def send(self, record: dict[str, Any], message: str) -> None:
            thread_id = str(record.get("thread_id") or "")
            if not thread_id:
                return
            target = self.get_channel(int(thread_id))
            if target is None:
                target = await self.fetch_channel(int(thread_id))
            sent_messages = await self.send_target_text(target, message)
            for sent in sent_messages:
                self.thread_store.remember_message(
                    message_id=str(getattr(sent, "id", "") or ""),
                    task_id=str(record.get("task_id") or ""),
                    thread_id=thread_id,
                    workspace=str(record.get("workspace") or ""),
                    kind="completion",
                )

        async def attach_task_to_thread(
            self,
            *,
            thread: Any,
            guild_id: str,
            channel_id: str,
            created_by: str,
            task_id: str,
            workspace: str,
            mode: str,
            prompt: str,
            status: str,
            reference_task_id: str = "",
        ) -> None:
            intro_messages = await self.send_target_text(
                thread,
                format_thread_intro(task_id, workspace, mode, prompt, reference_task_id),
            )
            self.thread_store.upsert_thread(
                task_id=task_id,
                guild_id=guild_id,
                channel_id=channel_id,
                thread_id=str(thread.id),
                created_by=created_by,
                workspace=workspace,
                status=status,
                reference_task_id=reference_task_id,
            )
            for intro in intro_messages:
                self.thread_store.remember_message(
                    message_id=str(getattr(intro, "id", "") or ""),
                    task_id=task_id,
                    thread_id=str(thread.id),
                    workspace=workspace,
                    kind="thread_intro",
                )

        async def create_task_thread(
            self,
            interaction: Any,
            task_id: str,
            workspace: str,
            mode: str,
            prompt: str,
            status: str,
            reference_task_id: str = "",
        ) -> Any | None:
            channel = interaction.channel
            if channel is None and interaction.channel_id:
                channel = await self.fetch_channel(int(interaction.channel_id))
            if channel is None:
                return None

            if isinstance(channel, discord_module.Thread):
                thread = channel
            elif hasattr(channel, "create_thread"):
                try:
                    thread = await channel.create_thread(
                        name=thread_name(task_id, workspace),
                        type=discord_module.ChannelType.public_thread,
                        auto_archive_duration=1440,
                        reason="Codex Agent task thread",
                    )
                except TypeError:
                    thread = await channel.create_thread(name=thread_name(task_id, workspace))
            else:
                return None

            await self.attach_task_to_thread(
                thread=thread,
                guild_id=str(interaction.guild_id or ""),
                channel_id=str(interaction.channel_id or ""),
                created_by=str(interaction.user.id),
                task_id=task_id,
                workspace=workspace,
                mode=mode,
                prompt=prompt,
                status=status,
                reference_task_id=reference_task_id,
            )
            return thread

        async def on_message(self, message: Any) -> None:
            if self.user is None:
                return
            if getattr(message.author, "bot", False):
                return
            if not isinstance(getattr(message, "channel", None), discord_module.Thread):
                return
            if not str(getattr(message, "content", "") or "").strip():
                return
            if str(message.content).lstrip().startswith("/"):
                return
            record = self.thread_store.latest_record_for_thread(str(message.channel.id))
            if not record:
                return
            if not getattr(message, "reference", None) or not getattr(message.reference, "message_id", None):
                return
            try:
                self.require_message_user(message)
            except PermissionDenied:
                return

            referenced_message_id = str(message.reference.message_id or "")
            referenced_message = getattr(message.reference, "resolved", None)
            if referenced_message is None:
                try:
                    referenced_message = await message.channel.fetch_message(int(referenced_message_id))
                except Exception:
                    referenced_message = None
            referenced_text = ""
            if referenced_message is not None:
                if self.user is not None and getattr(getattr(referenced_message, "author", None), "id", None) != self.user.id:
                    return
                referenced_text = str(getattr(referenced_message, "content", "") or "")

            reference_task_id = resolve_reference_task_id_from_reply(
                self.thread_store,
                thread_id=str(message.channel.id),
                referenced_message_id=referenced_message_id,
                referenced_message_text=referenced_text,
            )
            if not reference_task_id:
                return

            workspace = str(record.get("workspace") or config.default_workspace or "").strip()
            if not workspace:
                return

            try:
                workspaces = self.agent.workspaces()
                mode = default_mode_for_workspace(workspaces, workspace)
                data = self.agent.run(
                    workspace=workspace,
                    prompt=ensure_prompt_allowed(str(message.content or ""), config.max_prompt_chars),
                    mode=mode,
                    source_user_id=str(message.author.id),
                    source_channel_id=str(message.channel.id),
                    source_message_id=str(message.id),
                    idempotency_key=f"discord-message:{message.id}",
                    guild_id=str(getattr(message.guild, "id", "") or ""),
                    reference_task_id=reference_task_id,
                    command_name="discord_reply",
                )
                task_id = str(data.get("task_id") or "")
                if task_id:
                    await self.attach_task_to_thread(
                        thread=message.channel,
                        guild_id=str(getattr(message.guild, "id", "") or ""),
                        channel_id=str(getattr(message.channel, "parent_id", None) or getattr(message.channel, "id", "") or ""),
                        created_by=str(message.author.id),
                        task_id=task_id,
                        workspace=workspace,
                        mode=str(data.get("mode") or mode),
                        prompt=str(message.content or ""),
                        status=str(data.get("status", "queued")),
                        reference_task_id=reference_task_id,
                    )
            except Exception as error:
                text = sanitize_discord_text(format_error(error))
                if text:
                    await self.send_target_text(message.channel, f"无法创建 follow-up task：{text}")

        def register_commands(self) -> None:
            @self.tree.command(name=slash_command_name(config.command_prefix, "status"), description="Check the local Agent Host status")
            async def agent_status(interaction: Any) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    self.agent.health()
                    capabilities = self.agent.capabilities()
                    tasks = self.agent.tasks(limit=5)
                    workspaces = self.agent.workspaces()
                    await self.send_followup_text(
                        interaction,
                        format_status(capabilities, tasks, workspaces, config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "health"), description="Show safe Agent Host health summary")
            async def agent_health(interaction: Any) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    await self.send_followup_text(
                        interaction,
                        format_health_summary(self.agent.health_summary(), config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "workspaces"), description="List available Agent Host workspaces")
            async def agent_workspaces(interaction: Any) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    await self.send_followup_text(interaction, format_workspaces(self.agent.workspaces()), ephemeral=True)
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "prepare"), description="Prepare a task contract and clarification questions")
            async def agent_prepare(
                interaction: Any,
                prompt: str = "",
                workspace: str = "",
                intake_id: str = "",
                answers: str = "",
                reference_task_id: str = "",
                followup_task_id: str = "",
            ) -> None:
                try:
                    self.require_user(interaction)
                    clean_prompt = str(prompt or "").strip()
                    if clean_prompt and len(clean_prompt) > config.max_prompt_chars:
                        raise ValueError(f"prompt is too long; max {config.max_prompt_chars} chars")
                    selected_intake_id = safe_intake_id(intake_id)
                    selected_answers = str(answers or "").strip()
                    if len(selected_answers) > config.max_prompt_chars:
                        raise ValueError(f"answers is too long; max {config.max_prompt_chars} chars")
                    selected_reference_task_id = safe_reference_task_id(reference_task_id)
                    selected_followup_task_id = safe_followup_task_id(followup_task_id)
                    if not selected_reference_task_id and isinstance(interaction.channel, discord_module.Thread):
                        selected_reference_task_id = self.thread_store.task_id_for_thread(str(interaction.channel.id))
                    if not selected_followup_task_id and isinstance(interaction.channel, discord_module.Thread) and not clean_prompt and not selected_intake_id:
                        selected_followup_task_id = self.thread_store.task_id_for_thread(str(interaction.channel.id))
                    selected_workspace = str(workspace or "").strip()
                    if not selected_workspace and isinstance(interaction.channel, discord_module.Thread):
                        selected_workspace = str(self.thread_store.latest_record_for_thread(str(interaction.channel.id)).get("workspace") or "").strip()
                    if not selected_workspace and not selected_intake_id and not selected_followup_task_id:
                        selected_workspace = str(config.default_workspace or "").strip()
                    if not selected_workspace and not selected_intake_id and not selected_followup_task_id:
                        raise ValueError("workspace is required; configure discord.default_workspace or pass workspace explicitly")
                    if not clean_prompt and not selected_intake_id and not selected_followup_task_id:
                        raise ValueError("prompt is required unless you are continuing an existing intake_id or follow-up task")
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    mode = default_mode_for_workspace(self.agent.workspaces(), selected_workspace) if selected_workspace else None
                    data = self.agent.prepare(
                        workspace=selected_workspace,
                        prompt=clean_prompt,
                        source_user_id=str(interaction.user.id),
                        source_channel_id=str(interaction.channel_id or ""),
                        source_message_id=str(interaction.id),
                        guild_id=str(interaction.guild_id or ""),
                        intake_id=selected_intake_id or None,
                        answers=selected_answers or None,
                        mode=mode,
                        reference_task_id=selected_reference_task_id or None,
                        followup_task_id=selected_followup_task_id or None,
                        command_name=f"/{slash_command_name(config.command_prefix, 'prepare')}",
                    )
                    response_workspace = str(data.get("workspace") or selected_workspace or config.default_workspace or "").strip()
                    await self.send_followup_text(
                        interaction,
                        format_prepare_response(data, response_workspace, config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "intake"), description="Show saved intake state by intake_id")
            async def agent_intake(interaction: Any, intake_id: str) -> None:
                try:
                    self.require_user(interaction)
                    selected_intake_id = safe_intake_id(intake_id)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    data = self.agent.intake(selected_intake_id)
                    await self.send_followup_text(
                        interaction,
                        format_intake_response(data, config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "run"), description="Create a Codex task")
            async def agent_run(
                interaction: Any,
                prompt: str = "",
                workspace: str = "",
                reference_task_id: str = "",
                intake_id: str = "",
            ) -> None:
                try:
                    self.require_user(interaction)
                    clean_prompt = str(prompt or "").strip()
                    if clean_prompt and len(clean_prompt) > config.max_prompt_chars:
                        raise ValueError(f"prompt is too long; max {config.max_prompt_chars} chars")
                    selected_intake_id = safe_intake_id(intake_id)
                    if not clean_prompt and not selected_intake_id:
                        raise ValueError("prompt is required unless you are continuing an existing intake_id")
                    selected_workspace = str(workspace or config.default_workspace or "").strip()
                    if not selected_workspace:
                        raise ValueError("workspace is required; configure discord.default_workspace or pass workspace explicitly")
                    selected_reference_task_id = safe_reference_task_id(reference_task_id)
                    if not selected_reference_task_id and isinstance(interaction.channel, discord_module.Thread):
                        selected_reference_task_id = self.thread_store.task_id_for_thread(str(interaction.channel.id))
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    mode = default_mode_for_workspace(self.agent.workspaces(), selected_workspace)
                    data = self.agent.run(
                        workspace=selected_workspace,
                        prompt=clean_prompt,
                        mode=mode,
                        source_user_id=str(interaction.user.id),
                        source_channel_id=str(interaction.channel_id or ""),
                        source_message_id=str(interaction.id),
                        idempotency_key=f"discord:{interaction.id}",
                        guild_id=str(interaction.guild_id or ""),
                        intake_id=selected_intake_id or None,
                        reference_task_id=selected_reference_task_id or None,
                        command_name=f"/{slash_command_name(config.command_prefix, 'run')}",
                    )
                    task_id = str(data.get("task_id") or "")
                    thread_ref = ""
                    if task_id:
                        try:
                            thread = await self.create_task_thread(
                                interaction,
                                task_id,
                                selected_workspace,
                                str(data.get("mode") or mode),
                                clean_prompt,
                                str(data.get("status", "queued")),
                                selected_reference_task_id,
                            )
                            if thread is not None:
                                thread_ref = getattr(thread, "mention", "") or f"thread {thread.id}"
                        except Exception as error:
                            print(f"task thread creation failed: {safe_check_error(error)}", file=sys.stderr, flush=True)
                    await self.send_followup_text(
                        interaction,
                        format_run_response(data, selected_workspace, thread_ref, selected_reference_task_id, config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "task"), description="Show task status and safe result summary")
            async def agent_task(interaction: Any, task_id: str) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    status_data = self.agent.status(task_id)
                    result_data = self.agent.result(task_id, max_chars=None)
                    await self.send_followup_text(
                        interaction,
                        format_task_response(status_data, result_data, config.max_result_chars, config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "task_page"), description="Show one page of a long safe task result")
            async def agent_task_page(interaction: Any, task_id: str, page: int = 1) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    data = self.agent.result_page(task_id, page=page, page_size=config.max_result_chars)
                    await self.send_followup_text(
                        interaction,
                        format_task_page_response(data, config.max_result_chars, config.command_prefix),
                        ephemeral=True,
                    )
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "cancel"), description="Cancel a running Codex task")
            async def agent_cancel(interaction: Any, task_id: str) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    data = self.agent.cancel(task_id)
                    await self.send_followup_text(interaction, data.get("text") or "Task cancelled.", ephemeral=True)
                except Exception as error:
                    await self.reply_error(interaction, error)

    return AgentDiscordBot()


def run_bot(config: AdapterConfig) -> None:
    build_discord_bot(config).run(config.discord_bot_token)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Discord Adapter for the local Agent Host")
    parser.add_argument("--config", default="config.json", help="path to config JSON")
    parser.add_argument("--check-config", action="store_true", help="validate config and Agent Host connectivity")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        config = load_config(Path(args.config))
        if args.check_config:
            return run_check_config(config)
        run_bot(config)
    except Exception as error:
        print(safe_check_error(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
