import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest

import edit_store
import main
from edit_store import StoreUnavailable
from immich import ImmichRequestError, ImmichThumbnail
from thumbnail_cache import ThumbnailCache
from thumbnail_scheduler import ThumbnailScheduler
from tests.test_thumbnail_generator import ASSET, snapshot
from tests.test_thumbnail_scheduler import until

PATH = f"/assets/{ASSET}/rendered-thumbnail"
IMMERSIVE_PATH = f"/assets/{ASSET}/immersive-preview"
EDIT_PATH = f"/assets/{ASSET}/edit-state"


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "edits.db")
    cache = ThumbnailCache(tmp_path / "thumbnails")
    now = [0]
    generate = AsyncMock(return_value=b"rendered")
    scheduler = ThumbnailScheduler(cache, generate, clock=lambda: now[0])
    monkeypatch.setattr(main.app.state, "thumbnail_scheduler", scheduler, raising=False)
    monkeypatch.setattr(main.app.state, "thumbnail_cache", cache, raising=False)
    original = AsyncMock(return_value=ImmichThumbnail(b"original", "image/jpeg"))
    monkeypatch.setattr(main, "get_asset_thumbnail", original)
    return cache, scheduler, now, generate, original


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


async def put(client, state=None, revision=0, save_id=None):
    return await client.put(EDIT_PATH, json={"expectedRevision": revision,
                                            "saveId": str(save_id or uuid4()),
                                            **(state if state is not None else snapshot())})


def test_save_debounce_history_only_replay_reset_and_conflict(setup):
    cache, scheduler, now, generate, _ = setup
    async def run():
        async with client() as api:
            first_id = uuid4()
            first = await put(api, save_id=first_id)
            assert first.status_code == 200 and first.json()["revision"] == 1
            assert scheduler._deadlines == {ASSET: 60}
            now[0] = 10
            assert (await put(api, save_id=first_id)).json() == first.json()
            assert scheduler._deadlines == {ASSET: 60}
            history = snapshot()
            history["history"] = [{"kind": "exposure", "before": snapshot(0)["currentRecipe"],
                                    "after": deepcopy(history["currentRecipe"])}]
            history["historyCursor"] = 1
            assert (await put(api, history, 1)).status_code == 200
            assert scheduler._deadlines == {ASSET: 60}
            now[0] = 20
            assert (await put(api, snapshot(2), 2)).status_code == 200
            assert scheduler._deadlines == {ASSET: 80}
            assert (await put(api, snapshot(3), 1)).status_code == 409
            assert scheduler._deadlines == {ASSET: 80}
            cache.store(ASSET, b"old")
            assert (await put(api, snapshot(0), 3)).status_code == 200
            assert cache.read(ASSET) is None and not scheduler._deadlines
            generate.assert_not_called()
    asyncio.run(run())


def test_store_failure_never_reserves(setup, monkeypatch):
    _, scheduler, _, _, _ = setup
    def fail(*args):
        raise StoreUnavailable()
    monkeypatch.setattr(main, "put_edit_state_with_recipe_change", fail)
    async def run():
        async with client() as api:
            assert (await put(api)).status_code == 503
        assert not scheduler._deadlines
    asyncio.run(run())


@pytest.mark.parametrize("phase", ["schedule", "delete"])
def test_optional_maintenance_failure_does_not_fail_committed_save(setup, monkeypatch, phase):
    cache, scheduler, _, _, _ = setup
    def fail(*args, **kwargs):
        raise OSError("private failure")
    async def run():
        async with client() as api:
            if phase == "schedule":
                monkeypatch.setattr(scheduler, "schedule", fail)
                result = await put(api)
            else:
                await put(api)
                monkeypatch.setattr(cache, "delete", fail)
                result = await put(api, snapshot(0), 1)
            assert result.status_code == 200
            assert edit_store.get_edit_state(ASSET) == result.json()
    asyncio.run(run())


