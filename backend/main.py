import os
import json
from datetime import date
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from backend_logging import LogLevel, backend_logger
from edit_state import InvalidEditState, validate_snapshot
from stack_write import StackApplyRequest, StackApplyResponse, apply_stacks
from edit_store import (
    StoreConflict, StoreUnavailable, QueueRejected, get_edit_state, put_edit_state, get_edit_statuses,
    list_export_queue, enqueue_export_assets, dequeue_export_asset,
)

from immich import (
    ImmichAbout,
    get_immich_about,
    AssetDetail,
    ImmichRequestError,
    ImmichStatus,
    AlbumSummary,
    CalendarHeatmap,
    CalendarMinimumYear,
    RecentAsset,
    ImmichStack,
    resolve_stacks,
    get_albums,
    get_album_assets,
    get_favorite_assets,
    get_calendar_day_assets,
    get_calendar_min_year,
    get_calendar_heatmap,
    check_immich_status,
    get_asset_detail,
    get_asset_preview,
    get_asset_original,
    get_asset_thumbnail,
    get_recent_assets,
)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
MAX_EDIT_STATE_BYTES = 8 * 1024 * 1024


class BackendLogLevelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    level: LogLevel


@app.get("/developer/logs/backend")
def developer_backend_logs() -> dict:
    return backend_logger.create_report()


@app.delete("/developer/logs/backend", status_code=204)
def clear_developer_backend_logs() -> Response:
    backend_logger.clear()
    return Response(status_code=204)


@app.get("/developer/logs/backend/level")
def developer_backend_log_level() -> dict[str, LogLevel]:
    return {"level": backend_logger.get_level()}


@app.put("/developer/logs/backend/level")
def set_developer_backend_log_level(payload: BackendLogLevelRequest) -> dict[str, LogLevel]:
    return {"level": backend_logger.set_level(payload.level)}


@app.get("/immich/about", response_model=ImmichAbout, response_model_exclude_none=True)
async def immich_about() -> ImmichAbout:
    return await get_immich_about(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"))


@app.get("/assets/{asset_id}/original")
async def asset_original(asset_id: UUID) -> StreamingResponse:
    try:
        original = await get_asset_original(
            os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), asset_id,
        )
    except ImmichRequestError as error:
        raise _upstream_error(error) from error
    # Headers are validated before committing the response. Later stream failures
    # terminate the transfer so the frontend cannot accept a truncated original.
    return StreamingResponse(
        original.chunks(), media_type="image/jpeg",
        headers={"Cache-Control": "private, no-store", "X-Accel-Buffering": "no"},
        background=BackgroundTask(original.close),
    )


def _edit_error(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _store_error(error: StoreUnavailable) -> HTTPException:
    return _edit_error(503, error.code)


class EditStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetIds: list[UUID] = Field(max_length=100)


class ExportQueueRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetIds: list[UUID] = Field(min_length=1, max_length=100)


@app.get("/export/queue")
def export_queue() -> dict:
    try:
        return {"items": list_export_queue()}
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.post("/export/queue")
def enqueue_export_queue(payload: ExportQueueRequest) -> dict:
    try:
        return {"items": enqueue_export_assets(payload.assetIds)}
    except QueueRejected as error:
        raise _edit_error(422, error.code) from error
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.delete("/export/queue/{asset_id}", status_code=204)
def dequeue_export_queue(asset_id: UUID) -> Response:
    try:
        dequeue_export_asset(asset_id)
        return Response(status_code=204)
    except QueueRejected as error:
        raise _edit_error(409, error.code) from error
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.post("/assets/edit-status")
def asset_edit_statuses(payload: EditStatusRequest) -> dict:
    if len(set(payload.assetIds)) != len(payload.assetIds):
        raise _edit_error(422, "duplicate_asset_ids")
    try:
        return {"edited": get_edit_statuses(payload.assetIds)}
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.get("/assets/{asset_id}/edit-state")
def asset_edit_state(asset_id: UUID) -> dict:
    try:
        return get_edit_state(asset_id)
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.put("/assets/{asset_id}/edit-state")
async def save_asset_edit_state(asset_id: UUID, request: Request) -> dict:
    length = request.headers.get("content-length")
    if length is not None and length.isdecimal() and int(length) > MAX_EDIT_STATE_BYTES:
        raise _edit_error(413, "payload_too_large")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_EDIT_STATE_BYTES:
            raise _edit_error(413, "payload_too_large")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise _edit_error(422, "invalid_payload") from None
    if not isinstance(payload, dict) or payload.keys() != {
        "expectedRevision", "saveId", "stateFormatVersion", "recipeVersion",
        "processingVersion", "currentRecipe", "history", "historyCursor", "sourceIdentity",
    }:
        raise _edit_error(422, "invalid_payload")
    revision = payload.pop("expectedRevision")
    save_id_value = payload.pop("saveId")
    if type(revision) is not int or revision < 0 or type(save_id_value) is not str:
        raise _edit_error(422, "invalid_payload")
    try:
        save_id = UUID(save_id_value)
    except ValueError:
        raise _edit_error(422, "invalid_payload") from None
    try:
        validate_snapshot(payload, asset_id)
    except InvalidEditState as error:
        raise _edit_error(422, error.code) from error
    try:
        return await run_in_threadpool(put_edit_state, asset_id, revision, save_id, payload)
    except StoreConflict as error:
        raise _edit_error(409, error.code) from error
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get(
    "/immich/status",
    response_model=ImmichStatus,
    response_model_exclude_none=True,
)
async def immich_status() -> ImmichStatus:
    return await check_immich_status(
        os.getenv("IMMICH_URL"),
        os.getenv("IMMICH_API_KEY"),
    )


def _upstream_error(error: ImmichRequestError) -> HTTPException:
    status_code = 503 if error.error_code in ("configuration_missing", "unreachable") else 502
    return HTTPException(status_code=status_code, detail=str(error))


class StackResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stackIds: list[UUID] = Field(max_length=100)


class StackRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetIds: list[UUID] = Field(max_length=1000)


@app.post("/stacks/refresh", response_model=list[ImmichStack])
async def refresh_selected_stacks(payload: StackRefreshRequest) -> list[ImmichStack]:
    try:
        return await resolve_stacks(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), [], asset_ids=payload.assetIds)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.post("/stacks/apply", response_model=StackApplyResponse, response_model_exclude_none=True)
