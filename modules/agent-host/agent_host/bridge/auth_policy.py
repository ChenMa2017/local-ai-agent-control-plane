from __future__ import annotations

import secrets
from typing import Any, Callable


def validate_auth(
    payload: dict[str, str],
    *,
    mattermost_tokens: tuple[str, ...],
    allowed_users: tuple[str, ...],
    error_factory: Callable[[str, int, str | None], Exception],
) -> None:
    token = payload.get("token", "")
    if mattermost_tokens and token not in mattermost_tokens:
        raise error_factory("unauthorized: invalid Mattermost token", 403, None)

    if allowed_users:
        user_name = payload.get("user_name", "")
        user_id = payload.get("user_id", "")
        if user_name not in allowed_users and user_id not in allowed_users:
            raise error_factory("unauthorized: Mattermost user is not allowlisted", 403, None)


def authenticate_bearer(
    authorization: str,
    *,
    auth_tokens: dict[str, Any],
    allowed_users: tuple[str, ...],
    error_factory: Callable[[str, int, str | None], Exception],
) -> Any:
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise error_factory("unauthorized: bearer token required", 401, "unauthorized")

    supplied = authorization[len(prefix) :].strip()
    if not supplied:
        raise error_factory("unauthorized: bearer token required", 401, "unauthorized")

    for token, principal in auth_tokens.items():
        if secrets.compare_digest(supplied, token):
            if allowed_users and getattr(principal, "user", "") not in allowed_users:
                raise error_factory("unauthorized: authenticated user is not allowlisted", 403, "permission_denied")
            return principal

    raise error_factory("unauthorized: invalid bearer token", 401, "unauthorized")


def reject_frontend_identity(
    payload: dict[str, str],
    *,
    error_factory: Callable[[str, int, str | None], Exception],
) -> None:
    forbidden = {"user", "user_name", "user_id", "internal_user"}
    present = sorted(forbidden.intersection(payload))
    if present:
        names = ", ".join(present)
        raise error_factory(
            f"user identity must come from bearer token, not request body ({names})",
            400,
            "invalid_request",
        )


def is_admin(principal: Any) -> bool:
    return str(getattr(principal, "role", "user")).lower() == "admin"


def can_access_task(task: dict[str, Any], principal: Any) -> bool:
    if is_admin(principal):
        return True
    return str(task.get("user", "")) == str(getattr(principal, "user", ""))


def can_access_intake(intent: dict[str, Any], principal: Any) -> bool:
    if is_admin(principal):
        return True
    return str(intent.get("user", "")) == str(getattr(principal, "user", ""))