def test_default_recipe_after_delete_failure_falls_back_to_original(setup, monkeypatch):
    cache, scheduler, _, generate, original = setup
    def fail_delete(*args, **kwargs):
        raise OSError("private failure")
    async def run():
        async with client() as api:
            assert (await put(api, snapshot(1))).status_code == 200
            cache.store(ASSET, b"stale rendered thumbnail")
            monkeypatch.setattr(cache, "delete", fail_delete)
            reset = await put(api, snapshot(0), 1)
            assert reset.status_code == 200
            assert edit_store.get_edit_state(ASSET)["state"]["currentRecipe"] == snapshot(0)["currentRecipe"]
            assert cache.read(ASSET) == b"stale rendered thumbnail"
            result = await api.get(PATH)
            assert result.status_code == 200 and result.content == b"original"
            assert result.headers["cache-control"] == "private, no-store"
        assert original.await_count == 1
        generate.assert_not_called()
        assert not scheduler._pending and not scheduler._deadlines
    asyncio.run(run())


def test_recipe_lookup_failure_never_serves_cached_thumbnail(setup, monkeypatch):
    cache, _, _, generate, original = setup
    cache.store(ASSET, b"rendered")
    def fail(*args):
        raise StoreUnavailable()
    monkeypatch.setattr(main, "get_edit_state", fail)
    async def run():
        async with client() as api:
            result = await api.get(PATH)
            assert result.status_code == 503
            assert result.json()["detail"]["code"] == "persistence_unavailable"
        original.assert_not_awaited()
        generate.assert_not_called()
    asyncio.run(run())


def test_get_only_reads_cache_or_original_and_never_generates(setup):
    cache, scheduler, _, generate, original = setup
    async def run():
        async with client() as api:
            assert (await put(api, snapshot(1))).status_code == 200
            scheduler._deadlines.clear()
            result = await api.get(PATH)
            assert result.status_code == 200 and result.content == b"original"
            assert result.headers["cache-control"] == "private, no-store"
            cache.store(ASSET, b"rendered")
            scheduler._active = ASSET
            result = await api.get(PATH)
            assert result.content == b"rendered" and result.headers["content-type"] == "image/jpeg"
            assert result.headers["cache-control"] == "private, no-store"
            cache.store(ASSET, b"updated")
            assert (await api.get(PATH)).content == b"updated"
            source = await api.get(f"/assets/{ASSET}/thumbnail")
            assert source.content == b"original"
            assert source.headers["cache-control"] == "private, max-age=300"
        assert original.await_count == 2
        generate.assert_not_called()
        assert not scheduler._pending and not scheduler._deadlines
    asyncio.run(run())


@pytest.mark.parametrize("edited,reason,status", [(None, "recipe_missing", 200),
                                                (False, "recipe_default", 200),
                                                (True, None, 202)])
def test_immediate_request_http_contract(setup, edited, reason, status):
    cache, scheduler, _, generate, _ = setup
    async def run():
        async with client() as api:
            if edited is not None:
                await put(api, snapshot(1 if edited else 0))
            result = await api.post(PATH)
            assert result.status_code == status
            assert result.json() == ({"status": "queued"} if edited else {"status": "skipped", "reason": reason})
            if edited:
                assert list(scheduler._pending) == [ASSET] and not scheduler._deadlines
                await api.post(PATH)
                assert list(scheduler._pending) == [ASSET]
            else:
                assert not scheduler._pending and cache.read(ASSET) is None
            generate.assert_not_called()
    asyncio.run(run())


def test_fallback_failure_preserves_existing_upstream_error_contract(setup):
    _, _, _, generate, original = setup
    original.side_effect = ImmichRequestError("unreachable", "unreachable")
    async def run():
        async with client() as api:
            result = await api.get(PATH)
            assert result.status_code == 503
        generate.assert_not_called()
    asyncio.run(run())


@pytest.mark.parametrize("saved_state,cache_content,expected", [
    ("edited", b"cached-jpeg", b"cached-jpeg"),
    (None, b"unused-cache", b"immich-preview"),
    ("default", b"unused-cache", b"immich-preview"),
    ("edited", None, b"immich-preview"),
])
def test_immersive_preview_prefers_only_saved_edited_cache(setup, monkeypatch, saved_state, cache_content, expected):
    cache, scheduler, _, generate, _ = setup
    preview = AsyncMock(return_value=ImmichThumbnail(b"immich-preview", "image/jpeg"))
    monkeypatch.setattr(main, "get_asset_preview", preview)
    async def run():
        async with client() as api:
            if saved_state is not None:
                state = snapshot(0) if saved_state == "default" else snapshot()
                assert (await put(api, state)).status_code == 200
            if cache_content is not None:
                cache.store(ASSET, cache_content)
            pending_before = dict(scheduler._pending)
            deadlines_before = dict(scheduler._deadlines)
            result = await api.get(IMMERSIVE_PATH)
            assert result.status_code == 200 and result.content == expected
            assert result.headers["cache-control"] == "private, no-store"
            assert scheduler._pending == pending_before and scheduler._deadlines == deadlines_before
            if expected == b"cached-jpeg": preview.assert_not_awaited()
            else: preview.assert_awaited_once()
            generate.assert_not_called()
    asyncio.run(run())


