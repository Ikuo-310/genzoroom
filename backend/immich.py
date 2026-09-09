from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePath
from typing import Literal
from uuid import UUID

import httpx
from pydantic import BaseModel

IMMICH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
RECENT_ASSET_LIMIT = 10
FORMAT_ALIASES = {
    "jpg": "JPEG",
    "jpeg": "JPEG",
    "heic": "HEIC",
    "heif": "HEIC",
}
RAW_FORMATS = frozenset(
    {
        "ARW",
        "CR2",
        "CR3",
        "CRW",
        "DNG",
        "ERF",
        "KDC",
        "MEF",
        "MOS",
        "MRW",
        "NEF",
        "NRW",
        "ORF",
        "PEF",
        "RAF",
        "RAW",
        "RW2",
        "SR2",
        "SRF",
        "SRW",
        "X3F",
    }
)
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
    format: str
    is_raw: bool


class AssetExif(BaseModel):
    date_time_original: str | None = None
    make: str | None = None
    model: str | None = None
    lens_model: str | None = None
    focal_length: float | None = None
    f_number: float | None = None
    exposure_time: str | None = None
    iso: int | None = None
    exposure_compensation: float | None = None
    width: int | None = None
    height: int | None = None


class AssetDetail(BaseModel):
    id: UUID
    filename: str
    date: str
    preview_url: str
    thumbnail_url: str
    format: str
    is_raw: bool
    exif: AssetExif


class ImmichRequestError(Exception):
    def __init__(self, error_code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


@dataclass(frozen=True)
class ImmichThumbnail:
    content: bytes
    media_type: str


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _optional_number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _optional_integer(value: object) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def classify_image_format(filename: str) -> tuple[str, bool]:
    extension = PurePath(filename).suffix.removeprefix(".").lower()
    # Keep arbitrary filenames from creating an unbounded or misleading badge value.
    if not extension or len(extension) > 10 or not extension.isalnum():
        return "UNKNOWN", False

    image_format = FORMAT_ALIASES.get(extension, extension.upper())
    return image_format, image_format in RAW_FORMATS


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
            image_format, is_raw = classify_image_format(filename)
            assets.append(
                RecentAsset(
                    id=asset_id,
                    filename=filename,
                    date=date,
                    thumbnail_url=f"/api/assets/{asset_id}/thumbnail",
                    format=image_format,
                    is_raw=is_raw,
                )
            )
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError(
            "unexpected_response",
            "Immich returned an unexpected response.",
        ) from None

    return assets[:RECENT_ASSET_LIMIT]


async def get_asset_detail(
    immich_url: str | None,
    api_key: str | None,
    asset_id: UUID,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AssetDetail:
    url, key = _require_configuration(immich_url, api_key)

    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client:
            response = await client.get(
                _api_url(url, f"/assets/{asset_id}"),
                headers={"x-api-key": key, "Accept": "application/json"},
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
        if not isinstance(body, Mapping) or body.get("type") != "IMAGE":
            raise TypeError
        filename = body["originalFileName"]
        date = body["fileCreatedAt"]
        if not isinstance(filename, str) or not isinstance(date, str):
            raise TypeError
        exif_value = body.get("exifInfo")
        exif = exif_value if isinstance(exif_value, Mapping) else {}
        image_format, is_raw = classify_image_format(filename)
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError(
            "unexpected_response",
            "Immich returned an unexpected response.",
        ) from None

    return AssetDetail(
        id=asset_id,
        filename=filename,
        date=date,
        preview_url=f"/api/assets/{asset_id}/preview",
        thumbnail_url=f"/api/assets/{asset_id}/thumbnail",
        format=image_format,
        is_raw=is_raw,
        exif=AssetExif(
            date_time_original=_optional_string(exif.get("dateTimeOriginal")),
            make=_optional_string(exif.get("make")),
            model=_optional_string(exif.get("model")),
            lens_model=_optional_string(exif.get("lensModel")),
            focal_length=_optional_number(exif.get("focalLength")),
            f_number=_optional_number(exif.get("fNumber")),
            exposure_time=_optional_string(exif.get("exposureTime")),
            iso=_optional_integer(exif.get("iso")),
            exposure_compensation=_optional_number(exif.get("exposureCompensation")),
            width=_optional_integer(exif.get("exifImageWidth")),
            height=_optional_integer(exif.get("exifImageHeight")),
        ),
    )


async def _get_asset_image(
    immich_url: str | None,
    api_key: str | None,
    asset_id: UUID,
    size: Literal["thumbnail", "preview"],
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
                params={"size": size},
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


async def get_asset_thumbnail(
    immich_url: str | None,
    api_key: str | None,
    asset_id: UUID,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ImmichThumbnail:
    return await _get_asset_image(
        immich_url,
        api_key,
        asset_id,
        "thumbnail",
        transport=transport,
    )


async def get_asset_preview(
    immich_url: str | None,
    api_key: str | None,
    asset_id: UUID,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ImmichThumbnail:
    # Immich's generated preview is suitable for viewing without always transferring originals.
    return await _get_asset_image(
        immich_url,
        api_key,
        asset_id,
        "preview",
        transport=transport,
    )
