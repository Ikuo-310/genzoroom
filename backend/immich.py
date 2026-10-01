from collections.abc import AsyncIterator, Mapping
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from math import isfinite
import logging
from pathlib import PurePath
from typing import Literal
from uuid import UUID

import anyio
import httpx
from pydantic import BaseModel

IMMICH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
DEFAULT_RECENT_ASSET_LIMIT = 100
MIN_RECENT_ASSET_LIMIT = 50
MAX_RECENT_ASSET_LIMIT = 500
RECENT_ASSET_LIMIT_STEP = 50
ALBUM_ASSET_PAGE_SIZE = 1000
CALENDAR_FORMAT_BATCH_SIZE = 100
logger = logging.getLogger(__name__)
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


class ImmichAbout(BaseModel):
    version: str | None = None
    build: str | None = None
    sourceRef: str | None = None
    error_code: ErrorCode | None = None


async def get_immich_about(
    immich_url: str | None, api_key: str | None,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> ImmichAbout:
    # Optional diagnostics must not affect connection checks or photo APIs.
    try:
        url, key = _require_configuration(immich_url, api_key)
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await client.get(
                _api_url(url, "/server/about"),
                headers={"x-api-key": key, "Accept": "application/json"},
            )
        if response.status_code != 200:
            raise _request_error(response)
        body = response.json()
        if not isinstance(body, Mapping) or not _optional_string(body.get("version")):
            return ImmichAbout(error_code="unexpected_response")
        # Allowlist public build labels; never proxy the raw upstream payload.
        return ImmichAbout(**{
            field: value[:200] for field in ("version", "build", "sourceRef")
            if (value := _optional_string(body.get(field))) is not None
        })
    except ImmichRequestError as error:
        return ImmichAbout(error_code=error.error_code)
    except (httpx.InvalidURL, httpx.RequestError):
        return ImmichAbout(error_code="unreachable")
    except ValueError:
        return ImmichAbout(error_code="unexpected_response")


class RecentAsset(BaseModel):
    id: UUID
    filename: str
    date: str
    thumbnail_url: str
    format: str
    is_raw: bool


class AlbumSummary(BaseModel):
    id: UUID
    albumName: str
    albumThumbnailAssetId: UUID | None
    assetCount: int
    startDate: str | None
    endDate: str | None


class CalendarDay(BaseModel):
    date: str
    hasAssets: bool
    count: int
    thumbnail_url: str | None = None


class CalendarHeatmap(BaseModel):
    year: int
    month: int | None
    days: list[CalendarDay]


class CalendarMinimumYear(BaseModel):
    minYear: int | None


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
    def __init__(self, error_code: ErrorCode, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.status_code = status_code


@dataclass(frozen=True)
class ImmichThumbnail:
    content: bytes
    media_type: str


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _optional_number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _optional_integer(value: object) -> int | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    # Optional malformed EXIF must not block the photo; keep arbitrary-size integers intact.
    if isinstance(value, float) and not isfinite(value):
        return None
    return int(value)


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
            status_code=response.status_code,
        )
    return ImmichRequestError(
        "unexpected_response",
        "Immich returned an unexpected response.",
        status_code=response.status_code,
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


def _album_date(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


async def get_albums(
    immich_url: str | None,
    api_key: str | None,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[AlbumSummary]:
    url, key = _require_configuration(immich_url, api_key)
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await client.get(
                _api_url(url, "/albums"),
                headers={"x-api-key": key, "Accept": "application/json"},
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error

    if response.status_code != 200:
        raise _request_error(response)

    try:
        body = response.json()
        if not isinstance(body, list):
            raise TypeError
        albums: list[AlbumSummary] = []
        for item in body:
            if not isinstance(item, Mapping):
                raise TypeError
            album_id = UUID(item["id"])
            name = item["albumName"]
            thumbnail_id = item["albumThumbnailAssetId"]
            count = item["assetCount"]
            if not isinstance(name, str) or (thumbnail_id is not None and not isinstance(thumbnail_id, str)) \
                    or type(count) is not int or count < 0:
                raise TypeError
            albums.append(AlbumSummary(
                id=album_id,
                albumName=name,
                albumThumbnailAssetId=UUID(thumbnail_id) if thumbnail_id is not None else None,
                assetCount=count,
                startDate=_album_date(item.get("startDate")),
                endDate=_album_date(item.get("endDate")),
            ))
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError(
            "unexpected_response", "Immich returned an unexpected response.",
        ) from None

    # Only fields used by Home leave the backend; Immich user and sharing metadata stay upstream.
    return albums


async def get_recent_assets(
    immich_url: str | None,
    api_key: str | None,
    *,
    limit: int = DEFAULT_RECENT_ASSET_LIMIT,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    if type(limit) is not int or not MIN_RECENT_ASSET_LIMIT <= limit <= MAX_RECENT_ASSET_LIMIT or limit % RECENT_ASSET_LIMIT_STEP:
        raise ValueError("Recent asset limit must be between 50 and 500 in steps of 50.")
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
                    "size": limit,
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
        assets = _search_assets(response.json())
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError(
            "unexpected_response",
            "Immich returned an unexpected response.",
        ) from None

    return assets[:limit]


def _search_assets(body: object) -> list[RecentAsset]:
    if not isinstance(body, Mapping) or not isinstance(body.get("assets"), Mapping):
        raise TypeError
    items = body["assets"].get("items")
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
        assets.append(RecentAsset(
            id=asset_id,
            filename=filename,
            date=date,
            thumbnail_url=f"/api/assets/{asset_id}/thumbnail",
            format=image_format,
            is_raw=is_raw,
        ))
    return assets


async def get_album_assets(
    immich_url: str | None,
    api_key: str | None,
    album_id: UUID,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    return await _search_all_assets(
        immich_url, api_key,
        {"type": {"eq": "IMAGE"}, "albumIds": {"any": [str(album_id)]}},
        "fileCreatedAt", transport=transport,
    )


async def get_calendar_day_assets(
    immich_url: str | None,
    api_key: str | None,
    selected_day: date,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    if selected_day == date.max:
        raise ValueError("The selected date is outside the supported range.")
    next_day = selected_day + timedelta(days=1)
    # Immich v3.2.4 applies takenAt to fileCreatedAt; use its half-open UTC range as requested.
    bounds = {"gte": f"{selected_day.isoformat()}T00:00:00.000Z", "lt": f"{next_day.isoformat()}T00:00:00.000Z"}
    return await _search_all_assets(
        immich_url, api_key, {"type": {"eq": "IMAGE"}, "takenAt": bounds},
        "localDateTime", transport=transport,
    )


async def get_calendar_min_year(
    immich_url: str | None,
    api_key: str | None,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> int | None:
    url, key = _require_configuration(immich_url, api_key)
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await client.post(
                _api_url(url, "/search/metadata"),
                headers={"x-api-key": key, "Accept": "application/json"},
                json={
                    "filter": {"type": {"eq": "IMAGE"}},
                    "orderBy": {"field": "localDateTime", "direction": "asc"},
                    "size": 1,
                },
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error
    if response.status_code != 200:
        raise _request_error(response)
    try:
        body = response.json()
        if not isinstance(body, Mapping) or not isinstance(body.get("assets"), Mapping):
            raise TypeError
        items = body["assets"].get("items")
        if not isinstance(items, list) or len(items) > 1:
            raise TypeError
        if not items:
            return None
        oldest = items[0]
        if not isinstance(oldest, Mapping) or oldest.get("type") != "IMAGE":
            raise TypeError
        local_date_time = oldest.get("localDateTime")
        if not isinstance(local_date_time, str) or not local_date_time:
            raise TypeError
        return datetime.fromisoformat(local_date_time.replace("Z", "+00:00")).year
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None


async def _search_all_assets(
    immich_url: str | None,
    api_key: str | None,
    search_filter: dict[str, object],
    order_field: str,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    url, key = _require_configuration(immich_url, api_key)
    assets: list[RecentAsset] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            while True:
                request_body: dict[str, object] = {
                    "filter": search_filter,
                    "orderBy": {"field": order_field, "direction": "desc"},
                    "size": ALBUM_ASSET_PAGE_SIZE,
                }
                if cursor is not None:
                    request_body["cursor"] = cursor
                response = await client.post(
                    _api_url(url, "/search/metadata"),
                    headers={"x-api-key": key, "Accept": "application/json"},
                    json=request_body,
                )
                if response.status_code != 200:
                    raise _request_error(response)
                try:
                    body = response.json()
                    page = _search_assets(body)
                    next_cursor = body["assets"]["nextCursor"]
                    if next_cursor is not None and (
                        not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors
                    ):
                        raise TypeError
                    if next_cursor is not None and not body["assets"]["items"]:
                        raise TypeError
                except (KeyError, TypeError, ValueError):
                    raise ImmichRequestError(
                        "unexpected_response", "Immich returned an unexpected response.",
                    ) from None
                assets.extend(page)
                if next_cursor is None:
                    return assets
                # A cursor cycle would otherwise keep the backend reading upstream indefinitely.
                seen_cursors.add(next_cursor)
                cursor = next_cursor
    except (httpx.InvalidURL, httpx.RequestError) as error:
        raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error


async def get_calendar_heatmap(
    immich_url: str | None,
    api_key: str | None,
    year: int,
    month: int | None = None,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> CalendarHeatmap:
    first = date(year, month or 1, 1)
    last = date(year, month, monthrange(year, month)[1]) if month is not None else date(year, 12, 31)
    # Immich's service adds a day before querying the repository; API to is inclusive.
    day_count = (last - first).days + 1
    url, key = _require_configuration(immich_url, api_key)
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await client.get(
                _api_url(url, "/users/me/calendar-heatmap"),
                headers={"x-api-key": key, "Accept": "application/json"},
                params={"from": first.isoformat(), "to": last.isoformat(), "type": "Taken"},
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error
    if response.status_code != 200:
        raise _request_error(response)
    try:
        body = response.json()
        if not isinstance(body, Mapping) or not isinstance(body.get("series"), list):
            raise TypeError
        day_counts: dict[str, int] = {}
        seen_days: set[str] = set()
        for item in body["series"]:
            if not isinstance(item, Mapping) or not isinstance(item.get("date"), str):
                raise TypeError
            day_value = item["date"]
            if date.fromisoformat(day_value).isoformat() != day_value or day_value in seen_days:
                raise ValueError
            count = item.get("count")
            if type(count) is not int or count < 0:
                raise TypeError
            if not first <= date.fromisoformat(day_value) <= last:
                raise ValueError
            seen_days.add(day_value)
            day_counts[day_value] = count
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None
    thumbnails: dict[str, str] = {}
    if month is not None:
        try:
            thumbnails = await _calendar_month_thumbnails(url, key, first, transport=transport)
        except ImmichRequestError:
            # Representative images are optional; their failure must not hide a valid heatmap.
            pass
    return CalendarHeatmap(
        year=year, month=month,
        days=[CalendarDay(date=(first + timedelta(days=offset)).isoformat(),
                          hasAssets=day_counts.get((first + timedelta(days=offset)).isoformat(), 0) > 0,
                          count=day_counts.get((first + timedelta(days=offset)).isoformat(), 0),
                          thumbnail_url=thumbnails.get((first + timedelta(days=offset)).isoformat()))
              for offset in range(day_count)],
    )


async def _calendar_month_thumbnails(
    url: str, key: str, first: date, *, transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, str]:
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await client.get(
                _api_url(url, "/timeline/bucket"),
                headers={"x-api-key": key, "Accept": "application/json"},
                params={"timeBucket": f"{first.isoformat()}T00:00:00.000Z", "orderBy": "takenAt",
                        "order": "desc", "visibility": "timeline", "isTrashed": "false",
                        "withStacked": "true"},
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        logger.warning("Calendar thumbnail lookup failed: stage=timeline error=unreachable")
        raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error
    if response.status_code != 200:
        logger.warning("Calendar thumbnail lookup failed: stage=timeline http_status=%s", response.status_code)
        raise _request_error(response)
    try:
        body = response.json()
        fields = ("id", "isImage", "fileCreatedAt", "localOffsetHours")
        if not isinstance(body, Mapping) or any(not isinstance(body.get(field), list) for field in fields):
            raise TypeError
        if any(len(body[field]) != len(body["id"]) for field in fields):
            raise ValueError
        candidates: list[tuple[str, UUID]] = []
        image_assets = sum(body["isImage"])
        for asset_id, is_image, timestamp, offset in zip(*(body[field] for field in fields)):
            if not isinstance(asset_id, str) or type(is_image) is not bool or not isinstance(timestamp, str):
                raise TypeError
            asset_id = UUID(asset_id)
            if type(offset) not in (int, float) or not isfinite(offset):
                raise TypeError
            utc = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            utc = utc.replace(tzinfo=timezone.utc) if utc.tzinfo is None else utc.astimezone(timezone.utc)
            # Match Immich Web getTimes(): UTC fileCreatedAt plus the (possibly fractional) local offset.
            local_day = (utc + timedelta(hours=offset)).date()
            if is_image and (local_day.year, local_day.month) == (first.year, first.month):
                candidates.append((local_day.isoformat(), asset_id))
    except (KeyError, TypeError, ValueError, OverflowError):
        logger.warning("Calendar thumbnail lookup failed: stage=timeline error=unexpected_response")
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None

    thumbnails: dict[str, str] = {}
    format_results = 0
    eligible_asset_ids: set[UUID] = set()
    for start in range(0, len(candidates), CALENDAR_FORMAT_BATCH_SIZE):
        batch = [(day, asset_id) for day, asset_id in candidates[start:start + CALENDAR_FORMAT_BATCH_SIZE]
                 if day not in thumbnails]
        if not batch:
            continue
        # The bucket has no filenames. Official structured OR/id.eq search resolves formats in batches,
        # while replaying bucket order below avoids metadata search order changing the representative.
        try:
            assets = await _search_all_assets(url, key, {
                "type": {"eq": "IMAGE"}, "or": [{"id": {"eq": str(asset_id)}} for _, asset_id in batch],
            }, "fileCreatedAt", transport=transport)
        except ImmichRequestError as error:
            # Log only controlled diagnostics: upstream bodies and credentials can contain secrets.
            logger.warning("Calendar thumbnail lookup failed: stage=format error=%s http_status=%s",
                           error.error_code, error.status_code)
            raise
        format_results += len(assets)
        eligible_ids = {asset.id for asset in assets if not asset.is_raw}
        eligible_asset_ids.update(eligible_ids)
        for day, asset_id in batch:
            if asset_id in eligible_ids:
                thumbnails.setdefault(day, f"/api/assets/{asset_id}/thumbnail")
    logger.debug(
        "Calendar thumbnail lookup: year=%s month=%s bucket_assets=%s image_assets=%s "
        "month_candidates=%s candidate_days=%s format_results=%s non_raw_assets=%s thumbnail_days=%s",
        first.year, first.month, len(body["id"]), image_assets, len(candidates),
        len({day for day, _ in candidates}), format_results, len(eligible_asset_ids), len(thumbnails),
    )
    return thumbnails


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


@dataclass
class ImmichOriginal:
    response: httpx.Response
    client: httpx.AsyncClient

    async def close(self) -> None:
        # ASGI disconnect cancellation must not interrupt upstream cleanup.
        with anyio.CancelScope(shield=True):
            try:
                await self.response.aclose()
            finally:
                await self.client.aclose()

    async def chunks(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self.response.aiter_bytes(64 * 1024):
                yield chunk
        finally:
            # This also runs on a downstream disconnect or a mid-stream timeout.
            await self.close()


async def get_asset_original(
    immich_url: str | None,
    api_key: str | None,
    asset_id: UUID,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ImmichOriginal:
    url, key = _require_configuration(immich_url, api_key)
    detail = await get_asset_detail(url, key, asset_id, transport=transport)
    if detail.format != "JPEG":
        raise ImmichRequestError("unexpected_response", "Only JPEG originals are supported.")
    client = httpx.AsyncClient(
        timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
    )
    response = None
    try:
        response = await client.send(client.build_request(
            "GET", _api_url(url, f"/assets/{asset_id}/original"),
            headers={"x-api-key": key, "Accept": "image/jpeg"},
        ), stream=True)
        if response.status_code != 200:
            raise _request_error(response)
        if response.headers.get("content-type", "").split(";")[0].strip().lower() != "image/jpeg":
            raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.")
        return ImmichOriginal(response=response, client=client)
    except BaseException as error:
        if response is not None:
            await response.aclose()
        await client.aclose()
        if isinstance(error, (httpx.InvalidURL, httpx.RequestError)):
            raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error
        raise
