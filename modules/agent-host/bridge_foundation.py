from __future__ import annotations

import datetime as dt
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_BODY_BYTES = 64 * 1024
MAX_TASK_CHARS = 4000
MAX_RESPONSE_CHARS = 3500
AGENT_HOST_VERSION = "mvp-v0.7"
PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
CODEX_TASK_ID_RE = re.compile(r"^task_[A-Za-z0-9_.-]+$")
INTAKE_ID_RE = re.compile(r"^intake_[A-Za-z0-9_.-]+$")
SUPPORTED_CODEX_MODES = {"readonly", "workspace-write"}
TASK_LIST_DEFAULT_LIMIT = 50
TASK_LIST_MAX_LIMIT = 200
PROMPT_PREVIEW_CHARS = 110
RESULT_PAGE_DEFAULT_SIZE = 1800
RESULT_PAGE_MAX_SIZE = 8000
CODEX_FINAL_STATUSES = {"done", "failed", "cancelled", "timeout", "stale", "policy_violation"}
CODEX_ACTIVE_STATUSES = {"queued", "running", "cancelling", "cancel_requested"}
STREAM_TOKEN_TTL_SECONDS = 300
SSE_POLL_SECONDS = 1.0
SSE_HEARTBEAT_SECONDS = 15.0
SSE_LOG_TAIL_LINES = 200
SSE_LOG_MAX_CHARS = 20000
SSE_LOG_EVENT_MAX_CHARS = 8000
SUPERVISOR_TEXT_MAX_CHARS = 500
SUPERVISOR_ALLOWED_BLOCKERS = {
    "env",
    "queue",
    "permission",
    "reviewer",
    "model",
    "data",
    "stale_state",
    "none",
    "unknown",
}
STREAM_TOKENS: dict[str, dict[str, Any]] = {}
STREAM_TOKEN_LOCK = threading.Lock()


class BridgeError(Exception):
    def __init__(
        self,
        message: str,
        status: int = 400,
        code: str | None = None,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class Project:
    name: str
    root: Path
    label: str = ""
    description: str = ""
    default_mode: str = "readonly"
    allowed_modes: tuple[str, ...] = ("readonly",)


@dataclass(frozen=True)
class AuthPrincipal:
    user: str
    role: str


@dataclass(frozen=True)
class BridgeConfig:
    host: str
    port: int
    mattermost_tokens: tuple[str, ...]
    allowed_users: tuple[str, ...]
    projects: dict[str, Project]
    codex_bridge_root: Path
    codex_bridge_node_bin: str
    auth_tokens: dict[str, AuthPrincipal]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)
