import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import httpx
import pytest

import edit_store
import main
import raw_recipe_store as store
from immich import ImmichThumbnail
from thumbnail_cache import ThumbnailCache
from thumbnail_lifecycle import mutate_raw_edits
from thumbnail_scheduler import ThumbnailScheduler
from tests.test_raw_recipe_store import identity, settings
from tests.test_thumbnail_generator import ASSET, snapshot
from tests.test_thumbnail_scheduler import until
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup as raw_setup, open_document
from tests.test_raw_recipe_api import change, save_body
from tests.test_raw_history_api import operation, commit_body, body
from tests.test_raw_controls import identity as document_identity


@pytest.fixture
def lifecycle(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "edits.db")
    edit_store.initialize_database()
    cache = ThumbnailCache(tmp_path / "thumbnails")
    now = [0]
    generate = AsyncMock(return_value=b"rendered")
    scheduler = ThumbnailScheduler(cache, generate, clock=lambda: now[0])
    monkeypatch.setattr(main.app.state, "thumbnail_scheduler", scheduler, raising=False)
    monkeypatch.setattr(main.app.state, "thumbnail_cache", cache, raising=False)
    monkeypatch.setattr(main, "get_asset_detail", AsyncMock(return_value=SimpleNamespace(is_raw=True)))
    monkeypatch.setattr(main, "get_asset_thumbnail", AsyncMock(return_value=ImmichThumbnail(b"thumbnail", "image/jpeg")))
    monkeypatch.setattr(main, "get_asset_preview", AsyncMock(return_value=ImmichThumbnail(b"preview", "image/jpeg")))
    return cache, scheduler, now, generate


def save(kind="edited", *, asset=ASSET, revision=0, exposure=.7, save_id=None):
    baseline = settings()
    current = deepcopy(baseline)
    if kind != "default":
        current["light"]["exposure"] = exposure
    return store.put_raw_recipe(identity(assetId=str(asset)), revision, save_id or uuid4(), current,
        import_defaults_fingerprint=None if kind == "unknown" else store._digest(store._settings_json(baseline, 1)))


@pytest.mark.parametrize("kind", ["edited", "default", "unknown", "missing"])
@pytest.mark.parametrize("endpoint", ["rendered-thumbnail", "immersive-preview"])
@pytest.mark.parametrize("cached", [False, True])
def test_raw_get_eligibility_and_legacy_jpeg_never_overrides(lifecycle, kind, endpoint, cached):
    cache, scheduler, _, generate = lifecycle
    # Legacy JPEG-preview edits are deliberately non-default for every RAW case.
    edit_store.put_edit_state(ASSET, 0, uuid4(), snapshot())
    if kind != "missing": save(kind)
    if cached: cache.store(ASSET, b"cached")
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as http:
            response = await http.get(f"/assets/{ASSET}/{endpoint}")
            assert response.status_code == 200
            assert response.content == (b"cached" if kind == "edited" and cached else
                b"thumbnail" if endpoint == "rendered-thumbnail" else b"preview")
            assert response.headers["cache-control"] == "private, no-store"
        assert not scheduler._pending and not scheduler._deadlines
        generate.assert_not_called()
    asyncio.run(run())


@pytest.mark.parametrize("kind,reason", [("edited", None), ("default", "recipe_default"),
                                         ("unknown", "recipe_unknown"), ("missing", "recipe_missing")])
def test_raw_post_only_queues_eligible_saved_state(lifecycle, kind, reason):
    cache, scheduler, _, generate = lifecycle
    edit_store.put_edit_state(ASSET, 0, uuid4(), snapshot())
    if kind != "missing": save(kind)
    cache.store(ASSET, b"old")
    scheduler.schedule(ASSET)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as http:
            result = await http.post(f"/assets/{ASSET}/rendered-thumbnail")
            assert result.status_code == (200 if reason else 202)
            assert result.json() == ({"status": "skipped", "reason": reason} if reason else {"status": "queued"})
            assert list(scheduler._pending) == ([] if reason else [ASSET])
            assert not scheduler._deadlines
            assert cache.read(ASSET) == (None if reason else b"old")
            generate.assert_not_called()
    asyncio.run(run())


