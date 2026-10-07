import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import threading
from unittest.mock import patch
from uuid import UUID, uuid4
import weakref

from PIL import Image
import pytest

import edit_store
from edit_store import StoreUnavailable, enqueue_export_assets, list_export_queue, put_edit_state
from export_runtime import ExportRuntime, ImmichExportSource, RegistrationResult, _artifact
from export_runtime_store import (
    RuntimeRejected, claim_export_run, complete_export_item, create_export_run, fail_export_item,
    get_export_run, recoverable_export_run, transition_export_item,
)
from main import app
from tests.test_export_queue import A, B, C, database, db, request, save, snapshot


def queued(*ids):
    for asset_id in ids:
        save(asset_id)
    enqueue_export_assets(list(ids))


def make_v2(path):
    state = snapshot()
    with database(path) as connection:
        connection.execute(edit_store.SCHEMA)
        edit_store._create_v2(connection)
        connection.execute("PRAGMA user_version=2")
        connection.execute("INSERT INTO asset_edit_states VALUES (?, 2, 18, ?, ?, '[]', 0, ?, 7, ?, ?)",
                           (str(A), state["processingVersion"], json.dumps(state["currentRecipe"]),
                            json.dumps(state["sourceIdentity"]), "2026-10-07T00:00:00.000Z", str(uuid4())))
        connection.execute("INSERT INTO export_queue VALUES (42, ?, 'queued', ?, ?)",
                           (str(A), "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z"))


def test_v2_to_v3_preserves_all_edit_and_queue_columns_and_reopen_is_idempotent(db):
    make_v2(db)
    with database(db) as connection:
        edit_before = connection.execute("SELECT * FROM asset_edit_states").fetchall()
        queue_before = connection.execute("SELECT * FROM export_queue").fetchall()
    assert recoverable_export_run() is None
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == edit_store.SCHEMA_VERSION
        assert connection.execute("SELECT * FROM asset_edit_states").fetchall() == edit_before
        assert connection.execute("SELECT * FROM export_queue").fetchall() == queue_before
    with patch("edit_store._migrate", side_effect=AssertionError("must not migrate again")):
        assert recoverable_export_run() is None
        assert edit_store.get_edit_state(A)["revision"] == 7


def test_v3_migration_failure_rolls_back_tables_indexes_version_and_data(db):
    make_v2(db)
    with database(db) as connection:
        connection.execute("CREATE TABLE export_run_items (marker TEXT)")
        connection.execute("INSERT INTO export_run_items VALUES ('keep')")
        before = connection.execute("SELECT * FROM export_queue").fetchall()
    with pytest.raises(StoreUnavailable):
        recoverable_export_run()
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute("SELECT * FROM export_queue").fetchall() == before
        assert connection.execute("SELECT * FROM export_run_items").fetchall() == [("keep",)]
        assert not connection.execute("SELECT name FROM sqlite_master WHERE name IN ('export_runs','export_one_active_run')").fetchall()


def test_future_schema_refusal(db):
    with database(db) as connection:
        connection.execute("PRAGMA user_version=99")
    with pytest.raises(edit_store.UnsupportedSchema):
        recoverable_export_run()
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 99


def test_creation_freezes_explicit_order_recipe_revision_and_leaves_non_targets_untouched(db):
    queued(A, B, C)
    before = list_export_queue()
    run = create_export_run([B, A])
    assert [item.asset_id for item in run.items] == [B, A]
    assert all(item.status == "waiting" and item.frozen_revision == 1 for item in run.items)
    items = list_export_queue()
    assert [item["assetId"] for item in items] == [str(A), str(B), str(C)]
    assert [item["queuedAt"] for item in items] == [item["queuedAt"] for item in before]
    assert items[2] == before[2]
    changed = snapshot(B)
    changed["currentRecipe"]["adjustments"]["temperature"] = 99
    put_edit_state(B, 1, uuid4(), changed)
    with database(db) as connection:
        connection.execute("DELETE FROM asset_edit_states WHERE asset_id=?", (str(A),))
        columns = [row[1] for row in connection.execute("PRAGMA table_info(export_run_items)")]
        assert "history_json" not in columns and not any("jpeg" in column or "binary" in column for column in columns)
    assert get_export_run(run.run_id).items[0].recipe["adjustments"]["temperature"] == 12
    assert get_export_run(run.run_id).items[1].frozen_revision == 1
    run.items[0].recipe["adjustments"]["temperature"] = -99
    assert get_export_run(run.run_id).items[0].recipe["adjustments"]["temperature"] == 12
    assert get_export_run(run.run_id).worker_id is None


