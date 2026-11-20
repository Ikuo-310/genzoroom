import asyncio
import threading
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import httpx
import pytest

import edit_store
import main
import raw_recipe_store as store
import storage
from immich import ImmichThumbnail
from thumbnail_cache import ThumbnailCache
from thumbnail_lifecycle import mutate_raw_edits
from thumbnail_publication import ThumbnailPublicationHub
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
    monkeypatch.setattr(storage, "WINDOWS_STORAGE", True)
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
def test_raw_thumbnail_batch_state_matches_the_existing_eligibility_contract(lifecycle, kind, monkeypatch):
    if kind != "missing":
        save(kind)
    existing = store.get_raw_saved_state(ASSET)

    def unexpected_history_restore(*_args):
        pytest.fail("thumbnail status must not restore RAW History")

    monkeypatch.setattr(store, "_read_history", unexpected_history_restore)
    result = store.get_raw_thumbnail_recipe_states([ASSET])
    assert result[str(ASSET)] == {
        "recipeRevision": existing["revision"] if existing is not None else None,
        "edited": existing["exportEligible"] if existing is not None else False,
    }


def test_raw_history_only_save_advances_consistency_revision_without_publication(lifecycle):
    cache, scheduler, _, generate = lifecycle
    key = identity(assetId=str(ASSET))
    baseline = settings()
    current = deepcopy(baseline)
    current["light"]["exposure"] = .7
    fingerprint = store._digest(store._settings_json(baseline, 1))
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    save_id = uuid4()
    history_save_id = uuid4()
    options = {"kind": "control", "metadata": {"control": "light.exposure"},
               "import_defaults_fingerprint": fingerprint}

    async def run():
        await mutate_raw_edits(scheduler, ASSET, store.put_raw_recipe, key, 0, save_id, current,
                               import_defaults_fingerprint=fingerprint)
        assert store.get_raw_saved_state(ASSET)["revision"] == 1
        assert hub.position()[1] == 1 and hub.consistency_position()[2] == 1
        cache.store(ASSET, b"previously published")
        version = cache.version(ASSET)
        deadline = dict(scheduler._deadlines)

        operation = (key, 1, history_save_id, current)
        result = await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *operation, **options)
        assert result["replayed"] is False
        assert store.get_raw_saved_state(ASSET)["revision"] == 2
        assert hub.position()[1] == 1
        assert hub.consistency_position()[2] == 2
        assert scheduler._deadlines == deadline
        assert cache.version(ASSET) == version

        replay = await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *operation, **options)
        assert replay["replayed"] is True
        assert store.get_raw_saved_state(ASSET)["revision"] == 2
        assert hub.position()[1] == 1
        assert hub.consistency_position()[2] == 2
        assert scheduler._deadlines == deadline
        assert cache.version(ASSET) == version

    asyncio.run(run())
    generate.assert_not_called()


def test_default_raw_history_changes_only_internal_sequence_and_replay_is_inert(lifecycle):
    cache, scheduler, _, generate = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    resets = []
    reset = scheduler.reset

    async def record_reset(asset_id):
        resets.append(asset_id)
        await reset(asset_id)

    scheduler.reset = record_reset
    key = identity(assetId=str(ASSET))
    baseline = settings()
    fingerprint = store._digest(store._settings_json(baseline, 1))
    recipe_id, history_id = uuid4(), uuid4()
    history_kwargs = {"kind": "control", "metadata": {"control": "light.exposure"},
                      "import_defaults_fingerprint": fingerprint}

    async def run():
        initial = await mutate_raw_edits(scheduler, ASSET, store.put_raw_recipe, key, 0, recipe_id, baseline,
                                         import_defaults_fingerprint=fingerprint)
        assert initial["revision"] == 1
        assert store.get_raw_saved_state(ASSET)["exportEligible"] is False
        assert hub.consistency_position()[2] == 1 and hub.position()[1] == 1
        assert scheduler._deadlines == {} and resets == [ASSET]
        initial_version = cache.version(ASSET)

        operation = (key, 1, history_id, baseline)
        saved = await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *operation,
                                       **history_kwargs)
        assert saved["replayed"] is False
        assert store.get_raw_saved_state(ASSET)["revision"] == 2
        assert hub.consistency_position()[2] == 2 and hub.position()[1] == 1
        assert scheduler._deadlines == {} and resets == [ASSET]
        assert cache.version(ASSET) == initial_version

        replay = await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *operation,
                                        **history_kwargs)
        assert replay["replayed"] is True
        assert store.get_raw_saved_state(ASSET)["revision"] == 2
        assert hub.consistency_position()[2] == 2 and hub.position()[1] == 1
        assert scheduler._deadlines == {} and resets == [ASSET]
        assert cache.version(ASSET) == initial_version

    asyncio.run(run())
    generate.assert_not_called()