def test_immersive_preview_cache_read_failure_falls_back_and_preview_failure_maps_error(setup, monkeypatch):
    cache, _, _, generate, _ = setup
    monkeypatch.setattr(main, "get_asset_preview", AsyncMock(return_value=ImmichThumbnail(b"preview", "image/jpeg")))
    class BrokenPath:
        def read_bytes(self): raise OSError("private cache failure")
    monkeypatch.setattr(cache, "_path", lambda _asset_id: BrokenPath())
    async def run():
        async with client() as api:
            assert (await put(api)).status_code == 200
            result = await api.get(IMMERSIVE_PATH)
            assert result.status_code == 200 and result.content == b"preview"
            monkeypatch.setattr(main, "get_asset_preview", AsyncMock(side_effect=ImmichRequestError("unreachable", "unreachable")))
            failed = await api.get(IMMERSIVE_PATH)
            assert failed.status_code == 503
        generate.assert_not_called()
    asyncio.run(run())


def test_original_preview_bypasses_edited_cache_without_loading_recipe_or_scheduling(setup, monkeypatch):
    cache, scheduler, _, generate, _ = setup
    preview = AsyncMock(return_value=ImmichThumbnail(b"original-preview", "image/jpeg"))
    monkeypatch.setattr(main, "get_asset_preview", preview)
    async def run():
        async with client() as api:
            assert (await put(api)).status_code == 200
            cache.store(ASSET, b"edited-cache")
            pending_before = dict(scheduler._pending)
            monkeypatch.setattr(main, "get_edit_state", Mock(side_effect=AssertionError("Recipe must not be read")))
            monkeypatch.setattr(cache, "read", Mock(side_effect=AssertionError("Cache must not be read")))
            result = await api.get(f"/assets/{ASSET}/preview")
            assert result.status_code == 200 and result.content == b"original-preview"
            assert result.headers["cache-control"] == "private, max-age=300"
            assert scheduler._pending == pending_before
            preview.assert_awaited_once()
            generate.assert_not_called()
    asyncio.run(run())


def test_lifespan_owns_scheduler_and_closes_it(setup, monkeypatch):
    cache, _, _, _, _ = setup
    monkeypatch.setattr(main, "ThumbnailCache", lambda: cache)
    monkeypatch.setattr(main, "initialize_storage", lambda: None)
    monkeypatch.setattr(main, "validate_existing_database", lambda: None)
    async def run():
        async with main.app.router.lifespan_context(main.app):
            scheduler = main.app.state.thumbnail_scheduler
            assert scheduler._task is not None and not scheduler._task.done()
            async with client() as api:
                await put(api)
            assert ASSET in scheduler._deadlines
        assert scheduler._closed and scheduler._task.done()
        assert not scheduler._deadlines
    asyncio.run(run())


def test_api_reset_during_generation_never_resurrects_cache(setup):
    cache, scheduler, _, generate, _ = setup
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        async def render(asset_id):
            entered.set()
            await release.wait()
            return b"stale output"
        generate.side_effect = render
        await scheduler.start()
        try:
            async with client() as api:
                await put(api)
                cache.store(ASSET, b"previous output")
                assert (await api.post(PATH)).status_code == 202
                await entered.wait()
                assert (await api.get(PATH)).content == b"previous output"
                assert (await put(api, snapshot(0), 1)).status_code == 200
                assert cache.read(ASSET) is None
                release.set()
                await until(lambda: scheduler._active is None)
                assert cache.read(ASSET) is None
                assert (await api.get(PATH)).content == b"original"
        finally:
            release.set()
            await scheduler.close()
    asyncio.run(run())