async def write_stacks(payload: StackApplyRequest) -> StackApplyResponse:
    return await apply_stacks(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), payload)


@app.post("/stacks/resolve", response_model=list[ImmichStack])
async def selected_stacks(payload: StackResolveRequest) -> list[ImmichStack]:
    try:
        return await resolve_stacks(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), payload.stackIds)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/assets/recent", response_model=list[RecentAsset])
async def recent_assets(limit: int = Query(default=100, ge=50, le=500, multiple_of=50)) -> list[RecentAsset]:
    try:
        return await get_recent_assets(
            os.getenv("IMMICH_URL"),
            os.getenv("IMMICH_API_KEY"),
            limit=limit,
        )
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/assets/favorites", response_model=list[RecentAsset])
async def favorite_assets() -> list[RecentAsset]:
    try:
        return await get_favorite_assets(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"))
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/albums", response_model=list[AlbumSummary])
async def albums() -> list[AlbumSummary]:
    try:
        return await get_albums(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"))
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/albums/{album_id}/assets", response_model=list[RecentAsset])
async def album_assets(album_id: UUID) -> list[RecentAsset]:
    try:
        return await get_album_assets(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), album_id)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/calendar/heatmap", response_model=CalendarHeatmap)
async def calendar_heatmap(
    year: int = Query(ge=1, le=9999), month: int | None = Query(default=None, ge=1, le=12),
) -> CalendarHeatmap:
    try:
        return await get_calendar_heatmap(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), year, month)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/calendar/min-year", response_model=CalendarMinimumYear)
async def calendar_min_year() -> CalendarMinimumYear:
    try:
        return CalendarMinimumYear(minYear=await get_calendar_min_year(
            os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"),
        ))
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/calendar/{selected_day}/assets", response_model=list[RecentAsset])
async def calendar_day_assets(selected_day: date) -> list[RecentAsset]:
    if selected_day == date.max:
        raise HTTPException(status_code=422, detail="Date is outside the supported range")
    try:
        return await get_calendar_day_assets(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), selected_day)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/assets/{asset_id}/thumbnail")
async def asset_thumbnail(asset_id: UUID) -> Response:
    try:
        thumbnail = await get_asset_thumbnail(
            os.getenv("IMMICH_URL"),
            os.getenv("IMMICH_API_KEY"),
            asset_id,
        )
    except ImmichRequestError as error:
        raise _upstream_error(error) from error

    return Response(
        content=thumbnail.content,
        media_type=thumbnail.media_type,
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get(
    "/assets/{asset_id}",
    response_model=AssetDetail,
    response_model_exclude_none=True,
)
async def asset_detail(asset_id: UUID) -> AssetDetail:
    try:
        return await get_asset_detail(
            os.getenv("IMMICH_URL"),
            os.getenv("IMMICH_API_KEY"),
            asset_id,
        )
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/assets/{asset_id}/preview")
async def asset_preview(asset_id: UUID) -> Response:
    try:
        preview = await get_asset_preview(
            os.getenv("IMMICH_URL"),
            os.getenv("IMMICH_API_KEY"),
            asset_id,
        )
    except ImmichRequestError as error:
        raise _upstream_error(error) from error

    return Response(
        content=preview.content,
        media_type=preview.media_type,
        headers={"Cache-Control": "private, max-age=300"},
    )
