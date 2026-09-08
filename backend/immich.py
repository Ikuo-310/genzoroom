from collections.abc import Mapping
from typing import Literal

import httpx
from pydantic import BaseModel

IMMICH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
ErrorCode = Literal[
    "configuration_missing",
    "immich_url_missing",
    "immich_api_key_missing",
    "unreachable",
    "authentication_failed",
    "unexpected_response",
]


class ImmichStatus(BaseModel):
    configured: bool
    connected: bool
    error: str | None = None
    error_code: ErrorCode | None = None


def _status_error(error_code: ErrorCode, error: str, *, configured: bool) -> ImmichStatus:
    return ImmichStatus(
        configured=configured,
        connected=False,
        error_code=error_code,
        error=error,
    )


def _current_user_url(immich_url: str) -> str:
    base_url = immich_url.strip().rstrip("/")
    if base_url.endswith("/api"):
        return f"{base_url}/users/me"
    return f"{base_url}/api/users/me"


async def check_immich_status(
    immich_url: str | None,
    api_key: str | None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ImmichStatus:
    url = (immich_url or "").strip()
    key = (api_key or "").strip()

    if not url and not key:
        return _status_error(
            "configuration_missing",
            "IMMICH_URL and IMMICH_API_KEY are not configured.",
            configured=False,
        )
    if not url:
        return _status_error(
            "immich_url_missing",
            "IMMICH_URL is not configured.",
            configured=False,
        )
    if not key:
        return _status_error(
            "immich_api_key_missing",
            "IMMICH_API_KEY is not configured.",
            configured=False,
        )

    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client:
            response = await client.get(
                _current_user_url(url),
                headers={"x-api-key": key, "Accept": "application/json"},
            )
    except (httpx.InvalidURL, httpx.RequestError):
        return _status_error(
            "unreachable",
            "The Immich server could not be reached.",
            configured=True,
        )

    if response.status_code in (401, 403):
        return _status_error(
            "authentication_failed",
            "Immich rejected the API key or its permissions are insufficient.",
            configured=True,
        )
    if response.status_code != 200:
        return _status_error(
            "unexpected_response",
            "Immich returned an unexpected response.",
            configured=True,
        )

    try:
        body = response.json()
    except ValueError:
        body = None

    if not isinstance(body, Mapping) or not isinstance(body.get("id"), str):
        return _status_error(
            "unexpected_response",
            "Immich returned an unexpected response.",
            configured=True,
        )

    return ImmichStatus(configured=True, connected=True)
