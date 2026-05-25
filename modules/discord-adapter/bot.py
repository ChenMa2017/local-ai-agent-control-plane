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
    for action in ("status", "workspaces", "run", "task", "cancel"):
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


def authorize(config: AdapterConfig, guild_id: Any, channel_id: Any, user_id: Any) -> DiscordUser:
    guild = str(guild_id or "")
    channel = str(channel_id or "")
    user = str(user_id or "")
    if config.allowed_guild_ids and guild not in config.allowed_guild_ids:
        raise PermissionDenied("Permission denied: guild is not allowlisted.")
    if config.allowed_channel_ids and channel not in config.allowed_channel_ids:
        raise PermissionDenied("Permission denied: channel is not allowlisted.")
    if user not in config.users:
        raise PermissionDenied("Permission denied: user is not allowlisted.")
    return config.users[user]


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


FINAL_TASK_STATUSES = {"done", "failed", "cancelled", "timeout", "stale", "policy_violation"}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sanitize_discord_text(text: str) -> str:
    value = str(text or "")
    home = str(Path.home())
    if home:
        value = value.replace(home, "~")
    value = value.replace("/home/chenma", "~")
    value = json_safe_redactions(value)
    return value


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
        f"你可以用 {run_command} 创建任务，或用 {task_command} 查询结果。",
        "",
        f"系统版本：{capabilities.get('version', 'unknown')}",
    ]
    return "\n".join(lines)


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
    if reference_task_id:
        lines.append(f"参考任务：{reference_task_id}")
    lines.append(f"状态：{data.get('status', 'queued')}")
    if mode == "workspace-write":
        lines.append("写入审计：任务完成后会报告 changed files / protected path 状态。")
    if data.get("idempotent_replay"):
        lines.append("Idempotent replay: yes")
    lines.extend(["", thread_line])
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
        "Prompt:",
        prompt_preview(prompt, 900) or "(empty)",
        "",
        "我会在这里发送完成通知。",
    ])
    return "\n".join(lines)


def format_task_response(status_data: dict[str, Any], result_data: dict[str, Any], max_chars: int) -> str:
    status_text = str(status_data.get("text", ""))
    status = parse_status_text(status_text)
    result_text = str(result_data.get("text", "") or "")
    if status not in {"done", "policy_violation"}:
        return "\n".join([
            f"Task status: {status}",
            "",
            status_text.strip() or "(no status text)",
        ])
    summary, truncated = truncate_text(result_text.strip() or "(empty result)", max_chars)
    summary = sanitize_discord_text(summary)
    suffix = "\n\nResult truncated. Open Web UI for full result." if truncated else ""
    title = "Task done." if status == "done" else "Task finished with policy violation."
    return f"{title}\n\nResult:\n{summary}{suffix}"


def format_completion_message(task_id: str, status_data: dict[str, Any], result_data: dict[str, Any] | None, max_chars: int) -> str:
    status_text = str(status_data.get("text", ""))
    status = parse_status_text(status_text)
    if status in {"done", "policy_violation"} and result_data is not None:
        result_text = str(result_data.get("text", "") or "")
        summary, truncated = truncate_text(result_text.strip() or "(empty result)", max_chars)
        suffix = "\n\nResult truncated. Open local Web UI for the full safe result." if truncated else ""
        title = "任务完成。" if status == "done" else "任务触碰了 protected path policy，已结束。"
        return f"{title}\n\nTask: {task_id}\n\nResult:\n{sanitize_discord_text(summary)}{suffix}"
    short_status, _truncated = truncate_text(status_text.strip() or status, min(max_chars, 1000))
    return f"任务已结束：{status}\n\nTask: {task_id}\n\n{sanitize_discord_text(short_status)}"


class ThreadStateStore:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.path = state_dir / "task_threads.json"

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

    def pending(self) -> list[dict[str, Any]]:
        return [record for record in self.load().values() if not record.get("notified_done")]

    def update_status(self, task_id: str, status: str) -> None:
        records = self.load()
        if task_id in records:
            records[task_id]["last_status"] = status
            records[task_id]["updated_at"] = utc_now()
            self.save(records)

    def mark_notified(self, task_id: str, status: str) -> None:
        records = self.load()
        if task_id in records:
            records[task_id]["last_status"] = status
            records[task_id]["notified_done"] = True
            records[task_id]["notified_at"] = utc_now()
            records[task_id]["updated_at"] = utc_now()
            self.save(records)


