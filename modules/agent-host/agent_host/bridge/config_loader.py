from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Callable

JsonObject = dict[str, Any]
ErrorFactory = Callable[[str, int], Exception]
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def parse_auth_principal(
    raw_principal: Any,
    *,
    auth_principal_factory: Callable[..., Any],
    error_factory: ErrorFactory,
    label: str,
) -> Any:
    if not isinstance(raw_principal, dict):
        raise error_factory(f"{label} entries must be objects", 500)
    user = str(raw_principal.get("user", "")).strip()
    role = str(raw_principal.get("role", "user")).strip() or "user"
    if not user:
        raise error_factory(f"{label} entry missing user", 500)
    return auth_principal_factory(user=user, role=role)


def load_auth_tokens(
    data: JsonObject,
    *,
    auth_principal_factory: Callable[..., Any],
    error_factory: ErrorFactory,
) -> dict[str, Any]:
    auth = data.get("auth", {})
    if auth is None:
        auth = {}
    if not isinstance(auth, dict):
        raise error_factory("auth must be an object", 500)

    raw_tokens = auth.get("tokens", {})
    if raw_tokens is None:
        raw_tokens = {}
    if not isinstance(raw_tokens, dict):
        raise error_factory("auth.tokens must be an object", 500)

    raw_token_env_map = auth.get("token_env_map", {})
    if raw_token_env_map is None:
        raw_token_env_map = {}
    if not isinstance(raw_token_env_map, dict):
        raise error_factory("auth.token_env_map must be an object", 500)

    tokens: dict[str, Any] = {}
    for token, raw_principal in raw_tokens.items():
        token = str(token).strip()
        if not token:
            raise error_factory("auth token may not be empty", 500)
        tokens[token] = parse_auth_principal(
            raw_principal,
            auth_principal_factory=auth_principal_factory,
            error_factory=error_factory,
            label="auth token",
        )

    for env_name, raw_principal in raw_token_env_map.items():
        env_name = str(env_name).strip()
        if not ENV_NAME_RE.match(env_name):
            raise error_factory(f"auth.token_env_map has invalid environment variable name: {env_name!r}", 500)
        token = os.environ.get(env_name, "").strip()
        if not token:
            raise error_factory(f"auth.token_env_map environment variable {env_name} is required", 500)
        if token in tokens:
            raise error_factory(f"duplicate auth token resolved from environment variable {env_name}", 500)
        tokens[token] = parse_auth_principal(
            raw_principal,
            auth_principal_factory=auth_principal_factory,
            error_factory=error_factory,
            label=f"auth.token_env_map[{env_name}]",
        )
    return tokens


def resolve_project_mapping(
    raw_projects: Any,
    *,
    project_name_re: Any,
    supported_modes: set[str] | frozenset[str],
    project_factory: Callable[..., Any],
    error_factory: ErrorFactory,
) -> dict[str, Any]:
    if not isinstance(raw_projects, dict) or not raw_projects:
        raise error_factory("config must define nonempty projects mapping", 500)

    projects: dict[str, Any] = {}
    for name, raw_project in raw_projects.items():
        if not isinstance(name, str) or not project_name_re.match(name):
            raise error_factory(f"invalid project name in config: {name!r}", 500)

        if isinstance(raw_project, str):
            root = raw_project
            label = name
            description = ""
            default_mode = "readonly"
            allowed_modes = ("readonly",)
        elif isinstance(raw_project, dict):
            root = str(raw_project.get("path") or raw_project.get("root") or "")
            label = str(raw_project.get("label") or name)
            description = str(raw_project.get("description") or "")
            default_mode = str(raw_project.get("default_mode") or "readonly")
            raw_modes = raw_project.get("allowed_modes") or [default_mode]
            if not isinstance(raw_modes, list):
                raise error_factory(f"project {name} allowed_modes must be a list", 500)
            allowed_modes = tuple(str(mode) for mode in raw_modes if str(mode))
        else:
            raise error_factory(f"project {name} must be a path string or object", 500)

        if not isinstance(root, str) or not root.startswith("/"):
            raise error_factory(f"project {name} root must be an absolute path", 500)
        if default_mode not in supported_modes:
            raise error_factory(f"project {name} has unsupported default_mode: {default_mode}", 500)
        if not allowed_modes or any(mode not in supported_modes for mode in allowed_modes):
            raise error_factory(f"project {name} has unsupported allowed_modes", 500)
        if default_mode not in allowed_modes:
            raise error_factory(f"project {name} default_mode must be in allowed_modes", 500)
        projects[name] = project_factory(
            name=name,
            root=Path(root).resolve(),
            label=label,
            description=description,
            default_mode=default_mode,
            allowed_modes=allowed_modes,
        )
    return projects


def load_config(
    path: Path,
    *,
    default_codex_bridge_root: Path,
    project_name_re: Any,
    supported_modes: set[str] | frozenset[str],
    project_factory: Callable[..., Any],
    bridge_config_factory: Callable[..., Any],
    auth_principal_factory: Callable[..., Any],
    error_factory: ErrorFactory,
) -> Any:
    if not path.exists():
        raise error_factory(f"config file not found: {path}", 500)
    data = json.loads(path.read_text())

    projects = resolve_project_mapping(
        data.get("projects"),
        project_name_re=project_name_re,
        supported_modes=supported_modes,
        project_factory=project_factory,
        error_factory=error_factory,
    )
    tokens = tuple(str(x) for x in data.get("mattermost_tokens", []) if str(x))
    allowed_users = tuple(str(x) for x in data.get("allowed_users", []) if str(x))
    codex_bridge_root = Path(str(data.get("codex_bridge_root", default_codex_bridge_root))).resolve()
    auth_tokens = load_auth_tokens(
        data,
        auth_principal_factory=auth_principal_factory,
        error_factory=error_factory,
    )

    return bridge_config_factory(
        host=str(data.get("host", "127.0.0.1")),
        port=int(data.get("port", 8787)),
        mattermost_tokens=tokens,
        allowed_users=allowed_users,
        projects=projects,
        codex_bridge_root=codex_bridge_root,
        codex_bridge_node_bin=str(data.get("codex_bridge_node_bin", "node")),
        auth_tokens=auth_tokens,
    )
