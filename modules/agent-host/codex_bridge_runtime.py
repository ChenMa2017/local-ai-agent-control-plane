from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Callable

ErrorFactory = Callable[[str, int, str | None], Exception]


def bool_from_payload(value: str) -> bool:
    return str(value).lower() in {"1", "true", "yes", "on"}


def write_codex_bridge_config(config: Any) -> Path:
    """Mirror the web adapter allowlists into the standalone codex-bridge config."""
    state_dir = Path(getattr(config, "codex_bridge_root")) / ".codex-bridge"
    state_dir.mkdir(parents=True, exist_ok=True)
    out = state_dir / "web-adapter.config.json"
    tmp = state_dir / f".web-adapter.{os.getpid()}.tmp"

    projects = {
        name: {
            "path": str(project.root),
            "mode": project.default_mode,
            "allowedModes": list(project.allowed_modes),
        }
        for name, project in sorted(getattr(config, "projects", {}).items())
    }
    data = {
        "version": 1,
        "users": list(getattr(config, "allowed_users", ())),
        "projects": projects,
        "stateDir": str(state_dir),
        "codexBin": "codex",
        "maxConcurrent": 1,
        "timeoutSeconds": 900,
        "cancelGraceMs": 5000,
        "watchdogIntervalMs": 1000,
        "dryRunStepMs": 450,
        "redaction": {
            "enabled": True,
            "redactHomePath": True,
            "redactProjectPaths": True,
            "redactTokens": True,
            "maxLogChars": 20000,
            "maxResultChars": 80000,
        },
        "generated_by": "mattermpst_chat web adapter",
    }
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, out)
    return out


def run_codex_bridge(
    config: Any,
    args: list[str],
    *,
    timeout: int = 20,
    write_bridge_config: Callable[[Any], Path] = write_codex_bridge_config,
    subprocess_run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    error_factory: ErrorFactory,
) -> subprocess.CompletedProcess[str]:
    script = Path(getattr(config, "codex_bridge_root")) / "scripts" / "codex-bridge.js"
    if not script.exists():
        raise error_factory(f"codex-bridge script not found: {script}", 500, None)
    bridge_config = write_bridge_config(config)
    bridged_args = [args[0], "--config", str(bridge_config), *args[1:]]

    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = ""
    return subprocess_run(
        [getattr(config, "codex_bridge_node_bin"), str(script), *bridged_args],
        cwd=str(getattr(config, "codex_bridge_root")),
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def require_success(
    result: subprocess.CompletedProcess[str],
    *,
    error_factory: ErrorFactory,
) -> str:
    output = (result.stdout or "").strip()
    if result.returncode == 0:
        return output
    error = (result.stderr or result.stdout or "codex-bridge command failed").strip()
    raise error_factory(error, 500, None)


def reconcile_codex_tasks(
    config: Any,
    *,
    run_bridge: Callable[[Any, list[str], int], subprocess.CompletedProcess[str]],
    error_factory: ErrorFactory,
) -> None:
    script = Path(getattr(config, "codex_bridge_root")) / "scripts" / "codex-bridge.js"
    if not script.exists():
        return
    result = run_bridge(config, ["reconcile"], 10)
    if result.returncode != 0:
        raise error_factory((result.stderr or result.stdout or "codex-bridge reconcile failed").strip(), 500, None)


def parse_queued_task_id(
    output: str,
    *,
    error_factory: ErrorFactory,
) -> str:
    for line in output.splitlines():
        match = re.match(r"^queued\s+(task_[A-Za-z0-9_.-]+)$", line.strip())
        if match:
            return match.group(1)
    raise error_factory("codex-bridge did not return a task id", 500, None)
