import os
import json
import copy
from contextlib import asynccontextmanager
from datetime import date
from uuid import UUID
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse
from starlette.responses import JSONResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from backend_logging import LogLevel, backend_logger
from storage import (StorageInitializationError, initialize_storage, log_storage_failure,
                     validate_existing_database)
from edit_state import InvalidEditState, validate_snapshot
from edit_state import _recipe
from export_engine_diagnostics import ExportEngineError, diagnostic_failure, generate_diagnostic, generate_roundtrip_diagnostic, decode_diagnostic
from export_runtime import ExportRuntime, ImmichExportSource
from immich_export import ImmichFamilyFilenameProvider, ImmichExportRegistrar
from genzoroom_tag_repair import GenzoRoomTagRepair
from export_runtime_store import runtime_log, RuntimeRejected, recoverable_export_run, request_export_stop, retry_export_assets, get_export_run
from stack_write import StackApplyRequest, StackApplyResponse, apply_stacks
from edit_store import (
    StoreConflict, StoreUnavailable, QueueRejected, get_edit_state, put_edit_state, get_edit_statuses,
    list_export_queue, enqueue_export_assets, dequeue_export_asset, initialize_database,
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse ephemeral/unwritable storage before recovery can create or claim any DB state.
    try:
        await run_in_threadpool(initialize_storage)
        await run_in_threadpool(validate_existing_database)
        await run_in_threadpool(initialize_database)
    except StorageInitializationError as error:
        log_storage_failure(error)
        raise RuntimeError(f"Persistence startup failed: {error}") from None
    url, key = os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY")
    runtime = ExportRuntime(source=ImmichExportSource(url, key), family=ImmichFamilyFilenameProvider(url, key),
                            registrar=ImmichExportRegistrar(url, key)) if (url or '').strip() and (key or '').strip() else ExportRuntime()
    app.state.export_runtime = runtime
    app.state.tag_repair = GenzoRoomTagRepair(url, key)
    try:
        await runtime.recover()
    except StoreUnavailable as error:
        # Persistence failure must not prevent unrelated read-only Immich routes from starting.
        runtime_log("recovery.readFailed", level="error", errorCode=error.code)
    try:
        yield
    finally:
        await app.state.tag_repair.close()
        await runtime.wait()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
MAX_EDIT_STATE_BYTES = 8 * 1024 * 1024


@app.exception_handler(RequestValidationError)
async def safe_diagnostic_validation(request: Request, error: RequestValidationError):
    if request.url.path.startswith("/export/"):
        return JSONResponse(status_code=422, content={"detail": {"code": "invalid_export_request"}},
                            headers={"Cache-Control": "private, no-store"})
    if request.url.path in ("/developer/export-engine", "/developer/export-engine/decode", "/developer/export-engine/roundtrip"):
        # Pydantic's default response reflects rejected inputs, including injected Recipe bodies.
        return JSONResponse(status_code=422, content={"detail": {"code": "invalid_diagnostic_request"}},
                            headers={"Cache-Control": "private, no-store"})
    return await request_validation_exception_handler(request, error)


class BackendLogLevelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    level: LogLevel


class ExportEngineDiagnosticRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetId: UUID
    expectedRevision: int = Field(ge=1, strict=True)


class DecodeDiagnosticRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetId: UUID


@app.post("/developer/export-engine/decode")
async def export_engine_decode_diagnostic(payload: DecodeDiagnosticRequest) -> Response:
    headers = {"Cache-Control": "private, no-store"}
    original = None
    source = bytearray()
    try:
        try:
            original = await get_asset_original(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), payload.assetId)
            async for chunk in original.chunks():
                source.extend(chunk)
        finally:
            if original is not None:
                await original.close()
    except Exception as error:
        source.clear()
        diagnostic_failure("original_fetch_failed", "original")
        raise HTTPException(status_code=502, detail={"code": "original_fetch_failed"}, headers=headers) from error
    try:
        pixels, metadata = await run_in_threadpool(decode_diagnostic, source)
    except ExportEngineError as error:
        raise HTTPException(status_code=422, detail={"code": error.code}, headers=headers) from error
    finally:
        source.clear()
    headers["X-GenzoRoom-Decode"] = json.dumps(metadata, separators=(",", ":"), allow_nan=False)
    return Response(content=pixels, media_type="application/octet-stream", headers=headers)