def test_recipe_save_result_tracks_commit_when_followup_state_read_fails(lifecycle, monkeypatch):
    cache, scheduler, _, generate = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    saved_state = store.get_raw_saved_state
    calls = [0]

    def fail_post_save_read(asset_id):
        calls[0] += 1
        if calls[0] == 2:
            raise store.StoreUnavailable()
        return saved_state(asset_id)

    monkeypatch.setattr(store, "get_raw_saved_state", fail_post_save_read)
    save_id = uuid4()
    key = identity(assetId=str(ASSET))
    current = deepcopy(settings())
    current["light"]["exposure"] = .7
    fingerprint = store._digest(store._settings_json(settings(), 1))

    async def run():
        # The pre-save state is readable; only the optional post-commit read fails.
        result = await mutate_raw_edits(scheduler, ASSET, store.put_raw_recipe, key, 0, save_id, current,
                                        import_defaults_fingerprint=fingerprint)
        assert result["revision"] == 1
        assert calls[0] == 1
        assert saved_state(ASSET)["revision"] == 1
        assert hub.consistency_position()[2] == 1
        assert hub.position()[1] == 1
        assert scheduler._deadlines == {ASSET: 60}

        # The same receipt is known to be a replay and must not double-count the mutation.
        monkeypatch.setattr(store, "get_raw_saved_state", saved_state)
        replay = await mutate_raw_edits(scheduler, ASSET, store.put_raw_recipe, key, 0, save_id, current,
                                        import_defaults_fingerprint=fingerprint)
        assert replay["revision"] == 1
        assert hub.consistency_position()[2] == 1
        assert hub.position()[1] == 1
        assert scheduler._deadlines == {ASSET: 60}

    asyncio.run(run())
    generate.assert_not_called()


def test_raw_save_mutation_invalidates_a_concurrent_publication_status_snapshot(lifecycle, monkeypatch):
    _, scheduler, _, generate = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    monkeypatch.setattr(main.app.state, "thumbnail_publication_hub", hub, raising=False)
    save("edited", revision=0)
    original = main.get_thumbnail_recipe_states
    saved_state = store.get_raw_saved_state
    calls = [0]
    state_calls = [0]
    entered_loop = None
    release_loop = None
    entered = None

    def delayed_read(asset_ids):
        result = original(asset_ids)
        calls[0] += 1
        if calls[0] == 1:
            entered_loop.call_soon_threadsafe(entered.set)
            release_loop.wait()
        return result

    def fail_only_post_mutation_read(asset_id):
        state_calls[0] += 1
        if state_calls[0] == 2:
            raise store.StoreUnavailable()
        return saved_state(asset_id)

    async def run():
        nonlocal entered, entered_loop, release_loop
        entered_loop = asyncio.get_running_loop()
        release_loop = threading.Event()
        entered = asyncio.Event()
        monkeypatch.setattr(main, "get_thumbnail_recipe_states", delayed_read)
        monkeypatch.setattr(store, "get_raw_saved_state", fail_only_post_mutation_read)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as api:
            pending = asyncio.create_task(api.post("/thumbnail-publications/status",
                json={"assetIds": [str(ASSET)]}))
            await asyncio.wait_for(entered.wait(), 3)
            current = deepcopy(settings())
            current["light"]["exposure"] = 1.2
            await mutate_raw_edits(scheduler, ASSET, store.put_raw_recipe, identity(assetId=str(ASSET)), 1,
                                   uuid4(), current)
            assert state_calls[0] == 1
            release_loop.set()
            response = await pending
            assert response.status_code == 200
            assert response.json()["items"][str(ASSET)]["recipeRevision"] == 2
            assert response.json()["items"][str(ASSET)]["state"] == "reserved"
            assert calls[0] >= 2
            assert hub.consistency_position()[2] == 1
            assert hub.position()[1] == 1 and scheduler._deadlines == {ASSET: 60}
    try:
        asyncio.run(run())
    finally:
        if release_loop is not None:
            release_loop.set()
    generate.assert_not_called()


