from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import httpx
from pydantic import BaseModel

IMMICH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
RECENT_ASSET_LIMIT = 10
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


class RecentAsset(BaseModel):
    id: UUID
    filename: str
    date: str
    thumbnail_url: str


class ImmichRequestError(Exception):
    def __init__(self, error_code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


@dataclass(frozen=True)
class ImmichThumbnail:
    content: bytes
    media_type: str


def _status_error(error_code: ErrorCode, error: str, *, configured: bool) -> ImmichStatus:
    return ImmichStatus(
        configured=configured,
        connected=False,
        error_code=error_code,
        error=error,
    )


def _api_url(immich_url: str, path: str) -> str:
    base_url = immich_url.strip().rstrip("/")
    if base_url.endswith("/api"):
        return f"{base_url}{path}"
    return f"{base_url}/api{path}"


def _require_configuration(
    immich_url: str | None,
    api_key: str | None,
) -> tuple[str, str]:
    url = (immich_url or "").strip()
    key = (api_key or "").strip()
    if not url or not key:
        raise ImmichRequestError(
            "configuration_missing",
            "Immich connection settings are incomplete.",
        )
    return url, key


def _request_error(response: httpx.Response) -> ImmichRequestError:
    if response.status_code in (401, 403):
        return ImmichRequestError(
            "authentication_failed",
            "Immich rejected the API key or its permissions are insufficient.",
        )
    return ImmichRequestError(
        "unexpected_response",
        "Immich returned an unexpected response.",
    )


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
                _api_url(url, "/users/me"),
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


async def get_recent_assets(
    immich_url: str | None,
    api_key: str | None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    url, key = _require_configuration(immich_url, api_key)

    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client:
            response = await client.post(
                _api_url(url, "/search/metadata"),
                headers={"x-api-key": key, "Accept": "application/json"},
                json={
                    "filter": {"type": {"eq": "IMAGE"}},
                    "orderBy": {"field": "fileCreatedAt", "direction": "desc"},
                    "size": RECENT_ASSET_LIMIT,
                },
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        raise ImmichRequestError(
            "unreachable",
            "The Immich server could not be reached.",
        ) from error

    if response.status_code != 200:
        raise _request_error(response)

    try:
        body = response.json()
        items = body["assets"]["items"]
        if not isinstance(items, list):
            raise TypeError

        assets: list[RecentAsset] = []
        for item in items:
            if not isinstance(item, Mapping):
                raise TypeError
            if item.get("type") != "IMAGE":
                continue
            asset_id = UUID(str(item["id"]))
            filename = item["originalFileName"]
            date = item["fileCreatedAt"]
            if not isinstance(filename, str) or not isinstance(date, str):
                raise TypeError
            assets.append(
                RecentAsset(
                    id=asset_id,
                    filename=filename,
                    date=date,
                    thumbnail_url=f"/api/assets/{asset_id}/thumbnail",
                )
            )
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError(
            "unexpected_response",
            "Immich returned an unexpected response.",
        ) from None

    return assets[:RECENT_ASSET_LIMIT]


async def get_asset_thumbnail(
    immich_url: str | None,
    api_key: str | None,
    asset_id: UUID,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ImmichThumbnail:
    url, key = _require_configuration(immich_url, api_key)

    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client:
            response = await client.get(
                _api_url(url, f"/assets/{asset_id}/thumbnail"),
                headers={"x-api-key": key, "Accept": "image/*"},
                params={"size": "thumbnail"},
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        raise ImmichRequestError(
            "unreachable",
            "The Immich server could not be reached.",
        ) from error

    if response.status_code != 200:
        raise _request_error(response)

    media_type = response.headers.get("content-type", "application/octet-stream")
    return ImmichThumbnail(content=response.content, media_type=media_type)