def test_mutation_commit_debounce_replay_failure_default_unknown_delete(lifecycle):
    cache, scheduler, now, _ = lifecycle
    async def run():
        save_id = uuid4()
        await mutate_raw_edits(scheduler, ASSET, save, save_id=save_id)
        assert scheduler._deadlines == {ASSET: 60}
        assert store.get_raw_saved_state(ASSET)["exportEligible"] is True
        now[0] = 10
        await mutate_raw_edits(scheduler, ASSET, save, save_id=save_id)
        assert scheduler._deadlines == {ASSET: 60}
        await mutate_raw_edits(scheduler, ASSET, save, revision=1, exposure=1.2)
        assert scheduler._deadlines == {ASSET: 70}
        def fail(): raise store.StoreUnavailable()
        with pytest.raises(store.StoreUnavailable):
            await mutate_raw_edits(scheduler, ASSET, fail)
        assert scheduler._deadlines == {ASSET: 70}
        cache.store(ASSET, b"old")
        await mutate_raw_edits(scheduler, ASSET, save, "default", revision=2)
        assert not scheduler._deadlines and cache.read(ASSET) is None
        await mutate_raw_edits(scheduler, ASSET, store.delete_raw_edits, str(ASSET))
        await mutate_raw_edits(scheduler, ASSET, save, "unknown")
        assert not scheduler._deadlines
        scheduler.schedule(ASSET)
        cache.store(ASSET, b"stale")
        await mutate_raw_edits(scheduler, ASSET, store.delete_raw_edits, str(ASSET))
        assert not scheduler._deadlines and cache.read(ASSET) is None
    asyncio.run(run())


def test_cache_failure_does_not_fail_committed_save(lifecycle, monkeypatch):
    cache, scheduler, _, _ = lifecycle
    monkeypatch.setattr(cache, "delete", lambda *_: (_ for _ in ()).throw(OSError()))
    result = asyncio.run(mutate_raw_edits(scheduler, ASSET, save, "default"))
    assert result["revision"] == 1 and store.get_raw_saved_state(ASSET)["exportEligible"] is False


@pytest.mark.parametrize("method,endpoint", [("GET", "rendered-thumbnail"), ("POST", "rendered-thumbnail"),
                                            ("GET", "immersive-preview")])
def test_raw_store_failure_is_error_never_stale_cache_or_default(lifecycle, monkeypatch, method, endpoint):
    cache, scheduler, _, _ = lifecycle
    cache.store(ASSET, b"stale")
    def fail(*args): raise store.StoreUnavailable()
    monkeypatch.setattr(main, "get_raw_saved_state", fail)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as http:
            result = await http.request(method, f"/assets/{ASSET}/{endpoint}")
            assert result.status_code == 503 and result.content != b"stale"
            assert not scheduler._pending and not scheduler._deadlines
    asyncio.run(run())


def test_history_receipt_only_commit_keeps_existing_deadline(lifecycle):
    _, scheduler, now, _ = lifecycle
    async def run():
        key = identity(assetId=str(ASSET))
        baseline = settings()
        current = deepcopy(baseline)
        current["light"]["exposure"] = .7
        kwargs = {"kind": "control", "metadata": {"control": "light.exposure"},
                  "import_defaults_fingerprint": store._digest(store._settings_json(baseline, 1))}
        await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, key, 0, uuid4(), current,
                               baseline_settings=baseline, **kwargs)
        assert scheduler._deadlines == {ASSET: 60}
        now[0] = 10
        await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, key, 1, uuid4(), current, **kwargs)
        assert scheduler._deadlines == {ASSET: 60}
    asyncio.run(run())


def test_shutdown_waits_for_active_raw_and_drops_pending_jpeg(lifecycle):
    cache, _, _, _ = lifecycle
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def generate(asset):
            calls.append(asset)
            entered.set()
            await release.wait()
            return b"raw-finished"
        scheduler = ThumbnailScheduler(cache, generate)
        await scheduler.start()
        scheduler.schedule(ASSET, immediate=True)
        await entered.wait()
        scheduler.schedule(UUID(int=2), immediate=True)
        closing = asyncio.create_task(scheduler.close())
        await asyncio.sleep(0)
        assert not closing.done()
        release.set()
        await closing
        assert calls == [ASSET] and cache.read(ASSET) == b"raw-finished"
        assert not scheduler._pending
    asyncio.run(run())


