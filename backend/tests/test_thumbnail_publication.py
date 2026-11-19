import asyncio
import os

from uuid import UUID

from thumbnail_cache import ThumbnailCache
from thumbnail_publication import ThumbnailPublicationHub
from thumbnail_scheduler import ThumbnailScheduler
import thumbnail_cache as cache_module


A, B, C = (UUID(int=value) for value in (1, 2, 3))


def test_hub_emits_ordered_state_and_coalesces_overflow_to_resync():
    hub = ThumbnailPublicationHub(queue_size=2)
    subscriber = hub.subscribe()
    hub.publish(A, "queued", None)
    hub.publish(A, "running", None)
    hub.publish(A, "published", "123")
    assert subscriber.qsize() == 1
    resync = subscriber.get_nowait()
    assert resync == {"generationId": hub.generation_id, "sequence": 3, "type": "resync"}
    hub.publish(A, "published", "123")
    event = subscriber.get_nowait()
    assert event == {"generationId": hub.generation_id, "sequence": 4, "assetId": str(A),
                     "state": "published", "publicationVersion": "123"}
    hub.unsubscribe(subscriber)


def test_scheduler_keeps_previous_publication_while_regenerating_then_publishes_new_version(tmp_path):
    async def run():
        cache = ThumbnailCache(tmp_path)
        cache.store(A, b"previous")
        previous_version = cache.version(A)
        entered, release = asyncio.Event(), asyncio.Event()

        async def generate(_asset_id):
            entered.set()
            await release.wait()
            return b"replacement"

        hub = ThumbnailPublicationHub()
        subscriber = hub.subscribe()
        scheduler = ThumbnailScheduler(cache, generate, publication_hub=hub)
        await scheduler.start()
        scheduler.schedule(A, immediate=True)
        await asyncio.wait_for(entered.wait(), 2)
        assert cache.read_versioned(A) == (b"previous", previous_version)
        assert scheduler.generation_state(A) == "running"
        assert subscriber.get_nowait()["state"] == "queued"
        assert subscriber.get_nowait()["state"] == "running"

        release.set()
        async def completed():
            while scheduler.generation_state(A) != "published":
                await asyncio.sleep(0.001)
        await asyncio.wait_for(completed(), 2)
        current = cache.read_versioned(A)
        assert current is not None and current[0] == b"replacement"
        assert current[1] != previous_version
        event = subscriber.get_nowait()
        assert event["state"] == "published" and event["publicationVersion"] == current[1]
        await scheduler.close()
        hub.unsubscribe(subscriber)
    asyncio.run(run())


def test_failure_preserves_old_publication_and_capacity_eviction_publishes_missing(tmp_path, monkeypatch):
    async def run():
        cache = ThumbnailCache(tmp_path)
        cache.store(A, b"oldA")
        cache.store(B, b"oldB")
        os.utime(tmp_path / f"{A}.jpg", (10, 10))
        os.utime(tmp_path / f"{B}.jpg", (20, 20))
        old_version = cache.version(A)

        async def generate(asset_id):
            if asset_id == A:
                raise RuntimeError("private failure detail")
            return b"newC"

        monkeypatch.setattr(cache_module, "MAX_CACHE_BYTES", 8)
        hub = ThumbnailPublicationHub()
        subscriber = hub.subscribe()
        scheduler = ThumbnailScheduler(cache, generate, publication_hub=hub)
        await scheduler.start()
        try:
            scheduler.schedule(A, immediate=True)
            async def failed():
                while scheduler.generation_state(A) != "failed":
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(failed(), 2)
            failure_events = []
            while not subscriber.empty():
                failure_events.append(subscriber.get_nowait())
            assert failure_events[-1]["state"] == "failed"
            assert failure_events[-1]["publicationVersion"] == old_version
            assert cache.read_versioned(A) == (b"oldA", old_version)

            scheduler.schedule(C, immediate=True)
            async def published():
                while scheduler.generation_state(C) != "published":
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(published(), 2)
            events = []
            while not subscriber.empty():
                events.append(subscriber.get_nowait())
            evicted = next(event for event in events if event.get("state") == "cache_missing")
            assert evicted["assetId"] == str(A) and evicted["publicationVersion"] is None
            assert cache.version(A) is None and cache.read(B) == b"oldB" and cache.read(C) == b"newC"
        finally:
            await scheduler.close()
            hub.unsubscribe(subscriber)
    asyncio.run(run())
