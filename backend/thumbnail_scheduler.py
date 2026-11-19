"""Process-local debounce and one serial worker; no Recipe snapshots or durable jobs."""

import asyncio
from collections import OrderedDict
from time import monotonic

from starlette.concurrency import run_in_threadpool

from thumbnail_cache import thumbnail_log
from thumbnail_generator import ThumbnailGenerationError

DEBOUNCE_SECONDS = 60
_USE_CACHE_VERSION = object()


class ThumbnailScheduler:
    def __init__(self, cache, generate, *, clock=monotonic, publication_hub=None):
        self.cache, self._generate, self._clock = cache, generate, clock
        self.publication_hub = publication_hub
        self._deadlines = {}
        self._pending = OrderedDict()
        self._wake = asyncio.Event()
        self._task = None
        self._closed = False
        self._active = None
        self._invalidated = False
        self._states = OrderedDict()
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
            state = "queued"
        else:
            self._pending.pop(asset_id, None)
            self._deadlines[asset_id] = self._clock() + DEBOUNCE_SECONDS
            event = "reserved"
            state = "reserved"
        self._states.pop(asset_id, None)
        thumbnail_log(event, component="thumbnail_scheduler", assetId=str(asset_id),
                      delaySeconds=0 if immediate else DEBOUNCE_SECONDS)
        self._publish(asset_id, state)
        self._wake.set()

    async def reset(self, asset_id):
        """Called under mutation_lock, including after a successful default Recipe save."""
        self._deadlines.pop(asset_id, None)
        self._pending.pop(asset_id, None)
        if self._active == asset_id:
            self._invalidated = True
        self._wake.set()
        try:
            await run_in_threadpool(self.cache.delete, asset_id)
        finally:
            # A committed Recipe reset must stop clients from requesting an old public URL,
            # even when the best-effort disk deletion fails.
            self._remember_terminal(asset_id, "reset")
            self._publish(asset_id, "reset", None)

    def _remember_terminal(self, asset_id, state):
        # Older terminal details can be reconstructed as published/missing from disk.
        self._states[asset_id] = state
        self._states.move_to_end(asset_id)
        if len(self._states) > 1024:
            self._states.popitem(last=False)

    def generation_state(self, asset_id):
        if asset_id == self._active:
            return "running"
        if asset_id in self._pending:
            return "queued"
        if asset_id in self._deadlines:
            return "reserved"
        return self._states.get(asset_id)

    def _publish(self, asset_id, state, publication_version=_USE_CACHE_VERSION):
        if self.publication_hub is not None:
            version = self.cache.version(asset_id) if publication_version is _USE_CACHE_VERSION else publication_version
            self.publication_hub.publish(asset_id, state, version)

    def _promote_due(self):
        now = self._clock()
        for asset_id, deadline in sorted(self._deadlines.items(), key=lambda item: item[1]):
            if deadline <= now:
                del self._deadlines[asset_id]
                self._pending.setdefault(asset_id, None)
                thumbnail_log("queued", component="thumbnail_scheduler", assetId=str(asset_id))
                self._publish(asset_id, "queued")

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
            self._publish(asset_id, "running")
            try:
                content = await self._generate(asset_id)
                async with self.mutation_lock:
                    if not self._invalidated:
                        evicted = await run_in_threadpool(self.cache.store, asset_id, content)
                        for evicted_id in evicted or ():
                            self._remember_terminal(evicted_id, "cache_missing")
                            self._publish(evicted_id, "cache_missing")
                        self._remember_terminal(asset_id, "published")
                        thumbnail_log("completed", component="thumbnail_scheduler", assetId=str(asset_id),
                                      payloadBytes=len(content), durationMs=round((self._clock() - started) * 1000))
                        self._publish(asset_id, "published")
                    else:
                        thumbnail_log("discarded", component="thumbnail_scheduler", assetId=str(asset_id),
                                      errorCode="generation_invalidated")
            except Exception as error:
                code = error.code if isinstance(error, ThumbnailGenerationError) else "thumbnail_generation_failed"
                if not self._invalidated:
                    self._remember_terminal(asset_id, "failed")
                    self._publish(asset_id, "failed")
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