def test_default_edited_history_and_undo_transitions_have_targeted_notifications(lifecycle):
    cache, scheduler, _, generate = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    reset_ids = []
    reset = scheduler.reset

    async def record_reset(asset_id):
        reset_ids.append(asset_id)
        await reset(asset_id)

    scheduler.reset = record_reset
    key = identity(assetId=str(ASSET))
    baseline = settings()
    edited = deepcopy(baseline)
    edited["light"]["exposure"] = .7
    fingerprint = store._digest(store._settings_json(baseline, 1))
    history_kwargs = {"kind": "control", "metadata": {"control": "light.exposure"},
                      "import_defaults_fingerprint": fingerprint}
    move_kwargs = {"import_defaults_fingerprint": fingerprint}
    default_recipe_id, default_history_id = uuid4(), uuid4()
    edited_step_id, edited_history_id = uuid4(), uuid4()

    async def run():
        await mutate_raw_edits(scheduler, ASSET, store.put_raw_recipe, key, 0, default_recipe_id, baseline,
                               import_defaults_fingerprint=fingerprint)
        assert store.get_raw_saved_state(ASSET)["exportEligible"] is False
        assert hub.consistency_position()[2] == 1 and hub.position()[1] == 1
        assert scheduler._deadlines == {} and reset_ids == [ASSET]

        default_history = (key, 1, default_history_id, baseline)
        await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *default_history,
                               baseline_settings=baseline, **history_kwargs)
        assert store.get_raw_saved_state(ASSET)["revision"] == 2
        assert hub.consistency_position()[2] == 2 and hub.position()[1] == 1
        assert scheduler._deadlines == {} and reset_ids == [ASSET]
        await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *default_history,
                               baseline_settings=baseline, **history_kwargs)
        assert hub.consistency_position()[2] == 2 and hub.position()[1] == 1
        assert scheduler._deadlines == {} and reset_ids == [ASSET]

        edited_history = (key, 2, edited_history_id, edited)
        step = await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *edited_history,
                                      baseline_settings=baseline, step_id=edited_step_id, **history_kwargs)
        assert step["replayed"] is False and step["ack"]["stepId"] == str(edited_step_id)
        assert store.get_raw_saved_state(ASSET)["exportEligible"] is True
        assert hub.consistency_position()[2] == 3 and hub.position()[1] == 2
        assert scheduler._deadlines == {ASSET: 60} and reset_ids == [ASSET]

        replay = await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, *edited_history,
                                       baseline_settings=baseline, step_id=edited_step_id, **history_kwargs)
        assert replay["replayed"] is True
        assert hub.consistency_position()[2] == 3 and hub.position()[1] == 2
        assert scheduler._deadlines == {ASSET: 60} and reset_ids == [ASSET]

        await mutate_raw_edits(scheduler, ASSET, store.append_raw_history, key, 3, uuid4(), edited,
                               **history_kwargs)
        assert store.get_raw_saved_state(ASSET)["revision"] == 4
        assert hub.consistency_position()[2] == 4 and hub.position()[1] == 2
        assert scheduler._deadlines == {ASSET: 60} and reset_ids == [ASSET]

        await mutate_raw_edits(scheduler, ASSET, store.move_raw_history_cursor, key, 4, uuid4(), baseline,
                               target_step_id=None, **move_kwargs)
        assert store.get_raw_saved_state(ASSET)["exportEligible"] is False
        assert hub.consistency_position()[2] == 5 and hub.position()[1] == 3
        assert scheduler._deadlines == {} and reset_ids == [ASSET, ASSET]
        assert cache.read(ASSET) is None

        await mutate_raw_edits(scheduler, ASSET, store.move_raw_history_cursor, key, 5, uuid4(), edited,
                               target_step_id=edited_step_id, **move_kwargs)
        assert store.get_raw_saved_state(ASSET)["exportEligible"] is True
        assert hub.consistency_position()[2] == 6 and hub.position()[1] == 4
        assert scheduler._deadlines == {ASSET: 60} and reset_ids == [ASSET, ASSET]

    asyncio.run(run())
    generate.assert_not_called()


