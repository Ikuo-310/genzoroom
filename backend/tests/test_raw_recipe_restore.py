from lightcraft_artifact import ENGINE_VERSION
import asyncio
from contextlib import closing
import copy
import hashlib
import os
import sqlite3
import subprocess
import sys
import threading
from uuid import uuid4

import pytest

import edit_store
from lightcraft_mcp import LightCraftError, MCPTransportError
from lightcraft_raw import ENGINE_COMMIT
import raw_recipe_store as store
from tests.test_lightcraft_mcp import until
from tests.test_lightcraft_raw import DEFAULT, create
from tests.test_raw_controls import identity as document_identity
from tests.test_raw_source import Original
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, preview_body


def database_rows():
    with closing(sqlite3.connect(edit_store.DB_PATH)) as connection:
        return {table: connection.execute(f"SELECT * FROM {table}").fetchall()
                for table in ("asset_raw_recipes", "raw_recipe_saves", "asset_edit_states", "export_queue")}


def changed_settings():
    settings = copy.deepcopy(DEFAULT)
    settings["process"] = 1
    settings["wb"].update(mode="custom", temp=5700., tint=9., scale="legacy")
    settings["light"].update(exposure=1.25, shadows=12.)
    settings["color"].update(vibrance=17., saturation=-7.)
    # Geometry and curve are intentionally outside the ten C2 sliders.
    settings["geometry"]["scale"] = 115.
    settings["curve"]["master"][0]["y"] = .125
    return settings


def seed(asset_id, **identity_changes):
    identity = {"assetId": str(asset_id), "sourceContentHash": hashlib.sha256(Original().data).hexdigest(),
                "engineName": "lightcraft", "engineVersion": ENGINE_VERSION, "engineCommit": ENGINE_COMMIT,
                "settingsSchemaVersion": 1, **identity_changes}
    settings = changed_settings()
    settings["version"] = identity["settingsSchemaVersion"]
    return store.put_raw_recipe(identity, 0, uuid4(), settings)


async def open_asset(http, asset_id):
    response = await http.post("/api/raw/workspaces", json={})
    assert response.status_code == 200
    workspace = response.json()["workspaceId"]
    response = await http.post("/api/raw/documents", json={"workspaceId": workspace, "assetId": str(asset_id)})
    return workspace, response


def hold_merge(child, monkeypatch):
    entered, gate = asyncio.Event(), asyncio.Event()
    respond = child.respond
    def held(message):
        args = message.get("params", {}).get("arguments", {})
        if message["method"] == "tools/call" and args.get("id") == "develop.merge":
            entered.set()
            async def finish():
                await gate.wait()
                respond(message)
            task = asyncio.create_task(finish())
            child.deferred.add(task)
            task.add_done_callback(child.deferred.discard)
        else:
            respond(message)
    # The fake transport captured the original bound method when the child was created.
    monkeypatch.setattr(child.stdin, "respond", held)
    return entered, gate


def test_persisted_restore_follows_content_not_local_fingerprint(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "recipes.db")
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            asset_id = str(uuid4())
            handle, initial = await raw.open_raw(asset_id, files[0])
            changed = await raw.merge_settings(handle, changed_settings(), initial.revision)
            saved = store.put_raw_recipe(raw.recipe_identity(handle), 0, uuid4(), changed.settings)
            before = database_rows()
            await raw.reset_session(restore_active=False)
            files[1].write_bytes(files[0].read_bytes())
            handle, initial = await raw.open_raw(asset_id, files[1])
            assert initial._fingerprint != changed._fingerprint
            assert raw.recipe_identity(handle)["sourceContentHash"] == saved["recipe"]["sourceContentHash"]
            with pytest.raises(LightCraftError, match="raw_source_changed"):
                await raw.restore_settings(handle, changed, initial.revision)
            restored = await raw.restore_persisted_settings(handle, saved["recipe"], initial.revision)
            assert restored.revision > initial.revision
            assert restored.settings == changed.settings == (await raw.get_settings(handle)).settings
            assert children[-1].photos[1]["settings"] == changed.settings
            assert [command for command, _ in children[-1].commands][-4:-1] == ["develop.reset", "develop.merge", "develop.get"]
            frame = await raw.request_preview(handle, restored.revision)
            assert frame.revision == restored.revision
            assert database_rows() == before
        finally:
            await raw.close()
    asyncio.run(run())