@pytest.mark.parametrize("problem,code", [("duplicate", "duplicate_asset_ids"), ("missing_queue", "queue_item_missing"),
    ("missing_saved", "saved_recipe_missing"), ("default", "asset_not_eligible"),
    ("malformed", "persistence_unavailable"), ("failed", "queue_item_not_queued"),
    ("waiting", "queue_item_not_queued"), ("encoding", "queue_item_not_queued"), ("registering", "queue_item_not_queued")])
def test_creation_is_all_or_nothing_for_invalid_second_target(db, problem, code):
    queued(A, B)
    with database(db) as connection:
        if problem == "missing_queue":
            connection.execute("DELETE FROM export_queue WHERE asset_id=?", (str(B),))
        elif problem == "missing_saved":
            connection.execute("DELETE FROM asset_edit_states WHERE asset_id=?", (str(B),))
        elif problem in ("default", "malformed"):
            value = json.dumps(snapshot(B, False)["currentRecipe"]) if problem == "default" else '{"private":"broken"}'
            connection.execute("UPDATE asset_edit_states SET current_recipe_json=? WHERE asset_id=?", (value, str(B)))
        elif problem in ("failed", "waiting", "encoding", "registering"):
            connection.execute("UPDATE export_queue SET status=? WHERE asset_id=?", (problem, str(B)))
        before = connection.execute("SELECT * FROM export_queue ORDER BY id").fetchall()
    with pytest.raises((RuntimeRejected, StoreUnavailable)) as error:
        create_export_run([A, A] if problem == "duplicate" else [A, B])
    assert error.value.code == code
    with database(db) as connection:
        assert connection.execute("SELECT * FROM export_queue ORDER BY id").fetchall() == before
        assert connection.execute("SELECT count(*) FROM export_runs").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM export_run_items").fetchone()[0] == 0


@pytest.mark.parametrize("ids", [[], ["not-a-uuid"], [UUID(int=n) for n in range(101)]])
def test_run_ids_follow_queue_limits_and_uuid_types(db, ids):
    with pytest.raises(RuntimeRejected):
        create_export_run(ids)


def test_sql_failure_during_start_rolls_back_all_targets(db):
    queued(A, B)
    with database(db) as connection:
        before = connection.execute("SELECT * FROM export_queue").fetchall()
        connection.execute("""CREATE TRIGGER reject_second_snapshot BEFORE INSERT ON export_run_items
            WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT, 'stop'); END""")
    with pytest.raises(StoreUnavailable):
        create_export_run([A, B])
    with database(db) as connection:
        assert connection.execute("SELECT * FROM export_queue").fetchall() == before
        assert connection.execute("SELECT count(*) FROM export_runs").fetchone()[0] == 0


def test_silently_ignored_snapshot_insert_cannot_create_partial_run(db):
    queued(A, B)
    with database(db) as connection:
        before = connection.execute("SELECT * FROM export_queue").fetchall()
        connection.execute("""CREATE TRIGGER ignore_snapshot BEFORE INSERT ON export_run_items
            WHEN NEW.position=1 BEGIN SELECT RAISE(IGNORE); END""")
    with pytest.raises(StoreUnavailable):
        create_export_run([A, B])
    with database(db) as connection:
        assert connection.execute("SELECT * FROM export_queue").fetchall() == before
        assert connection.execute("SELECT count(*) FROM export_runs").fetchone()[0] == 0


@pytest.mark.parametrize("target", ["encoding", "succeeded"])
def test_zero_row_transition_or_success_removal_rolls_back_item_and_queue(db, target):
    queued(A)
    run, owner = owned_run(A)
    if target == "succeeded":
        advance(run, owner, A, "encoding")
        advance(run, owner, A, "registering")
    before = get_export_run(run.run_id)
    with database(db) as connection:
        operation = "DELETE ON export_queue" if target == "succeeded" else "UPDATE ON export_run_items"
        connection.execute(f"CREATE TRIGGER ignore_transition BEFORE {operation} BEGIN SELECT RAISE(IGNORE); END")
    with pytest.raises(StoreUnavailable):
        if target == "succeeded":
            complete_export_item(run.run_id, A, owner, uuid4())
        else:
            advance(run, owner, A, target)
    assert get_export_run(run.run_id) == before


