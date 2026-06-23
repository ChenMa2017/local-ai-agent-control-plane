#!/usr/bin/env python3
"""Run a real operator smoke baseline against the local Agent Host service."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

DEFAULT_AGENT_HOST_CONFIG = ROOT / "modules" / "agent-host" / "config.json"
DEFAULT_AGENT_HOST_CONFIG_EXAMPLE = ROOT / "modules" / "agent-host" / "config.example.json"
DEFAULT_DISCORD_CONFIG = ROOT / "modules" / "discord-adapter" / "config.json"
DEFAULT_DISCORD_CONFIG_EXAMPLE = ROOT / "modules" / "discord-adapter" / "config.example.json"
DEFAULT_SECRETS_ENV = Path.home() / ".config" / "agent-host" / "secrets.env"
DEFAULT_SOURCE = "server_smoke_baseline"
DEFAULT_RESULT_PAGE_SIZE = 4000
DEFAULT_POLL_INTERVAL_SECONDS = 2.0
DEFAULT_TIMEOUT_SECONDS = 180.0
DEFAULT_HTTP_TIMEOUT_SECONDS = 15.0
DEFAULT_PROMPT = (
    "This is a local server smoke baseline. "
    "Please return a short safe confirmation that the task ran successfully. "
    "Do not modify files unless the configured mode explicitly requires it."
)

FINAL_TASK_STATUSES = {"done", "failed", "cancelled", "timeout", "stale", "policy_violation"}


class SmokeError(RuntimeError):
    """Raised when the smoke baseline fails."""


@dataclass(frozen=True)
class ServiceState:
    unit: str
    active: bool
    raw: str


def preferred_config(actual: Path, example: Path) -> Path:
    return actual if actual.exists() else example


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.exists():
        raise SmokeError(f"{label} config is missing: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SmokeError(f"{label} config is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SmokeError(f"{label} config must be a JSON object: {path}")
    return data


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def normalize_agent_host_base_url(host: str, port: int) -> str:
    normalized_host = str(host or "").strip() or "127.0.0.1"
    if normalized_host in {"0.0.0.0", "::", "[::]", "localhost"}:
        normalized_host = "127.0.0.1"
    if ":" in normalized_host and not normalized_host.startswith("["):
        normalized_host = f"[{normalized_host}]"
    return f"http://{normalized_host}:{int(port)}"


def resolve_base_url(agent_host_config: dict[str, Any], discord_config: dict[str, Any]) -> str:
    discord_agent_host = discord_config.get("agent_host")
    if isinstance(discord_agent_host, dict):
        base_url = str(discord_agent_host.get("base_url") or "").strip()
        if base_url:
            return base_url.rstrip("/")
    host = str(agent_host_config.get("host") or "").strip()
    port = int(agent_host_config.get("port") or 0)
    if not port:
        raise SmokeError("agent-host config does not define a usable port")
    return normalize_agent_host_base_url(host, port)


def resolve_token_env_name(
    discord_config: dict[str, Any],
    agent_host_config: dict[str, Any],
    override: str | None,
) -> str:
    if override:
        return override
    discord_agent_host = discord_config.get("agent_host")
    if isinstance(discord_agent_host, dict):
        env_name = str(discord_agent_host.get("token_env") or "").strip()
        if env_name:
            return env_name
    auth = agent_host_config.get("auth")
    if isinstance(auth, dict):
        token_env_map = auth.get("token_env_map")
        if isinstance(token_env_map, dict):
            for env_name in token_env_map.keys():
                text = str(env_name).strip()
                if text and "ADMIN" not in text:
                    return text
            for env_name in token_env_map.keys():
                text = str(env_name).strip()
                if text:
                    return text
    raise SmokeError("could not resolve Agent Host token environment variable name")


def resolve_secret_value(env_name: str, env_file_values: dict[str, str]) -> str:
    current = os.environ.get(env_name)
    if current:
        return current
    file_value = env_file_values.get(env_name, "")
    if file_value:
        return file_value
    raise SmokeError(f"required secret is missing: {env_name}")


def run_control_plane_validation(
    *,
    agent_host_config: Path,
    discord_config: Path,
    secrets_env: Path,
) -> dict[str, Any]:
    command = [
        sys.executable,
        str(ROOT / "scripts" / "control_plane.py"),
        "config",
        "validate",
        "--json",
        "--agent-host-config",
        str(agent_host_config),
        "--discord-config",
        str(discord_config),
        "--secrets-env",
        str(secrets_env),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    stdout = completed.stdout.strip()
    if not stdout:
        raise SmokeError("control-plane validation returned no JSON output")
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise SmokeError(
            "control-plane validation produced invalid JSON: "
            f"exit={completed.returncode} stderr={completed.stderr.strip()}"
        ) from exc
    if not isinstance(report, dict):
        raise SmokeError("control-plane validation produced a non-object JSON report")
    return report


def systemd_is_active(unit: str) -> ServiceState:
    completed = subprocess.run(
        ["systemctl", "--user", "is-active", unit],
        capture_output=True,
        text=True,
        check=False,
    )
    raw = (completed.stdout or completed.stderr or "").strip() or f"exit={completed.returncode}"
    return ServiceState(unit=unit, active=completed.returncode == 0 and raw == "active", raw=raw)


def join_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def http_json(
    method: str,
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    data: bytes | None = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(join_url(base_url, path), data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"raw_body": body}
        message = parsed.get("error") or parsed.get("message") or parsed.get("text") or body or exc.reason
        raise SmokeError(f"{method} {path} failed with HTTP {exc.code}: {message}") from exc
    except urllib.error.URLError as exc:
        raise SmokeError(f"{method} {path} failed: {exc.reason}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise SmokeError(f"{method} {path} returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise SmokeError(f"{method} {path} returned a non-object JSON payload")
    return parsed


def ensure_ok(label: str, payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("ok") is not True:
        raise SmokeError(f"{label} returned ok={payload.get('ok')!r}")
    return payload


def workspace_by_id(workspaces: list[dict[str, Any]], workspace_id: str) -> dict[str, Any] | None:
    for item in workspaces:
        if str(item.get("id") or "") == workspace_id:
            return item
    return None


def select_workspace(
    workspaces: list[dict[str, Any]],
    *,
    requested_workspace: str | None,
    default_workspace: str | None,
    prefer_readonly: bool,
) -> dict[str, Any]:
    if not workspaces:
        raise SmokeError("Agent Host returned no visible workspaces")
    if requested_workspace:
        item = workspace_by_id(workspaces, requested_workspace)
        if item is None:
            raise SmokeError(f"requested workspace is not visible: {requested_workspace}")
        return item
    if prefer_readonly and default_workspace:
        item = workspace_by_id(workspaces, default_workspace)
        if item is not None and str(item.get("default_mode") or "") == "readonly":
            return item
    if prefer_readonly:
        for item in workspaces:
            if str(item.get("default_mode") or "") == "readonly":
                return item
    if default_workspace:
        item = workspace_by_id(workspaces, default_workspace)
        if item is not None:
            return item
    return workspaces[0]


def build_prepare_payload(
    *,
    workspace_id: str,
    mode: str,
    prompt: str,
    source: str,
    idempotency_key: str,
    metadata: dict[str, Any],
) -> dict[str, str]:
    return {
        "workspace": workspace_id,
        "mode": mode,
        "prompt": prompt,
        "source": source,
        "idempotency_key": idempotency_key,
        "metadata": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
    }


def build_run_payload(
    *,
    workspace_id: str,
    mode: str,
    intake_id: str,
    source: str,
    idempotency_key: str,
    metadata: dict[str, Any],
    dry_run: bool,
) -> dict[str, str]:
    payload = {
        "workspace": workspace_id,
        "mode": mode,
        "intake_id": intake_id,
        "source": source,
        "idempotency_key": idempotency_key,
        "metadata": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
    }
    if dry_run:
        payload["dry_run"] = "true"
    return payload


def find_task_summary(tasks_payload: dict[str, Any], task_id: str) -> dict[str, Any] | None:
    tasks = tasks_payload.get("tasks")
    if not isinstance(tasks, list):
        return None
    for item in tasks:
        if isinstance(item, dict) and str(item.get("task_id") or "") == task_id:
            return item
    return None


def wait_for_terminal_task(
    *,
    base_url: str,
    token: str,
    task_id: str,
    workspace_id: str,
    timeout_seconds: float,
    poll_interval_seconds: float,
    http_timeout_seconds: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    deadline = time.time() + timeout_seconds
    seen_statuses: list[dict[str, Any]] = []
    last_status: str | None = None
    while time.time() < deadline:
        tasks = ensure_ok(
            "GET /codex/tasks",
            http_json(
                "GET",
                base_url,
                f"/codex/tasks?limit=200&project={urllib.parse.quote(workspace_id, safe='')}",
                token=token,
                timeout_seconds=http_timeout_seconds,
            ),
        )
        summary = find_task_summary(tasks, task_id)
        if summary is not None:
            status = str(summary.get("status") or "")
            if status != last_status:
                seen_statuses.append({"status": status, "updated_at": summary.get("updated_at")})
                last_status = status
            if status in FINAL_TASK_STATUSES:
                return summary, seen_statuses
        time.sleep(poll_interval_seconds)
    raise SmokeError(f"task did not reach a terminal status before timeout: {task_id}")


def summarize_control_plane_report(report: dict[str, Any]) -> dict[str, Any]:
    findings = report.get("findings")
    warning_codes: list[str] = []
    if isinstance(findings, list):
        for item in findings:
            if isinstance(item, dict) and str(item.get("level") or "") == "warning":
                warning_codes.append(str(item.get("code") or "warning"))
    return {
        "status": str(report.get("status") or "unknown"),
        "warning_codes": warning_codes,
    }


def truncate_text(value: Any, limit: int = 300) -> str:
    text = str(value or "")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a real local Agent Host smoke baseline.")
    parser.add_argument(
        "--agent-host-config",
        default=str(preferred_config(DEFAULT_AGENT_HOST_CONFIG, DEFAULT_AGENT_HOST_CONFIG_EXAMPLE)),
    )
    parser.add_argument(
        "--discord-config",
        default=str(preferred_config(DEFAULT_DISCORD_CONFIG, DEFAULT_DISCORD_CONFIG_EXAMPLE)),
    )
    parser.add_argument("--secrets-env", default=str(DEFAULT_SECRETS_ENV))
    parser.add_argument("--workspace", help="Exact workspace alias to use.")
    parser.add_argument("--mode", help="Override workspace mode for prepare/run.")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--token-env-name", help="Override the Agent Host bearer token env name.")
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--poll-interval-seconds", type=float, default=DEFAULT_POLL_INTERVAL_SECONDS)
    parser.add_argument("--http-timeout-seconds", type=float, default=DEFAULT_HTTP_TIMEOUT_SECONDS)
    parser.add_argument("--result-page-size", type=int, default=DEFAULT_RESULT_PAGE_SIZE)
    parser.add_argument("--dry-run", action="store_true", help="Pass dry_run=true to /codex/run.")
    parser.add_argument(
        "--no-prefer-readonly",
        action="store_false",
        dest="prefer_readonly",
        help="When no workspace is specified, do not auto-prefer a readonly workspace.",
    )
    parser.set_defaults(prefer_readonly=True)
    parser.add_argument(
        "--skip-control-plane-preflight",
        action="store_true",
        help="Skip scripts/control_plane.py config validate.",
    )
    parser.add_argument(
        "--skip-service-check",
        action="store_true",
        help="Skip systemd user service activity checks.",
    )
    parser.add_argument(
        "--skip-discord-service-check",
        action="store_true",
        help="Only require agent-host-web.service to be active.",
    )
    parser.add_argument("--json", action="store_true", help="Print the final report as JSON.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    agent_host_config_path = Path(args.agent_host_config)
    discord_config_path = Path(args.discord_config)
    secrets_env_path = Path(args.secrets_env)

    try:
        agent_host_config = load_json(agent_host_config_path, "agent-host")
        discord_config = load_json(discord_config_path, "discord-adapter")
        env_file_values = parse_env_file(secrets_env_path)

        preflight_summary: dict[str, Any] | None = None
        if not args.skip_control_plane_preflight:
            preflight_report = run_control_plane_validation(
                agent_host_config=agent_host_config_path,
                discord_config=discord_config_path,
                secrets_env=secrets_env_path,
            )
            preflight_summary = summarize_control_plane_report(preflight_report)
            if str(preflight_report.get("status") or "") == "error":
                raise SmokeError("control-plane preflight reported status=error")

        service_states: list[ServiceState] = []
        if not args.skip_service_check:
            service_states.append(systemd_is_active("agent-host-web.service"))
            if not args.skip_discord_service_check:
                service_states.append(systemd_is_active("discord-agent-adapter.service"))
            inactive = [state for state in service_states if not state.active]
            if inactive:
                detail = ", ".join(f"{item.unit}={item.raw}" for item in inactive)
                raise SmokeError(f"required user services are not active: {detail}")

        base_url = resolve_base_url(agent_host_config, discord_config)
        token_env_name = resolve_token_env_name(discord_config, agent_host_config, args.token_env_name)
        token = resolve_secret_value(token_env_name, env_file_values)

        health = ensure_ok("GET /health", http_json("GET", base_url, "/health", timeout_seconds=args.http_timeout_seconds))
        whoami = ensure_ok("GET /whoami", http_json("GET", base_url, "/whoami", token=token, timeout_seconds=args.http_timeout_seconds))
        health_summary = ensure_ok(
            "GET /health/summary",
            http_json("GET", base_url, "/health/summary", token=token, timeout_seconds=args.http_timeout_seconds),
        )
        workspaces_payload = ensure_ok(
            "GET /codex/workspaces",
            http_json("GET", base_url, "/codex/workspaces", token=token, timeout_seconds=args.http_timeout_seconds),
        )

        workspaces_raw = workspaces_payload.get("workspaces")
        if not isinstance(workspaces_raw, list):
            raise SmokeError("GET /codex/workspaces returned no workspace list")
        workspaces = [item for item in workspaces_raw if isinstance(item, dict)]
        default_workspace = ""
        discord_section = discord_config.get("discord")
        if isinstance(discord_section, dict):
            default_workspace = str(discord_section.get("default_workspace") or "").strip()
        workspace = select_workspace(
            workspaces,
            requested_workspace=args.workspace,
            default_workspace=default_workspace or None,
            prefer_readonly=bool(args.prefer_readonly),
        )
        workspace_id = str(workspace.get("id") or "")
        if not workspace_id:
            raise SmokeError("selected workspace is missing id")
        mode = str(args.mode or workspace.get("default_mode") or "").strip()
        if not mode:
            raise SmokeError(f"selected workspace has no usable mode: {workspace_id}")

        idempotency_key = f"server-smoke-{time.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
        metadata = {
            "kind": "server_smoke_baseline",
            "workspace": workspace_id,
            "mode": mode,
            "prefer_readonly": bool(args.prefer_readonly),
        }

        prepare = ensure_ok(
            "POST /codex/prepare",
            http_json(
                "POST",
                base_url,
                "/codex/prepare",
                token=token,
                payload=build_prepare_payload(
                    workspace_id=workspace_id,
                    mode=mode,
                    prompt=args.prompt,
                    source=args.source,
                    idempotency_key=idempotency_key,
                    metadata=metadata,
                ),
                timeout_seconds=args.http_timeout_seconds,
            ),
        )
        intake_id = str(prepare.get("intake_id") or "")
        if not intake_id:
            raise SmokeError("prepare response did not include intake_id")
        preflight = prepare.get("preflight")
        if not isinstance(preflight, dict) or not preflight.get("ok"):
            raise SmokeError(f"prepare preflight is not runnable: {json.dumps(preflight, ensure_ascii=False)}")
        taskbox = prepare.get("taskbox")
        if not isinstance(taskbox, dict) or str(taskbox.get("status") or "") != "ready":
            raise SmokeError(f"prepare taskbox is not ready: {json.dumps(taskbox, ensure_ascii=False)}")

        run_response = ensure_ok(
            "POST /codex/run",
            http_json(
                "POST",
                base_url,
                "/codex/run",
                token=token,
                payload=build_run_payload(
                    workspace_id=workspace_id,
                    mode=mode,
                    intake_id=intake_id,
                    source=args.source,
                    idempotency_key=idempotency_key,
                    metadata=metadata,
                    dry_run=bool(args.dry_run),
                ),
                timeout_seconds=args.http_timeout_seconds,
            ),
        )
        task_id = str(run_response.get("task_id") or "")
        if not task_id:
            raise SmokeError("run response did not include task_id")

        status_probe = ensure_ok(
            "GET /codex/status",
            http_json(
                "GET",
                base_url,
                f"/codex/status?task_id={urllib.parse.quote(task_id, safe='')}",
                token=token,
                timeout_seconds=args.http_timeout_seconds,
            ),
        )
        task_summary, status_timeline = wait_for_terminal_task(
            base_url=base_url,
            token=token,
            task_id=task_id,
            workspace_id=workspace_id,
            timeout_seconds=float(args.timeout_seconds),
            poll_interval_seconds=float(args.poll_interval_seconds),
            http_timeout_seconds=float(args.http_timeout_seconds),
        )
        final_status = str(task_summary.get("status") or "")
        if final_status != "done":
            raise SmokeError(f"task finished with unexpected status={final_status}")

        result_page = ensure_ok(
            "GET /codex/result-page",
            http_json(
                "GET",
                base_url,
                (
                    "/codex/result-page?"
                    f"task_id={urllib.parse.quote(task_id, safe='')}&page=1&page_size={int(args.result_page_size)}"
                ),
                token=token,
                timeout_seconds=args.http_timeout_seconds,
            ),
        )
        result_text = str(result_page.get("text") or "")
        if not result_text.strip():
            raise SmokeError("result-page returned empty text")

        intake_bundle = ensure_ok(
            "GET /codex/intake",
            http_json(
                "GET",
                base_url,
                f"/codex/intake?intake_id={urllib.parse.quote(intake_id, safe='')}",
                token=token,
                timeout_seconds=args.http_timeout_seconds,
            ),
        )

        report = {
            "ok": True,
            "kind": "server_smoke_baseline",
            "base_url": base_url,
            "workspace": workspace_id,
            "mode": mode,
            "dry_run": bool(args.dry_run),
            "token_env_name": token_env_name,
            "preflight": preflight_summary,
            "service_states": [state.__dict__ for state in service_states],
            "whoami": {"user": whoami.get("user"), "role": whoami.get("role")},
            "health": health,
            "health_summary_ok": bool(health_summary.get("ok")),
            "prepare": {
                "intake_id": intake_id,
                "status": prepare.get("status"),
                "preflight_ok": preflight.get("ok") if isinstance(preflight, dict) else None,
                "taskbox_status": taskbox.get("status") if isinstance(taskbox, dict) else None,
            },
            "run": {
                "task_id": task_id,
                "queued_status": run_response.get("status"),
                "idempotent_replay": run_response.get("idempotent_replay"),
            },
            "status_probe": {
                "command": status_probe.get("command"),
                "text_preview": truncate_text(status_probe.get("text")),
            },
            "task_summary": task_summary,
            "status_timeline": status_timeline,
            "result_page": {
                "page": result_page.get("page"),
                "page_size": result_page.get("page_size"),
                "total_pages": result_page.get("total_pages"),
                "total_chars": result_page.get("total_chars"),
                "text_preview": truncate_text(result_text, 500),
            },
            "intake": {
                "intake_id": intake_bundle.get("intake_id"),
                "status": intake_bundle.get("status"),
            },
        }
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print("server smoke baseline: OK")
            print(f"base_url: {base_url}")
            print(f"workspace: {workspace_id} ({mode})")
            print(f"user: {whoami.get('user')} ({whoami.get('role')})")
            if preflight_summary is not None:
                print(f"control-plane preflight: {preflight_summary['status']}")
            for state in service_states:
                print(f"service {state.unit}: {state.raw}")
            print(f"intake_id: {intake_id}")
            print(f"task_id: {task_id}")
            print(f"final_status: {final_status}")
            print(f"result_preview: {truncate_text(result_text, 200)}")
        return 0
    except SmokeError as exc:
        report = {
            "ok": False,
            "kind": "server_smoke_baseline",
            "error": str(exc),
            "agent_host_config": str(agent_host_config_path),
            "discord_config": str(discord_config_path),
            "secrets_env": str(secrets_env_path),
        }
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(f"server smoke baseline: FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