def test_content_hash_case_uses_c3a_normalization(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "recipes.db")
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            child = children[0]
            respond = child.stdin.respond
            def inspect(message):
                args = message.get("params", {}).get("arguments", {})
                if message["method"] == "tools/call" and args.get("id") == "photo.inspect":
                    photo_id = args["params"]["id"]
                    return child.tool(message, {"id": photo_id, "kind": "raw", "width": 4000, "height": 3000,
                        "content_hash": child.photos[photo_id]["hash"].upper()})
                respond(message)
            monkeypatch.setattr(child.stdin, "respond", inspect)
            handle, initial = await raw.open_raw(str(uuid4()), files[0])
            identity = raw.recipe_identity(handle)
            assert identity["sourceContentHash"] == hashlib.sha256(files[0].read_bytes()).hexdigest()
            saved = store.put_raw_recipe(identity | {"sourceContentHash": identity["sourceContentHash"].upper()},
                                         0, uuid4(), changed_settings())
            restored = await raw.restore_persisted_settings(handle, saved["recipe"], initial.revision)
            assert restored.settings == changed_settings()
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("invalid", ["size", "json-type", "schema", "private-field"])
def test_persisted_payload_reuses_c3a_validation_before_native_calls(tmp_path, invalid):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw(str(uuid4()), files[0])
            recipe = raw.recipe_identity(handle) | {"settings": changed_settings()}
            if invalid == "size":
                recipe["settings"]["profile"] = {"id": "x" * store.MAX_SETTINGS_BYTES}
            elif invalid == "json-type":
                recipe["settings"] = "{}"
            elif invalid == "schema":
                recipe["settings"]["version"] = 2
            else:
                recipe["settings"]["cache_path"] = "PRIVATE"
            commands = list(children[0].commands)
            with pytest.raises(LightCraftError, match="^raw_recipe_invalid$"):
                await raw.restore_persisted_settings(handle, recipe, initial.revision)
            assert children[0].commands == commands
            assert (await raw.get_settings(handle)).settings == initial.settings
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("change,code", [
    ({"assetId": str(uuid4())}, "raw_recipe_source_mismatch"),
    ({"sourceContentHash": "b" * 16}, "raw_recipe_source_mismatch"),
    ({"engineName": "other"}, "raw_recipe_engine_incompatible"),
    ({"engineVersion": "0.10.0", "engineCommit": "a2a41383c4fd62fa85a46ccd00998639221f2d3c"}, "raw_recipe_engine_incompatible"),
    ({"engineVersion": "0.10.1"}, "raw_recipe_engine_incompatible"),
    ({"engineCommit": "b" * 40}, "raw_recipe_engine_incompatible"),
    ({"settingsSchemaVersion": 2}, "raw_recipe_engine_incompatible"),
])
def test_native_restore_rechecks_identity_before_sending(tmp_path, monkeypatch, change, code):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "recipes.db")
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw(str(uuid4()), files[0])
            identity = raw.recipe_identity(handle) | change
            settings = changed_settings()
            settings["version"] = identity["settingsSchemaVersion"]
            recipe = store.put_raw_recipe(identity, 0, uuid4(), settings)["recipe"]
            before, commands = database_rows(), list(children[0].commands)
            with pytest.raises(LightCraftError, match=f"^{code}$"):
                await raw.restore_persisted_settings(handle, recipe, initial.revision)
            assert children[0].commands == commands
            assert (await raw.get_settings(handle)).revision == initial.revision
            assert database_rows() == before
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("failure,code", [("apply", "raw_recipe_restore_failed"),
    ("mismatch", "raw_recipe_restore_mismatch"), ("readback", "raw_recipe_restore_failed"),
    ("unknown", "raw_recipe_restore_unknown")])