def owned_run(*ids):
    owner = uuid4()
    return create_export_run(list(ids), worker_id=owner), owner


def advance(run, owner, asset_id, target):
    expected = "waiting" if target == "encoding" else "encoding"
    transition_export_item(run.run_id, asset_id, owner, expected, target)


def test_transitions_validate_order_owner_status_and_success_removal(db):
    queued(A, B)
    run, owner = owned_run(A, B)
    for args in ((A, uuid4(), "waiting", "encoding"), (B, owner, "waiting", "encoding"),
                 (A, owner, "waiting", "registering"), (A, owner, "queued", "waiting"),
                 (A, None, "waiting", "encoding")):
        with pytest.raises(RuntimeRejected):
            transition_export_item(run.run_id, *args)
    with pytest.raises(RuntimeRejected):
        complete_export_item(run.run_id, A, owner, uuid4())
    advance(run, owner, A, "encoding")
    with pytest.raises((RuntimeRejected, StoreUnavailable)):
        advance(run, owner, A, "encoding")
    advance(run, owner, A, "registering")
    exported = uuid4()
    complete_export_item(run.run_id, A, owner, exported)
    assert get_export_run(run.run_id).items[0].registered_asset_id == exported
    assert [item["assetId"] for item in list_export_queue()] == [str(B)]
    with pytest.raises(RuntimeRejected):
        complete_export_item(run.run_id, A, owner, uuid4())
    advance(run, owner, B, "encoding")
    advance(run, owner, B, "registering")
    complete_export_item(run.run_id, B, owner, uuid4())
    assert get_export_run(run.run_id).status == "completed"
    assert list_export_queue() == [] and recoverable_export_run() is None


@pytest.mark.parametrize("status", ["waiting", "encoding", "registering"])
def test_failure_and_default_save_lock_interaction(db, status):
    queued(A, B)
    run, owner = owned_run(A)
    if status in ("encoding", "registering"):
        advance(run, owner, A, "encoding")
    if status == "registering":
        advance(run, owner, A, "registering")
    save(A, edited=False, revision=1)
    save(B, edited=False, revision=1)
    assert list_export_queue()[0]["status"] == status and len(list_export_queue()) == 1
    assert get_export_run(run.run_id).items[0].recipe["adjustments"]["temperature"] == 12
    with pytest.raises(edit_store.QueueRejected):
        edit_store.dequeue_export_asset(A)
    with pytest.raises(RuntimeRejected):
        fail_export_item(run.run_id, A, owner, status, "raw private exception text")
    fail_export_item(run.run_id, A, owner, status, "encoding_failed")
    assert list_export_queue()[0]["status"] == "failed"
    assert get_export_run(run.run_id).status == "failed"


def test_claim_and_queue_row_identity_block_stale_ownership(db):
    queued(A)
    run = create_export_run([A])
    owner = uuid4()
    claim_export_run(run.run_id, owner)
    with pytest.raises(RuntimeRejected):
        claim_export_run(run.run_id, uuid4())
    with database(db) as connection:
        connection.execute("DELETE FROM export_queue WHERE asset_id=?", (str(A),))
        connection.execute("INSERT INTO export_queue(asset_id,status,queued_at,updated_at) VALUES (?, 'waiting', ?, ?)",
                           (str(A), run.created_at, run.created_at))
    with pytest.raises((RuntimeRejected, StoreUnavailable)):
        advance(run, owner, A, "encoding")


@pytest.mark.parametrize("status", ["waiting", "encoding", "registering"])
def test_restart_inspection_keeps_status_owner_and_frozen_snapshot(db, status):
    queued(A, B)
    run, owner = owned_run(A, B)
    if status in ("encoding", "registering"):
        advance(run, owner, A, "encoding")
    if status == "registering":
        advance(run, owner, A, "registering")
    async def restarted():
        async with app.router.lifespan_context(app):
            assert app.state.export_runtime._task is None
            with pytest.raises(RuntimeRejected) as error:
                await app.state.export_runtime.start([A])
            assert error.value.code == "runtime_not_configured"
    asyncio.run(restarted())
    persisted = recoverable_export_run()
    assert persisted.run_id == run.run_id and persisted.worker_id == owner
    assert [item.status for item in persisted.items] == [status, "waiting"]
    assert persisted.items[0].recipe == snapshot()["currentRecipe"]
    assert request("POST", "/export/runtime/start", {"assetIds": [str(A)]}).status_code == 404


