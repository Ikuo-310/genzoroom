import os
from uuid import UUID

from fastapi import FastAPI, HTTPException, Response

from immich import (
    ImmichRequestError,
    ImmichStatus,
    RecentAsset,
    check_immich_status,
    get_asset_thumbnail,
    get_recent_assets,
)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


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
