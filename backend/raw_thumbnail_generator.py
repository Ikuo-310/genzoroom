"""Regenerable RAW display cache bytes; no editing, persistence or Export writes."""

import asyncio
from io import BytesIO
from pathlib import Path
import tempfile

from PIL import Image
from starlette.concurrency import run_in_threadpool

from immich import get_asset_detail, get_asset_original
from jpeg_codec import encode_jpeg
from lightcraft_raw import LightCraftRawSession, PreviewFrame
from lightcraft_runtime import LightCraftManager
from raw_recipe_store import get_raw_saved_state
from rendered_image import RenderedImage
from thumbnail_generator import MAX_THUMBNAIL_EDGE, ThumbnailGenerationError, _log

MAX_SOURCE_BYTES = 512 * 1024 * 1024


def _load_recipe(asset_id):
    state = get_raw_saved_state(asset_id)
    if state is None:
        raise ThumbnailGenerationError("recipe_missing")
    if state["exportEligible"] is not True:
        raise ThumbnailGenerationError("recipe_unknown" if state["exportEligible"] is None else "recipe_default")
    return state["currentRecipe"]


def _encode(frame):
    if not isinstance(frame, PreviewFrame) or frame.mime_type != "image/png":
        raise ThumbnailGenerationError("raw_preview_invalid")
    with Image.open(BytesIO(frame.data)) as image:
        if image.format != "PNG" or image.size != (frame.width, frame.height) or \
                not 0 < max(image.size) <= MAX_THUMBNAIL_EDGE:
            raise ThumbnailGenerationError("raw_preview_invalid")
        with image.convert("RGB") as rgb:
            return encode_jpeg(RenderedImage(rgb.width, rgb.height, rgb.tobytes()))


async def render_raw_thumbnail(asset_id, source_path, recipe, *, manager=None):
    """Use only a cloned runtime; even an injected editing manager is never started or mutated."""
    template = manager or LightCraftManager()
    owned = template.diagnostic_manager(template._gpu_backend)
    session = LightCraftRawSession(owned, stage_cache="off")
    try:
        await owned.start()
        async with asyncio.timeout(20):
            while owned.status().state not in ("ready", "failed", "disabled"):
                await asyncio.sleep(.01)
        if owned.status().state != "ready":
            raise ThumbnailGenerationError("raw_engine_unavailable")
        # Disable sidecars before import; only the disposable source copy is exposed to Native.
        await owned._ready_client().call_tool("command_run", {
            "id": "library.xmpPreferences", "params": {"autoWrite": False}}, timeout=20)
        handle, snapshot = await session.open_raw(str(asset_id), str(source_path))
        restored = await session.restore_persisted_settings(handle, recipe, snapshot.revision)
        frame = await session.request_preview(handle, restored.revision, MAX_THUMBNAIL_EDGE, quality="full")
        return await run_in_threadpool(_encode, frame)
    finally:
        # The existing owner joins outstanding work and reaps Native even on cancellation.
        await session.close()


async def generate_raw_thumbnail(asset_id, *, immich_url, api_key, transport=None, manager=None):
    """Return JPEG bytes for the existing ThumbnailCache.store(asset_id, bytes) contract."""
    _log("raw.started", asset_id)
    try:
        recipe = await run_in_threadpool(_load_recipe, asset_id)
        detail = await get_asset_detail(immich_url, api_key, asset_id, transport=transport)
        if not detail.is_raw:
            raise ThumbnailGenerationError("raw_source_required")
        with tempfile.TemporaryDirectory(prefix="genzoroom-raw-thumbnail-") as directory:
            # Keep only the suffix for decoder hints; never use an upstream path or filename.
            source = Path(directory) / ("source" + Path(detail.filename).suffix)
            original = await get_asset_original(immich_url, api_key, asset_id, transport=transport, allow_raw=True)
            try:
                size = 0
                with source.open("wb") as output:
                    async for chunk in original.chunks():
                        size += len(chunk)
                        if size > MAX_SOURCE_BYTES:
                            raise ThumbnailGenerationError("raw_source_too_large")
                        output.write(chunk)
            finally:
                await original.close()
            result = await render_raw_thumbnail(asset_id, source, recipe, manager=manager)
    except Exception as error:
        code = error.code if isinstance(error, ThumbnailGenerationError) else "raw_thumbnail_failed"
        skipped = code in ("recipe_missing", "recipe_default", "recipe_unknown")
        _log("raw.skipped" if skipped else "raw.failed", asset_id,
             level="info" if skipped else "error", errorCode=code)
        if isinstance(error, ThumbnailGenerationError):
            raise
        raise ThumbnailGenerationError(code) from error
    _log("raw.completed", asset_id, payloadBytes=len(result))
    return result