def test_start_dequeue_and_default_save_races_are_atomic(db):
    for action in ("start", "dequeue", "default"):
        # Independent IDs keep each outcome observable without cleanup/reset of active runs.
        queued(A)
        barrier = threading.Barrier(2)
        def start():
            barrier.wait()
            try:
                return create_export_run([A])
            except (RuntimeRejected, StoreUnavailable) as error:
                return error
        def other():
            barrier.wait()
            try:
                if action == "start":
                    return create_export_run([A])
                if action == "dequeue":
                    return edit_store.dequeue_export_asset(A)
                return save(A, edited=False, revision=1)
            except (RuntimeRejected, edit_store.QueueRejected) as error:
                return error
        with ThreadPoolExecutor(2) as pool:
            first, second = pool.submit(start), pool.submit(other)
            results = [first.result(), second.result()]
        active = recoverable_export_run()
        if active:
            assert list_export_queue()[0]["status"] == "waiting"
            assert active.items[0].recipe["adjustments"]["temperature"] == 12
            if action == "start":
                assert sum(isinstance(result, RuntimeRejected) for result in results) == 1
            owner = uuid4()
            claim_export_run(active.run_id, owner)
            fail_export_item(active.run_id, A, owner, "waiting", "worker_failed")
            edit_store.dequeue_export_asset(A)
        else:
            assert list_export_queue() == []
        with database(db) as connection:
            connection.execute("DELETE FROM asset_edit_states WHERE asset_id=?", (str(A),))


def jpg():
    output = BytesIO()
    with Image.new("RGB", (11, 7), (180, 40, 80)) as image:
        image.save(output, "JPEG")
    return output.getvalue()


class Original:
    def __init__(self, content, broken=False):
        self.content, self.broken, self.closed = content, broken, 0

    async def chunks(self):
        yield self.content[:15]
        if self.broken:
            raise RuntimeError("private upstream body")
        yield self.content[15:]

    async def close(self):
        self.closed += 1


class Source:
    def __init__(self, *, gate=None, broken=None, invalid=None):
        self.gate, self.broken, self.invalid = gate, broken, invalid
        self.started, self.originals = [], []

    async def detail(self, asset_id):
        from immich import AssetDetail, AssetExif
        self.started.append(asset_id)
        if self.gate:
            await self.gate.wait()
        return AssetDetail(id=asset_id, filename="IMG.JPG", date="2026-10-07", preview_url="",
                           thumbnail_url="", format="JPEG", is_raw=False, exif=AssetExif())

    async def original(self, asset_id):
        original = Original(b"invalid JPEG" if self.invalid == asset_id else jpg(), self.broken == asset_id)
        self.originals.append(original)
        return original


class Family:
    def __init__(self):
        self.calls = []

    async def filenames(self, detail, context):
        self.calls.append(context.asset_id)
        return ["IMG-Genzo03.jpg"]


class Registrar:
    def __init__(self, *, gate=None, fail=None):
        self.gate, self.fail = gate, fail
        self.calls, self.artifacts = [], []

    async def register(self, source, artifact, context):
        assert recoverable_export_run().items[context.position].status == "registering"
        with Image.open(BytesIO(artifact.jpeg)) as image:
            assert image.size == (11, 7) and image.getexif()[305] == "GenzoRoom"
        assert artifact.filename == "IMG-Genzo04.jpg"
        self.calls.append(context)
        self.artifacts.append(weakref.ref(artifact))
        if self.gate:
            await self.gate.wait()
        if self.fail == context.asset_id:
            raise RuntimeError("private registrar URL and credentials")
        return RegistrationResult(uuid4())


