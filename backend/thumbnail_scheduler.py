"""Process-local debounce and one serial worker; no Recipe snapshots or durable jobs."""

import asyncio
from collections import OrderedDict
from time import monotonic

from starlette.concurrency import run_in_threadpool

from thumbnail_cache import thumbnail_log
from thumbnail_generator import ThumbnailGenerationError

DEBOUNCE_SECONDS = 60


class ThumbnailScheduler:
    def __init__(self, cache, generate, *, clock=monotonic):
        self.cache, self._generate, self._clock = cache, generate, clock
        self._deadlines = {}
        self._pending = OrderedDict()
        self._wake = asyncio.Event()
        self._task = None
        self._closed = False
        self._active = None
        self._invalidated = False
        # Save+notification and publication share ordering; reset cannot be overtaken by old output.
        self.mutation_lock = asyncio.Lock()

    async def start(self):
        try:
            await run_in_threadpool(self.cache.initialize)
        except Exception:
            thumbnail_log("initialization.failed", level="warn", errorCode="cache_initialization_failed")
        self._task = asyncio.create_task(self._serve())

    def schedule(self, asset_id, *, immediate=False):
        if self._closed:
            raise RuntimeError("thumbnail_scheduler_closed")
        if self._active == asset_id:
            self._invalidated = True
        if immediate:
            self._deadlines.pop(asset_id, None)
            self._pending.setdefault(asset_id, None)
            event = "queued"
        else:
            self._pending.pop(asset_id, None)
            self._deadlines[asset_id] = self._clock() + DEBOUNCE_SECONDS
            event = "reserved"
        thumbnail_log(event, component="thumbnail_scheduler", assetId=str(asset_id),
                      delaySeconds=0 if immediate else DEBOUNCE_SECONDS)
        self._wake.set()

    async def reset(self, asset_id):
        """Called under mutation_lock, including after a successful default Recipe save."""
        self._deadlines.pop(asset_id, None)
        self._pending.pop(asset_id, None)
        if self._active == asset_id:
            self._invalidated = True
        self._wake.set()
        await run_in_threadpool(self.cache.delete, asset_id)

    def _promote_due(self):
        now = self._clock()
        for asset_id, deadline in sorted(self._deadlines.items(), key=lambda item: item[1]):
            if deadline <= now:
                del self._deadlines[asset_id]
                self._pending.setdefault(asset_id, None)
                thumbnail_log("queued", component="thumbnail_scheduler", assetId=str(asset_id))

    async def _serve(self):
        while not self._closed:
            self._promote_due()
            if not self._pending:
                self._wake.clear()
                timeout = max(0, min(self._deadlines.values()) - self._clock()) if self._deadlines else None
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout)
                except TimeoutError:
                    pass
                continue
            asset_id, _ = self._pending.popitem(last=False)
            self._active, self._invalidated = asset_id, False
            started = self._clock()
            thumbnail_log("started", component="thumbnail_scheduler", assetId=str(asset_id))
            try:
                content = await self._generate(asset_id)
                async with self.mutation_lock:
                    if not self._invalidated:
                        await run_in_threadpool(self.cache.store, asset_id, content)
                        thumbnail_log("completed", component="thumbnail_scheduler", assetId=str(asset_id),
                                      payloadBytes=len(content), durationMs=round((self._clock() - started) * 1000))
                    else:
                        thumbnail_log("discarded", component="thumbnail_scheduler", assetId=str(asset_id),
                                      errorCode="generation_invalidated")
            except Exception as error:
                code = error.code if isinstance(error, ThumbnailGenerationError) else "thumbnail_generation_failed"
                thumbnail_log("failed", level="warn", component="thumbnail_scheduler", assetId=str(asset_id),
                              errorCode=code, durationMs=round((self._clock() - started) * 1000))
            finally:
                self._active = None

    async def close(self):
        # Finish the one active operation, but never start pending work during shutdown.
        self._closed = True
        self._deadlines.clear()
        self._pending.clear()
        self._wake.set()
        if self._task is not None:
            await self._task
