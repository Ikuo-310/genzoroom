import asyncio
from uuid import UUID

import pytest

from thumbnail_cache import ThumbnailCache
from thumbnail_generator import ThumbnailGenerationError
from thumbnail_scheduler import DEBOUNCE_SECONDS, ThumbnailScheduler
from backend_logging import backend_logger

A, B, C = (UUID(int=i) for i in (1, 2, 3))


async def until(predicate):
    async def poll():
        while not predicate():
            await asyncio.sleep(0.001)
    await asyncio.wait_for(poll(), 3)


def test_debounce_multiple_assets_and_immediate_deduplication(tmp_path):
    async def run():
        now, calls = [0], []
        async def generate(asset_id):
            calls.append(asset_id)
            return b"jpeg"
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path), generate, clock=lambda: now[0])
        await scheduler.start()
        assert DEBOUNCE_SECONDS == 60
        scheduler.schedule(A)
        scheduler.schedule(B)
        now[0] = 30
        scheduler.schedule(A)
        assert scheduler._deadlines == {A: 90, B: 60}
        now[0] = 60
        scheduler._wake.set()
        await until(lambda: scheduler.cache.read(B) is not None)
        assert calls == [B]
        scheduler.schedule(A, immediate=True)
        scheduler.schedule(A, immediate=True)
        await until(lambda: scheduler.cache.read(A) is not None)
        assert calls == [B, A] and not scheduler._deadlines
        await scheduler.close()
    asyncio.run(run())


def test_timer_promotes_at_deadline_without_early_generation(tmp_path):
    async def run():
        now, calls = [0], []
        async def generate(asset_id):
            calls.append(asset_id)
            return b"jpeg"
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path), generate, clock=lambda: now[0])
        await scheduler.start()
        scheduler.schedule(A)
        now[0] = 59
        scheduler._promote_due()
        assert not scheduler._pending
        now[0] = 60
        scheduler._wake.set()
        await until(lambda: scheduler.cache.read(A) is not None)
        assert calls == [A]
        await scheduler.close()
    asyncio.run(run())


def test_serial_worker_and_request_during_generation(tmp_path):
    async def run():
        entered, release, calls, active = asyncio.Event(), asyncio.Event(), [], [0]
        async def generate(asset_id):
            active[0] += 1
            assert active[0] == 1
            calls.append(asset_id)
            if len(calls) == 1:
                entered.set()
                await release.wait()
            active[0] -= 1
            return b"jpeg"
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path), generate)
        await scheduler.start()
        scheduler.schedule(A, immediate=True)
        await entered.wait()
        scheduler.schedule(B, immediate=True)
        scheduler.schedule(A, immediate=True)
        scheduler.schedule(A, immediate=True)
        assert calls == [A]
        release.set()
        await until(lambda: len(calls) == 3 and scheduler._active is None)
        assert calls == [A, B, A]
        await scheduler.close()
    asyncio.run(run())


def test_reset_discards_inflight_output_even_after_new_edit(tmp_path):
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        async def generate(asset_id):
            entered.set()
            await release.wait()
            return b"stale"
        cache = ThumbnailCache(tmp_path)
        cache.store(A, b"old")
        scheduler = ThumbnailScheduler(cache, generate, clock=lambda: 0)
        await scheduler.start()
        scheduler.schedule(A, immediate=True)
        await entered.wait()
        async with scheduler.mutation_lock:
            await scheduler.reset(A)
            scheduler.schedule(A)
        release.set()
        await until(lambda: scheduler._active is None)
        assert cache.read(A) is None and scheduler._deadlines == {A: 60}
        await scheduler.close()
    asyncio.run(run())


def test_reset_cancels_timer_and_ready_queue(tmp_path):
    async def run():
        async def generate(asset_id):
            pytest.fail("reset work must not run")
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path), generate)
        scheduler.schedule(A)
        scheduler.schedule(B, immediate=True)
        async with scheduler.mutation_lock:
            await scheduler.reset(A)
            await scheduler.reset(B)
        await scheduler.start()
        assert not scheduler._pending and not scheduler._deadlines
        await scheduler.close()
    asyncio.run(run())


def test_failure_keeps_cache_and_worker_continues_without_retry(tmp_path):
    async def run():
        calls = []
        async def generate(asset_id):
            calls.append(asset_id)
            if asset_id in (A, C):
                raise ThumbnailGenerationError("preview_fetch_failed")
            return b"new"
        cache = ThumbnailCache(tmp_path)
        cache.store(A, b"old")
        scheduler = ThumbnailScheduler(cache, generate)
        await scheduler.start()
        for asset_id in (A, C, B):
            scheduler.schedule(asset_id, immediate=True)
        await until(lambda: cache.read(B) is not None)
        assert cache.read(A) == b"old" and cache.read(C) is None
        assert calls == [A, C, B] and not scheduler._pending
        await scheduler.close()
    asyncio.run(run())


def test_shutdown_finishes_active_and_drops_waiting_work(tmp_path):
    async def run():
        entered, release, calls = asyncio.Event(), asyncio.Event(), []
        async def generate(asset_id):
            calls.append(asset_id)
            entered.set()
            await release.wait()
            return b"jpeg"
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path), generate)
        await scheduler.start()
        scheduler.schedule(A, immediate=True)
        await entered.wait()
        scheduler.schedule(B, immediate=True)
        scheduler.schedule(C)
        closing = asyncio.create_task(scheduler.close())
        await asyncio.sleep(0)
        assert not closing.done()
        release.set()
        await closing
        assert calls == [A] and scheduler._task.done()
        assert scheduler.cache.read(A) == b"jpeg"
        assert not scheduler._pending and not scheduler._deadlines
        with pytest.raises(RuntimeError):
            scheduler.schedule(B)
    asyncio.run(run())


def test_logs_report_lifecycle_and_recoverable_failure_without_private_text(tmp_path):
    previous = backend_logger.get_level()
    backend_logger.set_level("debug")
    backend_logger.clear()
    async def run():
        async def generate(asset_id):
            if asset_id == A:
                raise RuntimeError("secret Recipe credentials and image bytes")
            return b"jpeg"
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path), generate, clock=lambda: 0)
        await scheduler.start()
        scheduler.schedule(B)
        scheduler.schedule(A, immediate=True)
        scheduler.schedule(B, immediate=True)
        await until(lambda: scheduler.cache.read(B) is not None)
        await scheduler.close()
    try:
        asyncio.run(run())
        entries = backend_logger.get_entries()
        levels = {entry["event"]: entry["level"] for entry in entries}
        assert levels["reserved"] == levels["queued"] == levels["started"] == "debug"
        assert levels["updated"] == "info" and levels["failed"] == "warn"
        assert "secret" not in str(entries) and str(tmp_path) not in str(entries)
    finally:
        backend_logger.set_level(previous)
        backend_logger.clear()
