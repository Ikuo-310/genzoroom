from collections.abc import AsyncIterator, Mapping
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from math import isfinite
import logging
from pathlib import PurePath
from typing import Literal
from uuid import UUID, uuid4
from time import monotonic

import anyio
import httpx
from pydantic import BaseModel, Field

from backend_logging import backend_logger

IMMICH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
DEFAULT_RECENT_ASSET_LIMIT = 100
MIN_RECENT_ASSET_LIMIT = 50
MAX_RECENT_ASSET_LIMIT = 500
RECENT_ASSET_LIMIT_STEP = 50
ALBUM_ASSET_PAGE_SIZE = 1000
CALENDAR_FORMAT_BATCH_SIZE = 100
HOME_EXPORT_TAG_BATCH_SIZE = 500
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
    response = None
    try:
        url, key = _require_configuration(immich_url, api_key)
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await _immich_request(
                client, "GET", url, "/server/about",
                headers={"x-api-key": key, "Accept": "application/json"},
            )
        if response.status_code != 200:
            raise _request_error(response)
        body = response.json()
        if not isinstance(body, Mapping) or not _optional_string(body.get("version")):
            _log_response_failure(response, "unexpected_response")
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
        if response is not None:
            _log_response_failure(response, "unexpected_response")
        return ImmichAbout(error_code="unexpected_response")


class RecentAsset(BaseModel):
    id: UUID
    filename: str
    date: str
    thumbnail_url: str
    format: str
    is_raw: bool
    isGenzoRoomExport: bool | None = Field(default=None, exclude_if=lambda value: value is None)
    stackId: UUID | None = None
    primaryAssetId: UUID | None = None
    stackAssetCount: int | None = None
    # Only Home Stack covers expose membership; unrelated asset APIs retain their response shape.
    stackMemberIds: list[UUID] | None = Field(default=None, exclude_if=lambda value: value is None)
    # Home can render the complete format set without resolving each Stack card separately.
    stackFormats: list[dict[str, str | bool]] | None = Field(default=None, exclude_if=lambda value: value is None)
    # Candidate metadata is atomic and shares the display membership snapshot; children never inherit cover tags.
    stackMembers: list["RecentAsset"] | None = Field(default=None, exclude_if=lambda value: value is None)


class ImmichStack(BaseModel):
    id: UUID
    primaryAssetId: UUID
    assets: list[RecentAsset]


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
    latitude: float | None = None
    longitude: float | None = None


class AssetDetail(BaseModel):
    id: UUID
    filename: str
    date: str
    preview_url: str
    thumbnail_url: str
    format: str
    is_raw: bool
    is_favorite: bool = Field(exclude=True)
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


def _optional_coordinate(value: object, limit: float) -> float | None:
    # Invalid optional GPS must not prevent opening an otherwise valid photo.
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not -limit <= value <= limit:
        return None
    return float(value) if isfinite(value) else None


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


def _log_response_failure(response: httpx.Response, error_code: str) -> None:
    trace = response.extensions.get("genzoroom_diagnostics")
    if trace is None or trace.get("failed"):
        return
    trace["failed"] = True
    _immich_log(level="warn", component="immich", event="request.failed", context={
        **trace["context"], "httpStatus": response.status_code,
        "durationMs": max(0, round((monotonic() - trace["started"]) * 1000, 3)), "errorCode": error_code,
    })


def _immich_log(**fields):
    try:
        backend_logger.add(**fields)
    except Exception:
        # A diagnostic sink must not interrupt a remote write or obscure its acknowledgement.
        pass