def test_pre_save_state_read_failure_still_tracks_committed_raw_save(lifecycle, monkeypatch):
    _, scheduler, _, generate = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    saved_state = store.get_raw_saved_state
    calls = [0]

    def fail_pre_save_read(asset_id):
        calls[0] += 1
        if calls[0] == 1:
            raise store.StoreUnavailable()
        return saved_state(asset_id)

    monkeypatch.setattr(store, "get_raw_saved_state", fail_pre_save_read)
    result = asyncio.run(mutate_raw_edits(scheduler, ASSET, save))
    assert result["revision"] == 1
    assert calls[0] == 2
    assert store.get_raw_saved_state(ASSET)["revision"] == 1
    assert hub.consistency_position()[2] == 1
    assert hub.position()[1] == 1
    assert scheduler._deadlines == {ASSET: 60}
    generate.assert_not_called()


def test_unknown_eligibility_keeps_original_fallback_and_invalidates_old_cache(lifecycle):
    cache, scheduler, _, generate = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    cache.store(ASSET, b"potentially stale image")

    result = asyncio.run(mutate_raw_edits(scheduler, ASSET, save, "unknown"))

    assert result["revision"] == 1
    assert store.get_raw_saved_state(ASSET)["exportEligible"] is None
    assert hub.consistency_position()[2] == 1 and hub.position()[1] == 1
    assert scheduler.generation_state(ASSET) == "reset"
    assert cache.read(ASSET) is None
    assert not scheduler._deadlines and not scheduler._pending
    generate.assert_not_called()


def test_raw_recipe_save_failure_does_not_advance_internal_sequence(lifecycle):
    _, scheduler, _, _ = lifecycle
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub

    def fail(*_args, **_kwargs):
        raise store.StoreUnavailable()

    async def run():
        with pytest.raises(store.StoreUnavailable):
            await mutate_raw_edits(scheduler, ASSET, fail)
        assert hub.consistency_position()[2] == 0
        assert hub.position()[1] == 0

    asyncio.run(run())


def test_raw_thumbnail_state_uses_zero_only_for_an_incompatible_engine_recipe(lifecycle, monkeypatch):
    import lightcraft_artifact

    monkeypatch.setattr(lightcraft_artifact, "ENGINE_VERSION", "9.9.9")
    monkeypatch.setattr(lightcraft_artifact, "ENGINE_COMMIT", "f" * 40)
    old_identity = identity(assetId=str(ASSET), engineVersion="0.9.1", engineCommit="a" * 40)
    store.put_raw_recipe(old_identity, 0, uuid4(), settings())

    result = store.get_raw_thumbnail_recipe_states([ASSET])

    assert result[str(ASSET)] == {"recipeRevision": 0, "edited": False}


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
            if kind == "edited" and cached:
                assert response.status_code == 307 and response.headers["cache-control"] == "private, no-store"
                response = await http.get(f"/assets/{ASSET}/{endpoint}", params={"publication": cache.version(ASSET)})
            assert response.status_code == 200
            assert response.content == (b"cached" if kind == "edited" and cached else
                b"thumbnail" if endpoint == "rendered-thumbnail" else b"preview")
            assert response.headers["cache-control"] == (
                "private, no-cache" if kind == "edited" and cached else "private, no-store")
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