def test_real_artifact_pipeline_is_serial_uses_frozen_recipes_and_releases_buffers(db):
    queued(A, B)
    captured, buffers = [], []
    event_loop_thread = threading.get_ident()
    real_render = __import__("jpeg_renderer").JpegRenderer.render
    def render(renderer, image, recipe):
        assert threading.get_ident() != event_loop_thread
        captured.append(copy.deepcopy(recipe))
        return real_render(renderer, image, recipe)
    def build(source, *args):
        buffers.append(source)
        return _artifact(source, *args)
    async def scenario():
        source_gate, registrar_gate = asyncio.Event(), asyncio.Event()
        source, registrar, family = Source(gate=source_gate), Registrar(gate=registrar_gate), Family()
        runtime = ExportRuntime(source=source, registrar=registrar, family=family)
        run_id = await runtime.start([B, A])
        save(B, edited=False, revision=1)
        changed = snapshot(A)
        changed["currentRecipe"]["adjustments"]["temperature"] = 99
        put_edit_state(A, 1, uuid4(), changed)
        save(C)
        enqueue_export_assets([C])
        source_gate.set()
        for _ in range(200):
            if registrar.calls:
                break
            await asyncio.sleep(0.005)
        assert len(registrar.calls) == 1 and source.started == [B]
        assert not buffers[0] and registrar.artifacts[0]() is not None
        with pytest.raises(RuntimeRejected):
            await runtime.start([C])
        registrar_gate.set()
        await runtime.wait()
        assert source.started == [B, A] and family.calls == [B, A]
        assert [context.frozen_revision for context in registrar.calls] == [1, 1]
        assert all(original.closed == 1 for original in source.originals)
        assert all(reference() is None for reference in registrar.artifacts)
        assert get_export_run(run_id).status == "completed"
        assert [item["assetId"] for item in list_export_queue()] == [str(C)]
    with patch("export_runtime.JpegRenderer.render", render), patch("export_runtime._artifact", build):
        asyncio.run(scenario())
    assert all(recipe["adjustments"]["temperature"] == 12 for recipe in captured)
    assert all(not buffer for buffer in buffers)


@pytest.mark.parametrize("failure,expected", [("stream", "source_fetch_failed"), ("codec", "invalid_jpeg"),
                                             ("registrar", "registration_failed")])
def test_item_failure_continues_other_frozen_targets_and_cleans_streams(db, failure, expected):
    queued(A, B)
    async def scenario():
        source = Source(broken=A if failure == "stream" else None, invalid=A if failure == "codec" else None)
        registrar = Registrar(fail=A if failure == "registrar" else None)
        runtime = ExportRuntime(source=source, registrar=registrar, family=Family())
        run_id = await runtime.start([A, B])
        await runtime.wait()
        run = get_export_run(run_id)
        assert run.status == "failed" and [item.status for item in run.items] == ["failed", "succeeded"]
        assert run.items[0].error_code == expected
        assert len(list_export_queue()) == 1 and list_export_queue()[0]["status"] == "failed"
        assert source.started == [A, B] and all(original.closed == 1 for original in source.originals)
        assert all(reference() is None for reference in registrar.artifacts)
    asyncio.run(scenario())


def test_request_cancellation_during_start_does_not_cancel_committed_worker(db):
    queued(A)
    entered, release = threading.Event(), threading.Event()
    real_create = create_export_run
    def delayed_create(*args, **kwargs):
        entered.set()
        release.wait(3)
        return real_create(*args, **kwargs)
    async def scenario():
        runtime = ExportRuntime(source=Source(), registrar=Registrar(), family=Family())
        caller = asyncio.create_task(runtime.start([A]))
        for _ in range(200):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        release.set()
        await runtime.wait()
        assert list_export_queue() == [] and recoverable_export_run() is None
    with patch("export_runtime.create_export_run", delayed_create):
        asyncio.run(scenario())


def test_coordinator_instances_cannot_start_two_workers(db):
    queued(A, B)
    async def scenario():
        gate = asyncio.Event()
        source = Source(gate=gate)
        first = ExportRuntime(source=source, registrar=Registrar(), family=Family())
        second = ExportRuntime(source=source, registrar=Registrar(), family=Family())
        results = await asyncio.gather(first.start([A]), second.start([B]), return_exceptions=True)
        assert sum(isinstance(result, UUID) for result in results) == 1
        assert sum(isinstance(result, RuntimeRejected) for result in results) == 1
        assert len(source.started) == 1
        gate.set()
        await asyncio.gather(first.wait(), second.wait())
    asyncio.run(scenario())


def test_worker_exception_is_caught_without_destroying_recovery_snapshot(db):
    queued(A)
    async def scenario():
        runtime = ExportRuntime(source=Source(), registrar=Registrar(), family=Family())
        with patch.object(runtime, "_process_item", side_effect=RuntimeError("private filesystem path")):
            run_id = await runtime.start([A])
            await runtime.wait()
        assert runtime._task.exception() is None
        assert get_export_run(run_id).items[0].status == "waiting"
    asyncio.run(scenario())