async def _immich_request(client, method: str, url: str, endpoint: str, *,
                          expected_status=200, stream=False, request_id=None, batch_id=None, operation_id=None, **kwargs):
    # Endpoint comes from explicit logical paths, never request.url, headers, query or bodies.
    context = {"requestId": request_id or uuid4().hex, "method": method, "endpoint": endpoint}
    if batch_id is not None:
        context["batchId"] = batch_id
    if operation_id is not None:
        context["operationId"] = operation_id
    started = monotonic()
    _immich_log(level="debug", component="immich", event="request.start", context=context)
    try:
        if stream:
            response = await client.send(client.build_request(method, _api_url(url, endpoint), **kwargs), stream=True)
        else:
            response = await client.request(method, _api_url(url, endpoint), **kwargs)
    except (httpx.RequestError, httpx.InvalidURL):
        _immich_log(level="warn", component="immich", event="request.failed", context={
            **context, "durationMs": max(0, round((monotonic() - started) * 1000, 3)), "errorCode": "unreachable",
        })
        raise
    response.extensions["genzoroom_diagnostics"] = {"context": context, "started": started}
    # Streaming duration ends at response headers; consuming pixels would change stream semantics.
    success = response.status_code in expected_status if isinstance(expected_status, tuple) else response.status_code == expected_status
    _immich_log(level="debug", component="immich", event="request.response", context={
        **context, "httpStatus": response.status_code,
        "durationMs": max(0, round((monotonic() - started) * 1000, 3)), "success": success,
    })
    if not success:
        _log_response_failure(response, _request_error(response).error_code)
    return response


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
            response = await _immich_request(
                client, "GET", url, "/users/me",
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
        _log_response_failure(response, "unexpected_response")
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
            response = await _immich_request(
                client, "GET", url, "/albums",
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
        _log_response_failure(response, "unexpected_response")
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
            response = await _immich_request(
                client, "POST", url, "/search/metadata",
                headers={"x-api-key": key, "Accept": "application/json"},
                json={
                    "filter": {
                        "type": {"eq": "IMAGE"},
                        "visibility": {"eq": "timeline"},
                        "trashedAt": {"eq": None},
                    },
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
        body = response.json()
        assets = _search_assets(body, home_metadata=True)
        next_cursor = _recent_next_cursor(body)
    except (KeyError, TypeError, ValueError):
        _log_response_failure(response, "unexpected_response")
        raise ImmichRequestError(
            "unexpected_response",
            "Immich returned an unexpected response.",
        ) from None

    stacks = _parse_stack_snapshot(await _get_asset_stacks(url, key, transport=transport), require_primary=False)
    result = _attach_home_stack_metadata(assets, stacks)[:limit]
    if next_cursor is not None and len(result) < limit:
        seen_cursors = {next_cursor}
        try:
            async with httpx.AsyncClient(
                timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
            ) as client:
                while next_cursor is not None and len(result) < limit:
                    request_body: dict[str, object] = {
                        "filter": {
                            "type": {"eq": "IMAGE"},
                            "visibility": {"eq": "timeline"},
                            "trashedAt": {"eq": None},
                        },
                        "orderBy": {"field": "fileCreatedAt", "direction": "desc"},
                        "size": limit,
                        "cursor": next_cursor,
                    }
                    page_response = await _immich_request(
                        client, "POST", url, "/search/metadata",
                        headers={"x-api-key": key, "Accept": "application/json"}, json=request_body,
                    )
                    if page_response.status_code != 200:
                        raise _request_error(page_response)
                    try:
                        page_body = page_response.json()
                        page_assets = _search_assets(page_body, home_metadata=True)
                        next_cursor = _recent_next_cursor(page_body)
                        if next_cursor is not None and next_cursor in seen_cursors:
                            raise TypeError
                    except (KeyError, TypeError, ValueError):
                        _log_response_failure(page_response, "unexpected_response")
                        raise ImmichRequestError(
                            "unexpected_response", "Immich returned an unexpected response.",
                        ) from None
                    if next_cursor is not None:
                        seen_cursors.add(next_cursor)
                    result.extend(_attach_home_stack_metadata(page_assets, stacks)[:limit - len(result)])
        except (httpx.InvalidURL, httpx.RequestError) as error:
            raise ImmichRequestError(
                "unreachable", "The Immich server could not be reached.",
            ) from error
    return await _with_home_export_tags(url, key, result, transport=transport)


def _search_assets(body: object, *, home_metadata: bool = False) -> list[RecentAsset]:
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
            isGenzoRoomExport=_home_export_tag(item.get("tags")) if home_metadata else None,
        ))
    return assets


def _recent_next_cursor(body: object) -> str | None:
    if not isinstance(body, Mapping) or not isinstance(body.get("assets"), Mapping):
        raise TypeError
    items = body["assets"].get("items")
    if not isinstance(items, list):
        raise TypeError
    cursor = body["assets"].get("nextCursor")
    if cursor is not None and (not isinstance(cursor, str) or not cursor or not items):
        raise TypeError
    return cursor


async def _get_asset_stacks(
    url: str, key: str,
    *, transport: httpx.AsyncBaseTransport | None = None, batch_id: str | None = None,
) -> list[object]:
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await _immich_request(
                client, "GET", url, "/stacks", batch_id=batch_id,
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
    except (KeyError, TypeError, ValueError):
        _log_response_failure(response, "unexpected_response")
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None
    return body


@dataclass
class StackSnapshot:
    stacks: list[Mapping]
    invalid_stack_ids: set[UUID]
    quarantined_member_ids: set[UUID]


def _stack_uuid(value: object) -> UUID | None:
    try:
        return UUID(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _parse_stack_snapshot(body: list[object], *, require_primary: bool) -> StackSnapshot:
    entries = []
    stack_id_counts: dict[UUID, int] = {}
    member_owners: dict[UUID, set[int]] = {}
    for index, raw in enumerate(body):
        stack = raw if isinstance(raw, Mapping) else {}
        stack_id = _stack_uuid(stack.get("id"))
        primary_id = _stack_uuid(stack.get("primaryAssetId"))
        raw_members = stack.get("assets")
        members: set[UUID] = set()
        valid = stack_id is not None and primary_id is not None and isinstance(raw_members, list) and bool(raw_members)
        for member in raw_members if isinstance(raw_members, list) else []:
            member_id = _stack_uuid(member.get("id")) if isinstance(member, Mapping) else None
            if member_id is None or member_id in members:
                valid = False
            if member_id is not None:
                members.add(member_id)
        # Home must recognize surviving children even when a deleted primary is absent; edits cannot trust that snapshot.
        if require_primary and primary_id not in members:
            valid = False
        entries.append((stack, stack_id, primary_id, members, valid))
        if stack_id is not None:
            stack_id_counts[stack_id] = stack_id_counts.get(stack_id, 0) + 1
        for member_id in members | ({primary_id} if not valid and primary_id is not None else set()):
            member_owners.setdefault(member_id, set()).add(index)
    ambiguous_entries = {
        index for owners in member_owners.values() if len(owners) > 1 for index in owners
    }
    snapshot = StackSnapshot([], set(), set())
    for index, (stack, stack_id, primary_id, members, valid) in enumerate(entries):
        if valid and stack_id_counts[stack_id] == 1 and index not in ambiguous_entries:
            snapshot.stacks.append(stack)
        else:
            # Invalid entries still establish possible ownership; never reclassify their assets as unstacked.
            if stack_id is not None:
                snapshot.invalid_stack_ids.add(stack_id)
            snapshot.quarantined_member_ids.update(members)
            if primary_id is not None:
                snapshot.quarantined_member_ids.add(primary_id)
    return snapshot


async def _with_asset_stacks(
    url: str, key: str, assets: list[RecentAsset],
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    # Home remains available when Immich exposes an incomplete Stack snapshot; editing keeps strict validation.
    stacks = _parse_stack_snapshot(await _get_asset_stacks(url, key, transport=transport), require_primary=False)
    return await _with_home_export_tags(url, key, _attach_home_stack_metadata(assets, stacks), transport=transport)


def _home_export_tag(tags: object) -> bool | None:
    if not isinstance(tags, list) or any(not isinstance(tag, Mapping) or not isinstance(tag.get("value"), str) for tag in tags):
        return None
    return any(tag["value"] == "GenzoRoom" for tag in tags)


async def _with_home_export_tags(
    url: str, key: str, assets: list[RecentAsset], *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    all_assets = assets + [member for asset in assets for member in asset.stackMembers or []]
    pending = list({asset.id: asset for asset in all_assets if asset.isGenzoRoomExport is None}.values())
    try:
        if pending:
            async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport) as client:
                response = await _immich_request(client, "GET", url, "/tags", headers={"x-api-key": key, "Accept": "application/json"})
            if response.status_code != 200:
                raise _request_error(response)
            tags = response.json()
            if not isinstance(tags, list) or any(not isinstance(tag, Mapping) or not isinstance(tag.get("value"), str) for tag in tags):
                raise ValueError
            tag_ids = [UUID(tag["id"]) for tag in tags if tag["value"] == "GenzoRoom"]
            tagged_ids = set()
            # Search does not load tag relations in Immich v3.2.4; resolve membership in bounded batches, never per card.
            for start in range(0, len(pending), HOME_EXPORT_TAG_BATCH_SIZE) if tag_ids else []:
                batch = {asset.id for asset in pending[start:start + HOME_EXPORT_TAG_BATCH_SIZE]}
                matches = await _search_all_assets(url, key, {
                    "type": {"eq": "IMAGE"}, "trashedAt": {"eq": None},
                    "tagIds": {"any": [str(tag_id) for tag_id in tag_ids]},
                    "or": [{"id": {"eq": str(asset_id)}} for asset_id in sorted(batch)],
                }, "fileCreatedAt", transport=transport)
                matched_ids = {asset.id for asset in matches}
                if not matched_ids <= batch:
                    raise ValueError
                tagged_ids.update(matched_ids)
            pending_ids = {asset.id for asset in pending}
            for asset in all_assets:
                if asset.id in pending_ids and asset.isGenzoRoomExport is None:
                    asset.isGenzoRoomExport = asset.id in tagged_ids
    except (ImmichRequestError, httpx.InvalidURL, httpx.RequestError, KeyError, TypeError, ValueError) as error:
        # Export identity is optional; a failed tag lookup must preserve the authoritative Home photo list.
        _immich_log(level="warn", component="immich", event="home.exportTags.unavailable", context={
            "assetCount": len(pending), "errorCode": getattr(error, "error_code", "unexpected_response"),
        })
    tag_evidence: dict[UUID, set[bool]] = {}
    for asset in all_assets:
        if isinstance(asset.isGenzoRoomExport, bool):
            tag_evidence.setdefault(asset.id, set()).add(asset.isGenzoRoomExport)
    conflicting_ids = {asset_id for asset_id, states in tag_evidence.items() if len(states) > 1}
    for asset in assets:
        if asset.stackMembers is not None and any(
            member.isGenzoRoomExport is None or member.id in conflicting_ids for member in asset.stackMembers
        ):
            if any(member.id in conflicting_ids for member in asset.stackMembers):
                _immich_log(level="warn", component="immich", event="home.exportTags.conflict", context={
                    "stackId": str(asset.stackId) if asset.stackId is not None else "unknown",
                    "memberCount": len(asset.stackMembers), "conflictCount": sum(
                        member.id in conflicting_ids for member in asset.stackMembers
                    ),
                })
            asset.stackMembers = None
    return assets


def _attach_home_stack_metadata(assets: list[RecentAsset], snapshot: StackSnapshot) -> list[RecentAsset]:
    lookup = {}
    visible_ids = {asset.id for asset in assets}
    for stack in snapshot.stacks:
        member_ids = [UUID(member["id"]) for member in stack["assets"]]
        members_by_id = {UUID(member["id"]): member for member in stack["assets"]}
        primary_id = UUID(stack["primaryAssetId"])
        stack_members = None
        try:
            # The full library snapshot is already loaded; materialize details only for covers on this page.
            if primary_id in visible_ids and primary_id in members_by_id:
                if any(member.get("type") != "IMAGE" for member in stack["assets"]):
                    raise ValueError
                stack_members = _search_assets({"assets": {"items": stack["assets"]}}, home_metadata=True)
                for member in stack_members:
                    member.stackId = UUID(stack["id"])
                    member.primaryAssetId = primary_id
                    member.stackAssetCount = len(member_ids)
        except (KeyError, TypeError, ValueError):
            _immich_log(level="warn", component="immich", event="home.stackMembers.unavailable", context={
                "stackId": str(stack["id"]), "memberCount": len(member_ids), "errorCode": "unexpected_response",
            })
        stack_formats = None
        if primary_id in members_by_id:
            ordered_members = [primary_id] + [member_id for member_id in member_ids if member_id != primary_id]
            formats = []
            seen_formats = set()
            for member_id in ordered_members:
                filename = members_by_id[member_id].get("originalFileName")
                if not isinstance(filename, str):
                    formats = []
                    break
                image_format, is_raw = classify_image_format(filename)
                identity = (image_format, is_raw)
                if identity not in seen_formats:
                    seen_formats.add(identity)
                    formats.append({"format": image_format, "isRaw": is_raw})
            stack_formats = formats or None
        for member_id in member_ids:
            lookup[member_id] = (UUID(stack["id"]), UUID(stack["primaryAssetId"]), len(member_ids), member_ids, stack_formats, stack_members)
    # Search metadata omits stacks in v3.2.4; only a successful full list establishes membership.
    for asset in assets:
        stack_info = lookup.get(asset.id)
        if stack_info is None:
            asset.stackId = asset.primaryAssetId = asset.stackAssetCount = None
            asset.stackMemberIds = None
            asset.stackFormats = None
            asset.stackMembers = None
        else:
            asset.stackId, asset.primaryAssetId, asset.stackAssetCount, asset.stackMemberIds, asset.stackFormats, asset.stackMembers = stack_info
    # A missing primary can leave only Stack children in search results; those are never Home cards.
    return [asset for asset in assets if asset.id not in snapshot.quarantined_member_ids
            and (asset.stackId is None or asset.id == asset.primaryAssetId)]


async def resolve_stacks(
    immich_url: str | None, api_key: str | None, stack_ids: list[UUID],
    *, transport: httpx.AsyncBaseTransport | None = None, asset_ids: list[UUID] | None = None,
) -> list[ImmichStack]:
    if len(stack_ids) > 100:
        raise ValueError("At most 100 stacks may be resolved.")
    requested = list(dict.fromkeys(stack_ids))
    if not requested and not asset_ids:
        return []
    url, key = _require_configuration(immich_url, api_key)
    snapshot = _parse_stack_snapshot(await _get_asset_stacks(url, key, transport=transport), require_primary=True)
    stacks = snapshot.stacks
    if asset_ids is not None:
        selected = set(asset_ids)
        if selected & snapshot.quarantined_member_ids:
            raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.")
        requested = [UUID(stack['id']) for stack in stacks if any(UUID(member['id']) in selected for member in stack['assets'])]
    if set(requested) & snapshot.invalid_stack_ids or any(
        UUID(stack["id"]) in requested and any(_stack_uuid(member["id"]) in snapshot.quarantined_member_ids
                                              for member in stack["assets"])
        for stack in stacks
    ):
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.")
    lookup = {UUID(stack["id"]): stack for stack in stacks}
    try:
        result = []
        for stack_id in requested:
            stack = lookup[stack_id]
            # Singleton snapshots can be repaired; never hide video or malformed members in a partial Stack.
            if len(stack["assets"]) < 1 or any(member.get("type") != "IMAGE" for member in stack["assets"]):
                raise ValueError
            assets = _search_assets({"assets": {"items": stack["assets"]}})
            primary_id = UUID(stack["primaryAssetId"])
            for asset in assets:
                asset.stackId = stack_id
                asset.primaryAssetId = primary_id
                asset.stackAssetCount = len(assets)
            result.append(ImmichStack(id=stack_id, primaryAssetId=primary_id, assets=assets))
        return result
    except (KeyError, TypeError, ValueError):
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None


async def _search_home_assets(
    immich_url: str | None, api_key: str | None,
    search_filter: dict[str, object], order_field: str,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    url, key = _require_configuration(immich_url, api_key)
    home_filter = {**search_filter, "trashedAt": {"eq": None}}
    assets = await _search_all_assets(url, key, home_filter, order_field, transport=transport, home_metadata=True)
    # Join once after pagination, rather than fetching stacks for each page or asset.
    return await _with_asset_stacks(url, key, assets, transport=transport)


async def get_favorite_assets(
    immich_url: str | None,
    api_key: str | None,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    return await _search_home_assets(
        immich_url, api_key,
        {"type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"}, "isFavorite": {"eq": True}},
        "fileCreatedAt", transport=transport,
    )


async def get_album_assets(
    immich_url: str | None,
    api_key: str | None,
    album_id: UUID,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> list[RecentAsset]:
    return await _search_home_assets(
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
    url, key = _require_configuration(immich_url, api_key)
    images = await _calendar_month_images(url, key, selected_day.replace(day=1), transport=transport)
    # Share the heatmap's local-day boundary and preserve timeline order even across duplicate bucket IDs.
    asset_ids = list(dict.fromkeys(asset_id for day, asset_id in images.candidates
                                  if day == selected_day.isoformat()))
    if not asset_ids:
        return []
    assets_by_id: dict[UUID, RecentAsset] = {}
    for start in range(0, len(asset_ids), CALENDAR_FORMAT_BATCH_SIZE):
        batch = asset_ids[start:start + CALENDAR_FORMAT_BATCH_SIZE]
        assets = await _search_all_assets(url, key, {
            "type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"}, "trashedAt": {"eq": None},
            "or": [{"id": {"eq": str(asset_id)}} for asset_id in batch],
        }, "fileCreatedAt", transport=transport, home_metadata=True)
        assets_by_id.update((asset.id, asset) for asset in assets)
    # Metadata order is independent of timeline order; join stacks only after all batches succeed.
    ordered_assets = [assets_by_id[asset_id] for asset_id in asset_ids if asset_id in assets_by_id]
    return await _with_asset_stacks(url, key, ordered_assets, transport=transport)


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
            response = await _immich_request(
                client, "POST", url, "/search/metadata",
                headers={"x-api-key": key, "Accept": "application/json"},
                json={
                    "filter": {"type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"}},
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
        _log_response_failure(response, "unexpected_response")
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None


async def _search_all_assets(
    immich_url: str | None,
    api_key: str | None,
    search_filter: dict[str, object],
    order_field: str,
    *, transport: httpx.AsyncBaseTransport | None = None, home_metadata: bool = False,
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
                response = await _immich_request(
                    client, "POST", url, "/search/metadata",
                    headers={"x-api-key": key, "Accept": "application/json"},
                    json=request_body,
                )
                if response.status_code != 200:
                    raise _request_error(response)
                try:
                    body = response.json()
                    page = _search_assets(body, home_metadata=home_metadata)
                    next_cursor = body["assets"]["nextCursor"]
                    if next_cursor is not None and (
                        not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors
                    ):
                        raise TypeError
                    if next_cursor is not None and not body["assets"]["items"]:
                        raise TypeError
                except (KeyError, TypeError, ValueError):
                    _log_response_failure(response, "unexpected_response")
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
            response = await _immich_request(
                client, "GET", url, "/users/me/calendar-heatmap",
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
        _log_response_failure(response, "unexpected_response")
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None
    thumbnails: dict[str, str] = {}
    image_days: set[str] = set()
    # Heatmap counts include archives and videos. Only timeline IMAGE presence enables a day.
    # Read yearly buckets sequentially to keep upstream concurrency bounded to one request.
    for bucket_month in ([month] if month is not None else range(1, 13)):
        bucket_first = date(year, bucket_month, 1)
        images = await _calendar_month_images(url, key, bucket_first, transport=transport)
        image_days.update(day for day, _ in images.candidates)
        if month is not None:
            try:
                thumbnails = await _calendar_month_thumbnails(url, key, first, images, transport=transport)
            except ImmichRequestError:
                # Format lookup is optional; timeline presence remains valid without thumbnails.
                pass
    return CalendarHeatmap(
        year=year, month=month,
        days=[CalendarDay(date=(first + timedelta(days=offset)).isoformat(),
                          hasAssets=(first + timedelta(days=offset)).isoformat() in image_days,
                          count=day_counts.get((first + timedelta(days=offset)).isoformat(), 0),
                          thumbnail_url=thumbnails.get((first + timedelta(days=offset)).isoformat()))
              for offset in range(day_count)],
    )


@dataclass(frozen=True)
class _CalendarMonthImages:
    candidates: list[tuple[str, UUID]]
    bucket_assets: int
    image_assets: int


async def _calendar_month_images(
    url: str, key: str, first: date, *, transport: httpx.AsyncBaseTransport | None = None,
) -> _CalendarMonthImages:
    try:
        async with httpx.AsyncClient(
            timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            response = await _immich_request(
                client, "GET", url, "/timeline/bucket",
                headers={"x-api-key": key, "Accept": "application/json"},
                params={"timeBucket": f"{first.isoformat()}T00:00:00.000Z", "orderBy": "takenAt",
                        "order": "desc", "visibility": "timeline", "isTrashed": "false",
                        "withStacked": "true"},
            )
    except (httpx.InvalidURL, httpx.RequestError) as error:
        logger.warning("Calendar data lookup failed: stage=timeline error=unreachable")
        raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error
    if response.status_code != 200:
        logger.warning("Calendar data lookup failed: stage=timeline http_status=%s", response.status_code)
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
        _log_response_failure(response, "unexpected_response")
        logger.warning("Calendar data lookup failed: stage=timeline error=unexpected_response")
        raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.") from None
    return _CalendarMonthImages(candidates, len(body["id"]), image_assets)


async def _calendar_month_thumbnails(
    url: str, key: str, first: date, images: _CalendarMonthImages,
    *, transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, str]:
    candidates = images.candidates
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
        first.year, first.month, images.bucket_assets, images.image_assets, len(candidates),
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
            response = await _immich_request(
                client, "GET", url, f"/assets/{asset_id}",
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
        is_favorite = body["isFavorite"]
        if not isinstance(filename, str) or not isinstance(date, str) or type(is_favorite) is not bool:
            raise TypeError
        exif_value = body.get("exifInfo")
        exif = exif_value if isinstance(exif_value, Mapping) else {}
        image_format, is_raw = classify_image_format(filename)
    except (KeyError, TypeError, ValueError):
        _log_response_failure(response, "unexpected_response")
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
        is_favorite=is_favorite,
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
            latitude=_optional_coordinate(exif.get("latitude"), 90),
            longitude=_optional_coordinate(exif.get("longitude"), 180),
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
            response = await _immich_request(
                client, "GET", url, f"/assets/{asset_id}/thumbnail",
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
        except httpx.RequestError:
            _log_response_failure(self.response, "unreachable")
            raise
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
        response = await _immich_request(
            client, "GET", url, f"/assets/{asset_id}/original", stream=True,
            headers={"x-api-key": key, "Accept": "image/jpeg"},
        )
        if response.status_code != 200:
            raise _request_error(response)
        if response.headers.get("content-type", "").split(";")[0].strip().lower() != "image/jpeg":
            _log_response_failure(response, "unexpected_response")
            raise ImmichRequestError("unexpected_response", "Immich returned an unexpected response.")
        return ImmichOriginal(response=response, client=client)
    except BaseException as error:
        if response is not None:
            await response.aclose()
        await client.aclose()
        if isinstance(error, (httpx.InvalidURL, httpx.RequestError)):
            raise ImmichRequestError("unreachable", "The Immich server could not be reached.") from error
        raise