@app.post("/developer/export-engine")
async def export_engine_diagnostic(payload: ExportEngineDiagnosticRequest) -> Response:
    headers = {"Cache-Control": "private, no-store"}

    def fail(code: str, status: int = 422, phase: str = "recipe") -> HTTPException:
        diagnostic_failure(code, phase)
        return HTTPException(status_code=status, detail={"code": code}, headers=headers)

    try:
        saved = await run_in_threadpool(get_edit_state, payload.assetId)
    except StoreUnavailable as error:
        raise fail("saved_recipe_unavailable", 503) from error
    if saved["state"] is None:
        raise fail("saved_recipe_unavailable", 404)
    current = saved["state"]["currentRecipe"]
    if current.get("version") != 18:
        raise fail("unsupported_recipe_version")
    if saved["revision"] != payload.expectedRevision:
        # The browser preview and backend must use the same persisted revision.
        raise fail("saved_recipe_changed", 409)
    try:
        recipe = copy.deepcopy(_recipe(current, 18))
    except InvalidEditState as error:
        raise fail("saved_recipe_unavailable") from error
    saved = None  # History and source identity never enter the engine worker.
    original = None
    source = bytearray()
    try:
        try:
            original = await get_asset_original(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), payload.assetId)
            async for chunk in original.chunks():
                source.extend(chunk)
        finally:
            if original is not None:
                await original.close()
    except Exception as error:
        source.clear()
        raise fail("original_fetch_failed", 502, "original") from error
    try:
        jpeg, metadata = await run_in_threadpool(generate_diagnostic, source, recipe)
    except ExportEngineError as error:
        # The worker already logged the terminal boundary; expose only its safe code.
        raise HTTPException(status_code=422, detail={"code": error.code}, headers=headers) from error
    finally:
        source.clear()
    # JSON header values are solely finite numbers and fixed enums from the engine.
    headers["X-GenzoRoom-Export-Engine"] = json.dumps(metadata, separators=(",", ":"), allow_nan=False)
    return Response(content=jpeg, media_type="image/jpeg", headers=headers)


@app.post("/developer/export-engine/roundtrip")
async def export_engine_roundtrip_diagnostic(payload: ExportEngineDiagnosticRequest) -> Response:
    headers = {"Cache-Control": "private, no-store"}

    def fail(code: str, status: int = 422, phase: str = "recipe") -> HTTPException:
        diagnostic_failure(code, phase)
        return HTTPException(status_code=status, detail={"code": code}, headers=headers)

    try:
        saved = await run_in_threadpool(get_edit_state, payload.assetId)
    except StoreUnavailable as error:
        raise fail("saved_recipe_unavailable", 503) from error
    if saved["state"] is None:
        raise fail("saved_recipe_unavailable", 404)
    current = saved["state"]["currentRecipe"]
    if current.get("version") != 18:
        raise fail("unsupported_recipe_version")
    if saved["revision"] != payload.expectedRevision:
        raise fail("saved_recipe_changed", 409)
    try:
        recipe = copy.deepcopy(_recipe(current, 18))
    except InvalidEditState as error:
        raise fail("saved_recipe_unavailable") from error
    saved = None
    original = None
    source = bytearray()
    try:
        try:
            original = await get_asset_original(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), payload.assetId)
            async for chunk in original.chunks():
                source.extend(chunk)
        finally:
            if original is not None:
                await original.close()
    except Exception as error:
        source.clear()
        raise fail("original_fetch_failed", 502, "original") from error
    try:
        jpeg, metadata, rgb = await run_in_threadpool(generate_roundtrip_diagnostic, source, recipe)
    except ExportEngineError as error:
        raise HTTPException(status_code=422, detail={"code": error.code}, headers=headers) from error
    finally:
        source.clear()

    metadata.update(pixelFormat="rgb8", rgbBytes=len(rgb))
    headers["X-GenzoRoom-Encode-Roundtrip"] = json.dumps(metadata, separators=(",", ":"), allow_nan=False)

    async def parts():
        # Yield the original encoder output and its source separately to avoid one combined server-side copy.
        yield jpeg
        yield rgb

    return StreamingResponse(parts(), media_type="application/octet-stream", headers=headers)


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


class ExportRuntimeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runId: UUID | None
    status: Literal['active', 'completed', 'failed', 'stopped'] | None
    stopRequested: bool
    stopAllowed: bool
    currentAssetId: UUID | None


def _runtime_response(run):
    return {"runId": run.run_id if run else None, "status": run.status if run else None,
            "stopRequested": run.stop_requested if run else False,
            "stopAllowed": bool(run and run.status == "active" and not run.stop_requested),
            "currentAssetId": run.items[run.current_position].asset_id if run and run.current_position is not None else None}


@app.get("/export/runtime", response_model=ExportRuntimeResponse)
def export_runtime_status():
    try:
        return _runtime_response(recoverable_export_run())
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.post("/export/runtime/start", response_model=ExportRuntimeResponse)
async def start_export_run(payload: ExportQueueRequest, request: Request):
    try:
        runtime = getattr(request.app.state, "export_runtime", None)
        if runtime is None:
            raise RuntimeRejected("runtime_not_configured")
        run_id = await runtime.start(payload.assetIds)
        return _runtime_response(await run_in_threadpool(get_export_run, run_id))
    except RuntimeRejected as error:
        status = 503 if error.code == 'runtime_not_configured' else 422 if error.code in (
            'invalid_asset_ids', 'duplicate_asset_ids', 'asset_not_eligible', 'saved_recipe_missing', 'unsupported_recipe_version') else 409
        raise _edit_error(status, error.code) from error
    except StoreUnavailable as error:
        raise _store_error(error) from error


@app.post("/export/runs/{run_id}/stop", response_model=ExportRuntimeResponse)
def stop_export_run(run_id: UUID):
    try:
        return _runtime_response(request_export_stop(run_id))
    except RuntimeRejected as error:
        raise _edit_error(409, error.code) from error
    except StoreUnavailable as error:
        raise _store_error(error) from error


class ExportQueueItemResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetId: UUID
    status: Literal['queued', 'waiting', 'encoding', 'registering', 'failed']
    queuedAt: str
    updatedAt: str


class ExportQueueResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ExportQueueItemResponse]


@app.post("/export/queue/retry", response_model=ExportQueueResponse)
def retry_export_queue(payload: ExportQueueRequest):
    try:
        return {"items": retry_export_assets(payload.assetIds)}
    except RuntimeRejected as error:
        status = 409 if error.code == "queue_item_not_failed" else 422
        raise _edit_error(status, error.code) from error
    except StoreUnavailable as error:
        raise _store_error(error) from error


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


def _home_with_tag_repair(assets, background_tasks):
    repair = getattr(app.state, "tag_repair", None)
    if repair is not None:
        # Submission runs after response delivery; the worker is owned and cancelled by app lifespan.
        background_tasks.add_task(repair.submit, assets)
    return assets


@app.get("/assets/recent", response_model=list[RecentAsset])
async def recent_assets(background_tasks: BackgroundTasks, limit: int = Query(default=100, ge=50, le=500, multiple_of=50)) -> list[RecentAsset]:
    try:
        assets = await get_recent_assets(
            os.getenv("IMMICH_URL"),
            os.getenv("IMMICH_API_KEY"),
            limit=limit,
        )
        return _home_with_tag_repair(assets, background_tasks)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/assets/favorites", response_model=list[RecentAsset])
async def favorite_assets(background_tasks: BackgroundTasks) -> list[RecentAsset]:
    try:
        assets = await get_favorite_assets(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"))
        return _home_with_tag_repair(assets, background_tasks)
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/albums", response_model=list[AlbumSummary])
async def albums() -> list[AlbumSummary]:
    try:
        return await get_albums(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"))
    except ImmichRequestError as error:
        raise _upstream_error(error) from error


@app.get("/albums/{album_id}/assets", response_model=list[RecentAsset])
async def album_assets(album_id: UUID, background_tasks: BackgroundTasks) -> list[RecentAsset]:
    try:
        assets = await get_album_assets(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), album_id)
        return _home_with_tag_repair(assets, background_tasks)
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
async def calendar_day_assets(selected_day: date, background_tasks: BackgroundTasks) -> list[RecentAsset]:
    if selected_day == date.max:
        raise HTTPException(status_code=422, detail="Date is outside the supported range")
    try:
        assets = await get_calendar_day_assets(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"), selected_day)
        return _home_with_tag_repair(assets, background_tasks)
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