def test_unconfigured_runtime_rejects_before_queue_mutation_and_has_no_production_start(db):
    queued(A)
    before = list_export_queue()
    async def scenario():
        for runtime in (ExportRuntime(), ExportRuntime(source=Source(), family=Family()),
                        ExportRuntime(source=Source(), registrar=Registrar())):
            with pytest.raises(RuntimeRejected) as error:
                await runtime.start([A])
            assert error.value.code == "runtime_not_configured" and runtime._task is None
    asyncio.run(scenario())
    assert list_export_queue() == before and recoverable_export_run() is None


def test_noop_registrar_cannot_manufacture_success(db):
    queued(A)
    class Noop:
        async def register(self, *args):
            return None
    async def scenario():
        runtime = ExportRuntime(source=Source(), registrar=Noop(), family=Family())
        run_id = await runtime.start([A])
        await runtime.wait()
        assert get_export_run(run_id).items[0].error_code == "invalid_registration_result"
        assert list_export_queue()[0]["status"] == "failed"
    asyncio.run(scenario())


def test_logs_have_only_allowlisted_metadata_and_logger_failure_does_not_change_success(db):
    queued(A)
    async def run():
        runtime = ExportRuntime(source=Source(), registrar=Registrar(), family=Family())
        await runtime.start([A])
        await runtime.wait()
    with patch("export_runtime_store.backend_logger.add") as log:
        asyncio.run(run())
        allowed = {"runId", "assetId", "targetCount", "activeCount", "position", "frozenRevision", "sourceBytes",
                   "artifactBytes", "status", "fromStatus", "errorCode"}
        assert all(set(call.kwargs.get("context", {})) <= allowed for call in log.call_args_list)
    edit_store.put_edit_state(A, 1, uuid4(), snapshot())
    enqueue_export_assets([A])
    with patch("export_runtime_store.backend_logger.add", side_effect=RuntimeError("logger failure")):
        asyncio.run(run())
    assert list_export_queue() == []


@pytest.mark.parametrize("broken", [False, True])
def test_immich_source_adapter_closes_actual_httpx_stream_and_client(db, broken):
    import httpx
    queued(A)
    class Stream(httpx.AsyncByteStream):
        closed = False
        async def __aiter__(self):
            yield jpg()[:20]
            if broken:
                raise httpx.ReadTimeout("private upstream detail")
            yield jpg()[20:]
        async def aclose(self):
            self.closed = True
    stream, clients = Stream(), []
    def response(request):
        if request.url.path == f"/api/assets/{A}":
            return httpx.Response(200, json={"type": "IMAGE", "originalFileName": "IMG.JPG", "fileCreatedAt": "2026-10-07"})
        assert request.url.path == f"/api/assets/{A}/original"
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, stream=stream)
    source = ImmichExportSource("http://immich", "secret", transport=httpx.MockTransport(response))
    original_method = source.original
    async def original(asset_id):
        result = await original_method(asset_id)
        clients.append(result.client)
        return result
    source.original = original
    async def scenario():
        runtime = ExportRuntime(source=source, family=Family(), registrar=Registrar())
        run_id = await runtime.start([A])
        await runtime.wait()
        assert get_export_run(run_id).status == ("failed" if broken else "completed")
    asyncio.run(scenario())
    assert stream.closed and all(client.is_closed for client in clients)


@pytest.mark.parametrize("boundary", ["family", "registrar"])
def test_external_boundary_rejection_fails_item_instead_of_interrupting_worker(db, boundary):
    queued(A, B)
    class RejectingFamily(Family):
        async def filenames(self, detail, context):
            if context.asset_id == A:
                raise RuntimeRejected("provider_private_detail")
            return await super().filenames(detail, context)
    class RejectingRegistrar(Registrar):
        async def register(self, source, artifact, context):
            if context.asset_id == A:
                raise RuntimeRejected("registrar_private_detail")
            return await super().register(source, artifact, context)
    async def scenario():
        runtime = ExportRuntime(source=Source(), family=RejectingFamily() if boundary == "family" else Family(),
                                registrar=RejectingRegistrar() if boundary == "registrar" else Registrar())
        run_id = await runtime.start([A, B])
        await runtime.wait()
        run = get_export_run(run_id)
        assert [item.status for item in run.items] == ["failed", "succeeded"]
        assert run.items[0].error_code == ("family_context_failed" if boundary == "family" else "registration_failed")
    asyncio.run(scenario())
