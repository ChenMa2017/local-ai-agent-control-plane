#!/usr/bin/env python3
"""Small HTTP client for the local Agent Host API.

This adapter deliberately talks only to the Agent Host API. It does not know
where workspaces live on disk and does not execute Codex directly.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class AgentHostError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str = "internal_error",
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class AgentHostClient:
    base_url: str
    token: str
    timeout_seconds: int = 30

    def __post_init__(self) -> None:
        if not self.base_url:
            raise ValueError("base_url is required")
        if not self.token:
            raise ValueError("token is required")
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        if query:
            clean_query = {
                str(key): str(value)
                for key, value in query.items()
                if value is not None and str(value) != ""
            }
            if clean_query:
                url = f"{url}?{urllib.parse.urlencode(clean_query)}"

        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return self._decode_response(response.read())
        except urllib.error.HTTPError as exc:
            raise self._decode_error(exc) from exc
        except urllib.error.URLError as exc:
            raise AgentHostError(f"Agent Host unavailable: {exc.reason}", code="unavailable") from exc

    @staticmethod
    def _decode_response(raw: bytes) -> dict[str, Any]:
        text = raw.decode("utf-8", errors="replace")
        try:
            data = json.loads(text or "{}")
        except json.JSONDecodeError as exc:
            raise AgentHostError(f"Agent Host returned invalid JSON: {exc}", code="invalid_response") from exc
        if not isinstance(data, dict):
            raise AgentHostError("Agent Host returned non-object JSON", code="invalid_response")
        if data.get("ok") is False:
            raise error_from_payload(data)
        return data

    @staticmethod
    def _decode_error(exc: urllib.error.HTTPError) -> AgentHostError:
        raw = exc.read()
        try:
            data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        except json.JSONDecodeError:
            return AgentHostError(f"Agent Host HTTP {exc.code}", status=exc.code, code="http_error")
        error = error_from_payload(data)
        error.status = exc.code
        return error

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health", auth=False)

    def capabilities(self) -> dict[str, Any]:
        return self._request("GET", "/codex/capabilities")

    def workspaces(self) -> dict[str, Any]:
        return self._request("GET", "/codex/workspaces")

    def tasks(self, limit: int = 5) -> dict[str, Any]:
        return self._request("GET", "/codex/tasks", query={"limit": limit})

    def run(
        self,
        *,
        workspace: str,
        prompt: str,
        mode: str | None = None,
        source_user_id: str,
        source_channel_id: str,
        source_message_id: str,
        idempotency_key: str,
        guild_id: str | None = None,
        reference_task_id: str | None = None,
        command_name: str = "/agent_run",
    ) -> dict[str, Any]:
        payload = {
            "workspace": workspace,
            "prompt": prompt,
            "source": "discord",
            "source_user_id": source_user_id,
            "source_channel_id": source_channel_id,
            "source_message_id": source_message_id,
            "idempotency_key": idempotency_key,
            "metadata": {
                "guild_id": guild_id or "",
                "command": command_name,
            },
        }
        if mode:
            payload["mode"] = mode
        if reference_task_id:
            payload["reference_task_id"] = reference_task_id
        return self._request(
            "POST",
            "/codex/run",
            payload,
        )

    def status(self, task_id: str) -> dict[str, Any]:
        return self._request("POST", "/codex/status", {"task_id": task_id})

    def result(self, task_id: str, max_chars: int | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"task_id": task_id}
        if max_chars:
            payload["max_chars"] = str(max_chars)
        return self._request("POST", "/codex/result", payload)

    def cancel(self, task_id: str) -> dict[str, Any]:
        return self._request("POST", "/codex/cancel", {"task_id": task_id})


def error_from_payload(data: dict[str, Any]) -> AgentHostError:
    raw_error = data.get("error")
    if isinstance(raw_error, dict):
        message = str(raw_error.get("message") or data.get("text") or "Agent Host error")
        code = str(raw_error.get("code") or "internal_error")
        details = raw_error.get("details") if isinstance(raw_error.get("details"), dict) else {}
    else:
        message = str(data.get("text") or "Agent Host error")
        code = str(data.get("error") or "internal_error")
        details = {}
    return AgentHostError(message, code=code, details=details)


def parse_status_text(text: str) -> str:
    match = re.search(r"^status:\s*([A-Za-z0-9_.-]+)", str(text or ""), re.MULTILINE)
    return match.group(1) if match else "unknown"


def truncate_text(text: str, max_chars: int) -> tuple[str, bool]:
    value = str(text or "")
    limit = max(1, int(max_chars))
    if len(value) <= limit:
        return value, False
    marker = "\n\n[truncated]"
    return value[: max(1, limit - len(marker))].rstrip() + marker, True