def test_native_restore_failure_never_confirms_settings(tmp_path, monkeypatch, failure, code):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "recipes.db")
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw(str(uuid4()), files[0])
            saved = store.put_raw_recipe(raw.recipe_identity(handle), 0, uuid4(), changed_settings())
            before = database_rows()
            child = children[0]
            command = manager._raw_command
            async def failing(generation, name, params, **kwargs):
                if name == "develop.merge":
                    if failure == "apply":
                        raise LightCraftError("lightcraft_tool_error")
                    actual = await command(generation, name, params, **kwargs)
                    if failure == "unknown":
                        raise MCPTransportError("lightcraft_request_timeout")
                    if failure == "readback":
                        child.fail_get = True
                    return actual
                return await command(generation, name, params, **kwargs)
            monkeypatch.setattr(manager, "_raw_command", failing)
            child.mismatch = failure == "mismatch"
            with pytest.raises(LightCraftError, match=f"^{code}$"):
                await raw.restore_persisted_settings(handle, saved["recipe"], initial.revision)
            photo = raw._photos[handle.source_key]
            assert photo.applied_revision == initial.revision and photo.settings_json == initial._json
            assert raw.status().state in {"desynchronized", "lost"}
            with pytest.raises(LightCraftError):
                raw.request_preview(handle, initial.revision)
            assert child.render_count == 0 and database_rows() == before
        finally:
            await raw.close()
    asyncio.run(run())


def test_selection_change_during_restore_prevents_old_commit(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "recipes.db")
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, _ = await raw.open_raw(str(uuid4()), files[0])
            other, _ = await raw.open_raw(str(uuid4()), files[1])
            initial = await raw.select(handle)
            saved = store.put_raw_recipe(raw.recipe_identity(handle), 0, uuid4(), changed_settings())
            entered, gate = hold_merge(children[0], monkeypatch)
            restoring = asyncio.create_task(raw.restore_persisted_settings(handle, saved["recipe"], initial.revision))
            await entered.wait()
            epoch = raw.status().selection_epoch
            selecting = asyncio.create_task(raw.select(other))
            await until(lambda: raw.status().selection_epoch > epoch)
            gate.set()
            with pytest.raises(LightCraftError, match="raw_stale_handle"):
                await restoring
            await selecting
            assert raw._photos[handle.source_key].applied_revision == initial.revision
            assert (await raw.get_settings(other)).settings == DEFAULT
        finally:
            await raw.close()
    asyncio.run(asyncio.wait_for(run(), 10))


def test_old_generation_recipe_restore_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "recipes.db")
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw(str(uuid4()), files[0])
            saved = store.put_raw_recipe(raw.recipe_identity(handle), 0, uuid4(), changed_settings())
            await raw.reset_session(restore_active=False)
            await raw.open_raw(str(uuid4()), files[1])
            commands = list(children[-1].commands)
            with pytest.raises(LightCraftError, match="raw_stale_handle"):
                await raw.restore_persisted_settings(handle, saved["recipe"], initial.revision)
            assert children[-1].commands == commands
        finally:
            await raw.close()
    asyncio.run(run())


def test_windows_restores_before_publish_and_preview_then_preserves_c2(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            asset_id = uuid4()
            saved = seed(asset_id)
            before = database_rows()
            entered, gate = hold_merge(children[0], monkeypatch)
            async with client(local) as http:
                await authenticate(http, local)
                opening = asyncio.create_task(open_asset(http, asset_id))
                await entered.wait()
                assert api.document is None and children[0].render_count == 0
                gate.set()
                workspace, response = await opening
                assert response.status_code == 200, response.text
                doc = response.json()
                assert doc["recipeStatus"] == "restored" and doc["recipeRevision"] == 1
                assert doc["revision"] > 1
                assert not set(saved["recipe"]) & set(doc) - {"assetId"}
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=document_identity(doc))
                assert response.json()["values"]["light.exposure"] == 1.25
                assert response.json()["process"] == 1 and response.json()["wb"]["scale"] == "legacy"
                assert children[0].photos[1]["settings"] == saved["recipe"]["settings"]
                preview = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc))
                assert preview.status_code == 200
                assert int(preview.headers["x-raw-revision"]) == doc["revision"]
                changed = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                    json=document_identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": 2.}})
                assert changed.status_code == 200 and changed.json()["values"]["light.exposure"] == 2.
                assert database_rows() == before  # C3-B never saves C2 mutations.
                assert (await http.delete(f"/api/raw/workspaces/{workspace}")).status_code == 204
                _, reopened = await open_asset(http, asset_id)
                assert reopened.status_code == 200 and reopened.json()["recipeStatus"] == "restored"
                assert children[-1].photos[1]["settings"] == saved["recipe"]["settings"]
                assert database_rows() == before
        finally:
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 15))


