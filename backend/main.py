import os
import json
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from edit_state import InvalidEditState, validate_snapshot
from edit_store import StoreConflict, StoreUnavailable, get_edit_state, put_edit_state

from immich import (
    AssetDetail,
    ImmichRequestError,
    ImmichStatus,
    RecentAsset,
    check_immich_status,
    get_asset_detail,
    get_asset_preview,
    get_asset_thumbnail,
    get_recent_assets,
)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
MAX_EDIT_STATE_BYTES = 8 * 1024 * 1024


def _edit_error(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _store_error(error: StoreUnavailable) -> HTTPException:
    return _edit_error(503, error.code)


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


@app.get("/assets/recent", response_model=list[RecentAsset])
async def recent_assets() -> list[RecentAsset]:
    try:
        return await get_recent_assets(
            os.getenv("IMMICH_URL"),
            os.getenv("IMMICH_API_KEY"),
        )
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