async def process_completion_notifications(
    *,
    store: ThreadStateStore,
    agent: AgentHostClient,
    notifier: Any,
    max_result_chars: int,
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
        store.update_status(task_id, status)
        if status not in FINAL_TASK_STATUSES:
            continue
        result_data = agent.result(task_id, max_chars=max_result_chars) if status in {"done", "policy_violation"} else None
        message = format_completion_message(task_id, status_data, result_data, max_result_chars)
        await notifier.send(record, message)
        store.mark_notified(task_id, status)
        sent += 1
    return sent


def default_mode_for_workspace(workspaces: dict[str, Any], workspace: str) -> str:
    for item in workspaces.get("workspaces", []):
        if str(item.get("id", "")) == workspace:
            return str(item.get("default_mode") or "readonly")
    return "readonly"


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
                "/home/chenma",
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


def run_bot(config: AdapterConfig) -> None:
    if discord is None or app_commands is None:
        raise RuntimeError("discord.py is not installed. Run: python3 -m pip install -r requirements.txt")

    intents = discord.Intents.default()

    class AgentDiscordBot(discord.Client):
        def __init__(self) -> None:
            super().__init__(intents=intents)
            self.tree = app_commands.CommandTree(self)
            self.agent = build_client(config)
            self.thread_store = ThreadStateStore(config.state_dir)
            self._watcher_task: asyncio.Task[Any] | None = None
            self.register_commands()

        async def setup_hook(self) -> None:
            if config.discord_guild_id:
                guild = discord.Object(id=int(config.discord_guild_id))
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
            return authorize(config, interaction.guild_id, interaction.channel_id, interaction.user.id)

        async def reply_error(self, interaction: Any, error: Exception) -> None:
            text = format_error(error)
            if interaction.response.is_done():
                await interaction.followup.send(text, ephemeral=True)
            else:
                await interaction.response.send_message(text, ephemeral=True)

        async def completion_watcher(self) -> None:
            await self.wait_until_ready()
            while not self.is_closed():
                try:
                    await process_completion_notifications(
                        store=self.thread_store,
                        agent=self.agent,
                        notifier=self,
                        max_result_chars=config.max_result_chars,
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
            text, _truncated = truncate_text(sanitize_discord_text(message), 1900)
            await target.send(text)

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

            if isinstance(channel, discord.Thread):
                thread = channel
            elif hasattr(channel, "create_thread"):
                try:
                    thread = await channel.create_thread(
                        name=thread_name(task_id, workspace),
                        type=discord.ChannelType.public_thread,
                        auto_archive_duration=1440,
                        reason="Codex Agent task thread",
                    )
                except TypeError:
                    thread = await channel.create_thread(name=thread_name(task_id, workspace))
            else:
                return None

            await thread.send(format_thread_intro(task_id, workspace, mode, prompt, reference_task_id))
            self.thread_store.upsert_thread(
                task_id=task_id,
                guild_id=str(interaction.guild_id or ""),
                channel_id=str(interaction.channel_id or ""),
                thread_id=str(thread.id),
                created_by=str(interaction.user.id),
                workspace=workspace,
                status=status,
                reference_task_id=reference_task_id,
            )
            return thread

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
                    await interaction.followup.send(format_status(capabilities, tasks, workspaces, config.command_prefix), ephemeral=True)
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "workspaces"), description="List available Agent Host workspaces")
            async def agent_workspaces(interaction: Any) -> None:
                try:
                    self.require_user(interaction)
                    await interaction.response.defer(ephemeral=True, thinking=True)
                    await interaction.followup.send(format_workspaces(self.agent.workspaces()), ephemeral=True)
                except Exception as error:
                    await self.reply_error(interaction, error)

            @self.tree.command(name=slash_command_name(config.command_prefix, "run"), description="Create a Codex task")
            async def agent_run(interaction: Any, prompt: str, workspace: str = "", reference_task_id: str = "") -> None:
                try:
                    self.require_user(interaction)
                    clean_prompt = ensure_prompt_allowed(prompt, config.max_prompt_chars)
                    selected_workspace = str(workspace or config.default_workspace or "").strip()
                    if not selected_workspace:
                        raise ValueError("workspace is required; configure discord.default_workspace or pass workspace explicitly")
                    selected_reference_task_id = safe_reference_task_id(reference_task_id)
                    if not selected_reference_task_id and isinstance(interaction.channel, discord.Thread):
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
                    await interaction.followup.send(
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
                    result_data = self.agent.result(task_id, max_chars=config.max_result_chars)
                    await interaction.followup.send(
                        format_task_response(status_data, result_data, config.max_result_chars),
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
                    await interaction.followup.send(data.get("text") or "Task cancelled.", ephemeral=True)
                except Exception as error:
                    await self.reply_error(interaction, error)

    AgentDiscordBot().run(config.discord_bot_token)


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
