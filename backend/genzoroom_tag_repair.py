"""Bounded, process-local maintenance for assets already returned by Home."""

import asyncio
from collections import OrderedDict, deque
from time import perf_counter

import httpx

from backend_logging import backend_logger
from export_artifact import is_genzoroom_export_filename
from immich import IMMICH_TIMEOUT, get_asset_original, _require_configuration
from immich_tags import assign_genzoroom_tag
from jpeg_metadata import has_genzoroom_export_marker


MAX_PENDING_REPAIRS = 128
MAX_NEGATIVE_CACHE = 512
MAX_ORIGINAL_BYTES = 64 * 1024 * 1024


def _log(event, *, level="debug", **context):
    try:
        backend_logger.add(level=level, component="genzoroom_tag_repair", event=event, context=context)
    except Exception:
        pass


class GenzoRoomTagRepair:
    def __init__(self, url, api_key, *, transport=None):
        self._url, self._key, self._transport = url, api_key, transport
        self._pending = deque()
        self._in_flight = set()
        self._negative = OrderedDict()
        self._task = None
        self._closed = False

    async def submit(self, assets):
        # Called after the Home response is sent. Only False proves absence; None is unknown.
        if self._closed:
            return
        try:
            for asset in assets:
                if asset.isGenzoRoomExport is not False or not is_genzoroom_export_filename(asset.filename):
                    continue
                if asset.id in self._in_flight or asset.id in self._negative:
                    continue
                if len(self._in_flight) >= MAX_PENDING_REPAIRS:
                    _log("tagRepair.capacityReached", pendingCount=len(self._in_flight))
                    break
                self._pending.append(asset.id)
                self._in_flight.add(asset.id)
            if self._pending and (self._task is None or self._task.done()):
                self._task = asyncio.create_task(self._drain())
        except Exception:
            _log("tagRepair.scheduleFailed", level="warn", errorCode="repair_schedule_failed")

    async def close(self):
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._pending.clear()
        self._in_flight.clear()
        self._negative.clear()

    async def _drain(self):
        # A single worker bounds downloads across all four Home views, not just within one request.
        while self._pending:
            asset_id = self._pending.popleft()
            started = perf_counter()
            phase = "original"
            try:
                matched = await self._marker(asset_id)
                if not matched:
                    self._negative[asset_id] = None
                    if len(self._negative) > MAX_NEGATIVE_CACHE:
                        self._negative.popitem(last=False)
                    continue
                phase = "tag"
                url, key = _require_configuration(self._url, self._key)
                async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, trust_env=False,
                        follow_redirects=False, transport=self._transport) as client:
                    tag = await assign_genzoroom_tag(client, url, {"x-api-key": key, "Accept": "application/json"}, asset_id)
                _log("tagRepair.completed", level="info", assetId=str(asset_id), tagId=str(tag),
                     result="restored", durationMs=round((perf_counter() - started) * 1000))
            except Exception:
                # Maintenance failures never escape into Home or retain private upstream exception text.
                _log("tagRepair.failed", level="warn", assetId=str(asset_id), phase=phase,
                     errorCode="repair_failed", durationMs=round((perf_counter() - started) * 1000))
            finally:
                self._in_flight.discard(asset_id)

    async def _marker(self, asset_id):
        original = None
        data = bytearray()
        try:
            original = await get_asset_original(self._url, self._key, asset_id, transport=self._transport)
            declared = original.response.headers.get("content-length")
            expected = int(declared) if declared is not None else None
            if expected is not None and not 0 < expected <= MAX_ORIGINAL_BYTES:
                raise ValueError("invalid_original_size")
            async for chunk in original.chunks():
                if len(data) + len(chunk) > MAX_ORIGINAL_BYTES:
                    raise ValueError("original_size_limit")
                data.extend(chunk)
            if expected is not None and len(data) != expected:
                raise ValueError("incomplete_original")
            return has_genzoroom_export_marker(bytes(data))
        finally:
            # Release buffers and upstream streams on success, failure, size rejection, and cancellation.
            data.clear()
            if original is not None:
                await original.close()