def test_no_recipe_for_current_asset_opens_initial_settings(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            seed(uuid4())
            before = database_rows()
            async with client(local) as http:
                await authenticate(http, local)
                _, response = await open_asset(http, uuid4())
                assert response.status_code == 200
                doc = response.json()
                assert doc["recipeStatus"] == "none" and doc["recipeRevision"] == 0
                assert children[0].photos[1]["settings"] == DEFAULT
                assert not any(name == "develop.merge" for name, _ in children[0].commands)
                assert database_rows() == before
        finally:
            await api.close()
    asyncio.run(run())


def test_legacy_scale_omission_is_not_converted_to_kelvin(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            asset_id = uuid4()
            saved = seed(asset_id)
            identity = {key: saved["recipe"][key] for key in store.IDENTITY_FIELDS}
            settings = copy.deepcopy(saved["recipe"]["settings"])
            del settings["wb"]["scale"]
            store.put_raw_recipe(identity, 1, uuid4(), settings)
            before = database_rows()
            async with client(local) as http:
                await authenticate(http, local)
                _, response = await open_asset(http, asset_id)
                assert response.status_code == 200 and response.json()["recipeStatus"] == "restored"
                assert children[0].photos[1]["settings"]["wb"]["scale"] == "legacy"
                assert database_rows() == before
        finally:
            await api.close()
    asyncio.run(run())


def test_generation_change_during_sqlite_lookup_never_publishes_old_import(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, root = await setup(tmp_path, local, monkeypatch)
        entered, gate = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()
        lookup = store.lookup_raw_recipe
        def delayed(identity):
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            return lookup(identity)
        monkeypatch.setattr(store, "lookup_raw_recipe", delayed)
        try:
            asset_id = uuid4()
            seed(asset_id)
            before = database_rows()
            async with client(local) as http:
                await authenticate(http, local)
                opening = asyncio.create_task(open_asset(http, asset_id))
                await entered.wait()
                await manager.restart()
                await until(lambda: manager.status().state == "ready")
                gate.set()
                assert (await opening)[1].status_code != 200
                assert api.document is None and not list(root.iterdir())
                assert children[0].render_count == 0 and database_rows() == before
        finally:
            gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


@pytest.mark.parametrize("change,code", [
    ({"sourceContentHash": "b" * 16}, "raw_recipe_source_mismatch"),
    ({"engineName": "other"}, "raw_recipe_engine_incompatible"),
    ({"engineVersion": "0.10.0", "engineCommit": "a2a41383c4fd62fa85a46ccd00998639221f2d3c"}, "raw_recipe_engine_incompatible"),
    ({"engineVersion": "0.10.1"}, "raw_recipe_engine_incompatible"),
    ({"engineCommit": "b" * 40}, "raw_recipe_engine_incompatible"),
    ({"settingsSchemaVersion": 2}, "raw_recipe_engine_incompatible"),
])
def test_windows_incompatible_recipe_fails_open_and_keeps_db(local, tmp_path, monkeypatch, change, code):
    async def run():
        api, _, children, root = await setup(tmp_path, local, monkeypatch)
        try:
            asset_id = uuid4()
            seed(asset_id, **change)
            before = database_rows()
            async with client(local) as http:
                await authenticate(http, local)
                _, response = await open_asset(http, asset_id)
                assert response.status_code == 409 and response.json() == {"code": code}
                assert api.document is None and not list(root.iterdir())
                assert children[0].render_count == 0
                assert not any(name == "develop.merge" for name, _ in children[0].commands)
                assert database_rows() == before
                assert (await http.get("/api/health")).status_code == 200
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("failure,code,status", [("apply", "raw_recipe_restore_failed", 502),
    ("mismatch", "raw_recipe_restore_mismatch", 502), ("unknown", "raw_recipe_restore_unknown", 502),
    ("corrupt", "raw_recipe_unavailable", 503), ("database", "raw_recipe_unavailable", 503)])
def test_windows_restore_failure_never_publishes_default(local, tmp_path, monkeypatch, failure, code, status):
    async def run():
        api, manager, children, root = await setup(tmp_path, local, monkeypatch)
        try:
            asset_id = uuid4()
            seed(asset_id)
            if failure == "corrupt":
                with closing(sqlite3.connect(edit_store.DB_PATH)) as connection:
                    connection.execute("UPDATE asset_raw_recipes SET develop_settings_json='PRIVATE broken JSON'")
                    connection.commit()
            if failure == "database":
                monkeypatch.setattr(store, "lookup_raw_recipe", lambda _: (_ for _ in ()).throw(store.StoreUnavailable()))
            before = database_rows()
            command = manager._raw_command
            async def failing(generation, name, params, **kwargs):
                if name == "develop.merge" and failure in {"apply", "unknown"}:
                    raise (LightCraftError("lightcraft_tool_error") if failure == "apply" else
                           MCPTransportError("lightcraft_request_timeout"))
                return await command(generation, name, params, **kwargs)
            monkeypatch.setattr(manager, "_raw_command", failing)
            children[0].mismatch = failure == "mismatch"
            async with client(local) as http:
                await authenticate(http, local)
                _, response = await open_asset(http, asset_id)
                assert response.status_code == status and response.json() == {"code": code}
                assert "PRIVATE" not in response.text
                assert api.document is None and not list(root.iterdir()) and children[0].render_count == 0
                assert database_rows() == before
                assert (await http.get("/api/health")).status_code == 200
        finally:
            await api.close()
    asyncio.run(run())


def test_cancelled_restore_http_waiter_keeps_native_owner(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, root = await setup(tmp_path, local, monkeypatch)
        try:
            asset_id = uuid4()
            seed(asset_id)
            entered, gate = hold_merge(children[0], monkeypatch)
            async with client(local) as http:
                await authenticate(http, local)
                opening = asyncio.create_task(open_asset(http, asset_id))
                await entered.wait()
                opening.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await opening
                assert api.document is None and list(root.rglob("*.dng"))
                gate.set()
                await until(lambda: api.document is not None)
                assert api.document["recipeStatus"] == "restored"
                assert children[0].photos[1]["settings"] == changed_settings()
        finally:
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 10))


@pytest.mark.parametrize("stage", ["lookup", "restore"])
def test_shutdown_during_restore_rejects_late_document(local, tmp_path, monkeypatch, stage):
    async def run():
        api, manager, children, root = await setup(tmp_path, local, monkeypatch)
        gate = threading.Event()
        closing = None
        try:
            asset_id = uuid4()
            seed(asset_id)
            if stage == "lookup":
                entered = asyncio.Event()
                loop = asyncio.get_running_loop()
                lookup = store.lookup_raw_recipe
                def delayed(identity):
                    loop.call_soon_threadsafe(entered.set)
                    gate.wait()
                    return lookup(identity)
                monkeypatch.setattr(store, "lookup_raw_recipe", delayed)
            else:
                entered, merge_gate = hold_merge(children[0], monkeypatch)
            before = database_rows()
            async with client(local) as http:
                await authenticate(http, local)
                opening = asyncio.create_task(open_asset(http, asset_id))
                await entered.wait()
                closing = asyncio.create_task(api.close())
                await until(lambda: manager.status().state == "stopped")
                if stage == "lookup":
                    assert not closing.done() and list(root.rglob("*.dng"))
                    gate.set()
                response = (await opening)[1]
                assert response.status_code != 200
                await closing
                assert api.document is None and not list(root.iterdir()) and not api._tasks
                assert database_rows() == before
        finally:
            gate.set()
            if closing:
                await closing
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


def test_windows_import_does_not_bind_database_before_profile_selection(tmp_path):
    code = """import sys
import windows_local
assert 'edit_store' not in sys.modules and 'raw_recipe_store' not in sys.modules
import storage
storage.configure_windows_storage('unconfigured')
import raw_recipe_store, edit_store
assert edit_store.DB_PATH == storage.DB_PATH
assert 'unconfigured' in str(storage.DB_PATH)
"""
    result = subprocess.run([sys.executable, "-c", code], env={**os.environ, "LOCALAPPDATA": str(tmp_path)},
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
