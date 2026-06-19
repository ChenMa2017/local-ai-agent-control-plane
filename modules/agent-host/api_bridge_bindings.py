from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from auth_policy import (
    authenticate_bearer as authenticate_bearer_principal,
    reject_frontend_identity as reject_frontend_payload_identity,
    validate_auth as validate_mattermost_auth,
)
from config_loader import (
    load_auth_tokens as parse_auth_tokens_from_config,
    load_config as parse_bridge_config_from_file,
)
from request_contracts import (
    api_error_payload as build_api_error_payload,
    compact_adapter_metadata as compact_adapter_metadata_text,
    compact_adapter_metadata_object as compact_adapter_metadata_mapping,
    error_code_for as resolve_api_error_code,
    mattermost_response as build_mattermost_response,
    parse_adapter_metadata as parse_adapter_metadata_text,
    parse_body as parse_request_body,
    parse_run_receipt as parse_bridge_run_receipt,
    safe_adapter_source as validate_adapter_source,
    safe_idempotency_key as validate_idempotency_key,
)

JsonObject = dict[str, Any]
ConfigErrorFactory = Callable[[str, int], Exception]
ErrorFactory = Callable[[str, int, str | None], Exception]


@dataclass(frozen=True)
class ApiBridgeBindings:
    load_config: Callable[[Path], Any]
    load_auth_tokens: Callable[[JsonObject], dict[str, Any]]
    parse_body: Callable[[str, bytes], dict[str, str]]
    mattermost_response: Callable[..., dict[str, str]]
    error_code_for: Callable[[Exception], str]
    api_error_payload: Callable[[Exception], JsonObject]
    validate_auth: Callable[[dict[str, str], Any], None]
    authenticate_bearer: Callable[[str, Any], Any]
    reject_frontend_identity: Callable[[dict[str, str]], None]
    safe_adapter_source: Callable[[str], str]
    safe_idempotency_key: Callable[[str], str]
    parse_adapter_metadata: Callable[[str], JsonObject]
    compact_adapter_metadata: Callable[[str], str]
    compact_adapter_metadata_object: Callable[[JsonObject], str]
    parse_run_receipt: Callable[[str], JsonObject]


def build_api_bridge_bindings(
    *,
    default_codex_bridge_root: Path,
    project_name_re: Any,
    supported_modes: set[str] | frozenset[str],
    project_factory: Callable[..., Any],
    bridge_config_factory: Callable[..., Any],
    auth_principal_factory: Callable[..., Any],
    max_response_chars: int,
    config_error_factory: ConfigErrorFactory,
    error_factory: ErrorFactory,
) -> ApiBridgeBindings:
    def load_config(path: Path) -> Any:
        return parse_bridge_config_from_file(
            path,
            default_codex_bridge_root=default_codex_bridge_root,
            project_name_re=project_name_re,
            supported_modes=supported_modes,
            project_factory=project_factory,
            bridge_config_factory=bridge_config_factory,
            auth_principal_factory=auth_principal_factory,
            error_factory=config_error_factory,
        )

    def load_auth_tokens(data: JsonObject) -> dict[str, Any]:
        return parse_auth_tokens_from_config(
            data,
            auth_principal_factory=auth_principal_factory,
            error_factory=config_error_factory,
        )

    def parse_body(content_type: str, raw: bytes) -> dict[str, str]:
        return parse_request_body(
            content_type,
            raw,
            error_factory=error_factory,
        )

    def mattermost_response(text: str, response_type: str = "ephemeral") -> dict[str, str]:
        return build_mattermost_response(
            text,
            max_response_chars=max_response_chars,
            response_type=response_type,
        )

    def error_code_for(exc: Exception) -> str:
        return resolve_api_error_code(exc)

    def api_error_payload(exc: Exception) -> JsonObject:
        return build_api_error_payload(exc)

    def validate_auth(payload: dict[str, str], config: Any) -> None:
        validate_mattermost_auth(
            payload,
            mattermost_tokens=getattr(config, "mattermost_tokens"),
            allowed_users=getattr(config, "allowed_users"),
            error_factory=error_factory,
        )

    def authenticate_bearer(authorization: str, config: Any) -> Any:
        return authenticate_bearer_principal(
            authorization,
            auth_tokens=getattr(config, "auth_tokens"),
            allowed_users=getattr(config, "allowed_users"),
            error_factory=error_factory,
        )

    def reject_frontend_identity(payload: dict[str, str]) -> None:
        reject_frontend_payload_identity(
            payload,
            error_factory=error_factory,
        )

    def safe_adapter_source(value: str) -> str:
        return validate_adapter_source(
            value,
            error_factory=error_factory,
        )

    def safe_idempotency_key(value: str) -> str:
        return validate_idempotency_key(
            value,
            error_factory=error_factory,
        )

    def parse_adapter_metadata(value: str) -> JsonObject:
        return parse_adapter_metadata_text(
            value,
            error_factory=error_factory,
        )

    def compact_adapter_metadata(value: str) -> str:
        return compact_adapter_metadata_text(
            value,
            error_factory=error_factory,
        )

    def compact_adapter_metadata_object(data: JsonObject) -> str:
        return compact_adapter_metadata_mapping(
            data,
            error_factory=error_factory,
        )

    def parse_run_receipt(output: str) -> JsonObject:
        return parse_bridge_run_receipt(output)

    return ApiBridgeBindings(
        load_config=load_config,
        load_auth_tokens=load_auth_tokens,
        parse_body=parse_body,
        mattermost_response=mattermost_response,
        error_code_for=error_code_for,
        api_error_payload=api_error_payload,
        validate_auth=validate_auth,
        authenticate_bearer=authenticate_bearer,
        reject_frontend_identity=reject_frontend_identity,
        safe_adapter_source=safe_adapter_source,
        safe_idempotency_key=safe_idempotency_key,
        parse_adapter_metadata=parse_adapter_metadata,
        compact_adapter_metadata=compact_adapter_metadata,
        compact_adapter_metadata_object=compact_adapter_metadata_object,
        parse_run_receipt=parse_run_receipt,
    )