@pytest.mark.parametrize("mutation", ["delete", "default", "unknown", "resave"])
def test_raw_mutation_during_generation_discards_old_result(lifecycle, mutation):
    cache, scheduler, _, generate = lifecycle
    async def run():
        save()
        entered, release = asyncio.Event(), asyncio.Event()
        async def render(asset):
            entered.set()
            await release.wait()
            return b"obsolete"
        generate.side_effect = render
        cache.store(ASSET, b"previous")
        await scheduler.start()
        try:
            scheduler.schedule(ASSET, immediate=True)
            await entered.wait()
            if mutation == "delete":
                await mutate_raw_edits(scheduler, ASSET, store.delete_raw_edits, str(ASSET))
            elif mutation == "unknown":
                # Model a successful save whose default baseline cannot be established.
                await mutate_raw_edits(scheduler, ASSET, store.delete_raw_edits, str(ASSET))
                await mutate_raw_edits(scheduler, ASSET, save, "unknown")
            else:
                await mutate_raw_edits(scheduler, ASSET, save,
                    "default" if mutation == "default" else "edited", revision=1, exposure=1.2)
            release.set()
            await until(lambda: scheduler._active is None)
            assert cache.read(ASSET) == (b"previous" if mutation == "resave" else None)
        finally:
            release.set()
            await scheduler.close()
    asyncio.run(run())


@pytest.mark.parametrize("failing_raw", [False, True, None])
def test_mixed_queue_dispatch_failure_continuation_and_shutdown(lifecycle, monkeypatch, failing_raw):
    cache, _, _, _ = lifecycle
    raw_id, jpeg_id = UUID(int=2), ASSET
    calls = []
    async def detail(url, key, asset): return SimpleNamespace(is_raw=asset == raw_id)
    async def generate(asset, **kwargs):
        assert kwargs["input_kind"] == ("raw" if asset == raw_id else "jpeg")
        calls.append(asset)
        if failing_raw is not None and (asset == raw_id) == failing_raw: raise ValueError("failure")
        return b"updated"
    monkeypatch.setattr(main, "get_asset_detail", detail)
    monkeypatch.setattr(main, "generate_thumbnail", generate)
    async def callback(asset): return await main.generate_saved_thumbnail(asset, immich_url=None, api_key=None)
    async def run():
        scheduler = ThumbnailScheduler(cache, callback)
        await scheduler.start()
        cache.store(raw_id, b"old")
        cache.store(jpeg_id, b"old")
        for asset in (raw_id, jpeg_id): scheduler.schedule(asset, immediate=True)
        await until(lambda: len(calls) == 2 and scheduler._active is None)
        await scheduler.close()
        assert calls == [raw_id, jpeg_id] and scheduler._task.done()
        for asset in calls:
            failed = failing_raw is not None and (asset == raw_id) == failing_raw
            assert cache.read(asset) == (b"old" if failed else b"updated")
    asyncio.run(run())


def test_real_raw_recipe_api_notifies_only_after_success(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await raw_setup(tmp_path, local, monkeypatch)
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path / "thumbs"), AsyncMock())
        monkeypatch.setattr(main.app.state, "thumbnail_scheduler", scheduler, raising=False)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                asset = UUID(doc["assetId"])
                doc = await change(http, doc, 1.)
                assert not scheduler._deadlines
                url = f'/api/raw/documents/{doc["handle"]}/recipe'
                with monkeypatch.context() as patch:
                    def fail(*args, **kwargs): raise store.StoreUnavailable()
                    patch.setattr(store, "put_raw_recipe", fail)
                    assert (await http.put(url, json=save_body(doc))).status_code == 503
                assert not scheduler._deadlines
                assert (await http.put(url, json=save_body(doc))).status_code == 200
                assert asset in scheduler._deadlines
                scheduler.cache.store(asset, b"old")
                request = document_identity(doc) | {"documentRevision": doc["revision"], "handle": doc["handle"]}
                assert (await http.post(f'/api/raw/assets/{asset}/edits/reset', json=request)).status_code == 204
                assert not scheduler._deadlines and scheduler.cache.read(asset) is None
        finally: await api.close()
    asyncio.run(run())


def test_real_raw_history_commit_undo_default_and_redo(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await raw_setup(tmp_path, local, monkeypatch)
        scheduler = ThumbnailScheduler(ThumbnailCache(tmp_path / "thumbs"), AsyncMock())
        monkeypatch.setattr(main.app.state, "thumbnail_scheduler", scheduler, raising=False)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                asset = UUID(doc["assetId"])
                doc = await operation(http, doc, "initialize")
                assert not scheduler._deadlines
                doc = await change(http, doc, 1.)
                assert not scheduler._deadlines
                doc = await operation(http, doc, "commit", commit_body(doc))
                assert asset in scheduler._deadlines
                scheduler.cache.store(asset, b"old")
                doc = await operation(http, doc, "undo", body(doc))
                assert doc["history"]["length"] == 1
                assert not scheduler._deadlines and scheduler.cache.read(asset) is None
                doc = await operation(http, doc, "redo", body(doc))
                assert asset in scheduler._deadlines
        finally: await api.close()
    asyncio.run(run())