def test_windows_thumbnail_dispatch_ignores_asset_raw_classification(lifecycle, monkeypatch):
    _, _, _, _ = lifecycle
    monkeypatch.setattr(storage, "WINDOWS_STORAGE", True)
    monkeypatch.setattr(main, "get_asset_detail", AsyncMock(return_value=SimpleNamespace(is_raw=False)))
    rendered = AsyncMock(return_value=b"native-thumbnail")
    monkeypatch.setattr(main, "generate_thumbnail", rendered)
    result = asyncio.run(main.generate_saved_thumbnail(ASSET, immich_url=None, api_key=None))
    assert result == b"native-thumbnail"
    assert rendered.await_args.kwargs["input_kind"] == "raw"


def test_docker_thumbnail_dispatch_ignores_asset_raw_classification(lifecycle, monkeypatch):
    _, _, _, _ = lifecycle
    monkeypatch.setattr(storage, "WINDOWS_STORAGE", False)
    monkeypatch.setattr(main, "get_asset_detail", AsyncMock(return_value=SimpleNamespace(is_raw=True)))
    rendered = AsyncMock(return_value=b"jpeg-thumbnail")
    monkeypatch.setattr(main, "generate_thumbnail", rendered)
    result = asyncio.run(main.generate_saved_thumbnail(ASSET, immich_url=None, api_key=None))
    assert result == b"jpeg-thumbnail"
    assert rendered.await_args.kwargs["input_kind"] == "jpeg"


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
    hub = ThumbnailPublicationHub()
    scheduler.publication_hub = hub
    monkeypatch.setattr(cache, "delete", lambda *_: (_ for _ in ()).throw(OSError()))
    cache.store(ASSET, b"stale default-state image")
    result = asyncio.run(mutate_raw_edits(scheduler, ASSET, save, "default"))
    assert result["revision"] == 1 and store.get_raw_saved_state(ASSET)["exportEligible"] is False
    assert hub.consistency_position()[2] == 1 and hub.position()[1] == 1
    assert scheduler.generation_state(ASSET) == "reset"
    assert cache._path(ASSET).exists() and cache._is_invalidated(ASSET)


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
    monkeypatch.setattr(storage, "WINDOWS_STORAGE", False)
    raw_id, jpeg_id = UUID(int=2), ASSET
    calls = []
    async def detail(url, key, asset): return SimpleNamespace(is_raw=asset == raw_id)
    async def generate(asset, **kwargs):
        assert kwargs["input_kind"] == "jpeg"
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


@pytest.mark.parametrize('control,value,edited', [
    ('grading.shadows.sat', 0, False), ('grading.blending', 50, False), ('grading.balance', 0, False),
    ('grading.shadows.sat', 1, True), ('grading.blending', 51, True), ('grading.balance', 1, True)])
def test_grading_only_saved_state_controls_thumbnail_eligibility(lifecycle, control, value, edited):
    from raw_controls import control_location
    cache, scheduler, _, _ = lifecycle
    baseline = settings()
    current = deepcopy(baseline)
    parent, key = control_location(current, control)
    # Native numeric readback uses f64 even for integer-step controls.
    parent[key] = float(value)
    store.put_raw_recipe(identity(assetId=str(ASSET)), 0, uuid4(), current,
        import_defaults_fingerprint=store._digest(store._settings_json(baseline, 1)))
    assert store.get_raw_edit_statuses([ASSET]) == {str(ASSET): edited}
    cache.store(ASSET, b'old')
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as http:
            response = await http.post(f'/assets/{ASSET}/rendered-thumbnail')
            assert response.status_code == (202 if edited else 200)
            assert list(scheduler._pending) == ([ASSET] if edited else [])
            assert cache.read(ASSET) == (b'old' if edited else None)
    asyncio.run(run())
