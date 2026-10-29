"""Independent preview rendering; scheduling and delivery belong to callers."""

from copy import deepcopy
from uuid import UUID

import httpx
from PIL import Image
from starlette.concurrency import run_in_threadpool

from backend_logging import backend_logger
from edit_state import BOUNDS, has_non_default_recipe, validate_snapshot
from edit_store import get_edit_state
from immich import get_asset_preview
from jpeg_codec import decode_jpeg, encode_jpeg
from jpeg_renderer import JpegRenderer
from rendered_image import RenderedImage

MAX_THUMBNAIL_EDGE = 1024


class ThumbnailGenerationError(Exception):
    """Stable stage code; the chained exception retains the underlying failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _log(event: str, asset_id: UUID, *, level: str = "info", **context) -> None:
    try:
        backend_logger.add(level=level, component="thumbnail_generator", event=event,
                           context={"assetId": str(asset_id), **context})
    except Exception:
        # Diagnostics must never alter generation or hide its original failure.
        pass


def _load_recipe(asset_id: UUID) -> dict:
    try:
        state = get_edit_state(asset_id)["state"]
        if state is None:
            raise ThumbnailGenerationError("recipe_missing")
        state = validate_snapshot(state, asset_id)
        if not has_non_default_recipe(state):
            raise ThumbnailGenerationError("recipe_default")
        recipe = deepcopy(state["currentRecipe"])
        if recipe["version"] == 17:
            # Renderer consumes v18; upgrade only this invocation's copy, never saved state.
            recipe["version"] = 18
            recipe["adjustmentEnabled"] = dict.fromkeys(BOUNDS, True)
        return recipe
    except ThumbnailGenerationError:
        raise
    except Exception as error:
        raise ThumbnailGenerationError("recipe_load_failed") from error


def _render_preview(content: bytes, recipe: dict) -> bytes:
    try:
        source = decode_jpeg(content)
    except Exception as error:
        raise ThumbnailGenerationError("jpeg_decode_failed") from error
    try:
        if max(source.width, source.height) > MAX_THUMBNAIL_EDGE:
            with Image.frombytes("RGB", (source.width, source.height), source.pixels) as image:
                # Resize normalized sRGB before Recipe math: this is an approximate preview.
                image.thumbnail((MAX_THUMBNAIL_EDGE, MAX_THUMBNAIL_EDGE), Image.Resampling.LANCZOS)
                source = RenderedImage(image.width, image.height, image.tobytes())
    except Exception as error:
        raise ThumbnailGenerationError("resize_failed") from error
    try:
        rendered = JpegRenderer().render(source, recipe)
    except Exception as error:
        raise ThumbnailGenerationError("recipe_processing_failed") from error
    try:
        return encode_jpeg(rendered)
    except Exception as error:
        raise ThumbnailGenerationError("jpeg_encode_failed") from error


async def generate_thumbnail(
    asset_id: UUID, *, immich_url: str | None, api_key: str | None,
    transport: httpx.AsyncBaseTransport | None = None,
    input_kind: str = "jpeg",
) -> bytes:
    """Read the latest saved current Recipe at invocation and return JPEG bytes."""
    # Phase 1 callers opt in explicitly; existing save/request eligibility remains JPEG-only.
    if input_kind == "raw":
        from raw_thumbnail_generator import generate_raw_thumbnail
        return await generate_raw_thumbnail(asset_id, immich_url=immich_url, api_key=api_key, transport=transport)
    if input_kind != "jpeg":
        raise ThumbnailGenerationError("unsupported_input_kind")
    _log("started", asset_id)
    try:
        recipe = await run_in_threadpool(_load_recipe, asset_id)
        try:
            preview = await get_asset_preview(immich_url, api_key, asset_id, transport=transport)
        except Exception as error:
            raise ThumbnailGenerationError("preview_fetch_failed") from error
        # Content-Type is an upstream contract, not an assumption based on the endpoint name.
        if preview.media_type.split(";", 1)[0].strip().lower() != "image/jpeg":
            raise ThumbnailGenerationError("unsupported_preview_format")
        result = await run_in_threadpool(_render_preview, preview.content, recipe)
    except ThumbnailGenerationError as error:
        skipped = error.code in ("recipe_missing", "recipe_default")
        _log("skipped" if skipped else "failed", asset_id,
             level="info" if skipped else "error", errorCode=error.code)
        raise
    _log("completed", asset_id, payloadBytes=len(result))
    return result
