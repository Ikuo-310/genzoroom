import asyncio
from contextlib import closing
import sqlite3
import threading
from uuid import uuid4

import pytest

import edit_store
import main
import raw_recipe_store as store
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_raw_recipe_restore import open_asset, database_rows
from tests.test_raw_controls import identity
from tests.test_lightcraft_mcp import until


def save_body(doc, expected=0, save_id=None):
    return identity(doc) | {"documentRevision": doc["revision"], "expectedRecipeRevision": expected,
                            "saveId": str(save_id or uuid4())}


def headers(doc):
    return {"X-Raw-Workspace": doc["workspaceId"], "X-Raw-Generation": str(doc["generation"]),
            "X-Raw-Token": doc["documentToken"]}


async def change(http, doc, exposure):
    response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
        json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": exposure}})
    assert response.status_code == 200, response.text
    return response.json()


def test_save_read_replay_after_new_native_edit_and_reopen(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                workspace, initial = await open_document(http)
                doc = await change(http, initial, 1.25)
                body = save_body(doc)
                url = f'/api/raw/documents/{doc["handle"]}/recipe'
                response = await http.put(url, json=body)
                assert response.status_code == 200, response.text
                ack = response.json()
                assert ack["documentRevision"] == doc["revision"] and ack["recipeRevision"] == 1
                assert ack["settingsFingerprint"] == doc["settingsFingerprint"]
                assert ack["saveId"] == body["saveId"] and response.headers["cache-control"] == "no-store"
                newer = await change(http, doc, 2.5)
                assert newer["settingsFingerprint"] != ack["settingsFingerprint"]
                assert (await http.put(url, json=body)).json() == ack
                saved = (await http.get(url, headers=headers(newer))).json()
                assert saved["recipeFingerprint"] == ack["settingsFingerprint"]
                assert saved["settingsFingerprint"] == newer["settingsFingerprint"]
                assert "settings" not in saved and "sourceContentHash" not in saved
                response = await http.put(url, json=save_body(newer, 1))
                assert response.status_code == 200 and response.json()["recipeRevision"] == 2
                with closing(sqlite3.connect(edit_store.DB_PATH)) as connection:
                    assert connection.execute("SELECT count(*) FROM asset_edit_states").fetchone()[0] == 0
                    assert connection.execute("SELECT count(*) FROM export_queue").fetchone()[0] == 0
                assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
                _, reopened = await open_asset(http, doc["assetId"])
                restored = reopened.json()
                assert reopened.status_code == 200 and restored["recipeStatus"] == "restored"
                settings = (await http.post(f'/api/raw/documents/{restored["handle"]}/settings', json=identity(restored))).json()
                assert settings["values"]["light.exposure"] == 2.5
                assert settings["recipeRevision"] == 2
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("field,value,code", [
    ("workspaceId", "wrong", "raw_workspace_conflict"), ("generation", 999, "raw_stale_handle"),
    ("documentToken", "wrong", "raw_stale_handle"), ("documentRevision", 999, "raw_revision_conflict"),
    ("settings", {}, "raw_invalid_request"), ("saveId", "not-uuid", "raw_invalid_request"),
    ("expectedRecipeRevision", True, "raw_invalid_request"), ("expectedRecipeRevision", -1, "raw_invalid_request"),
])
def test_invalid_save_never_writes(local, tmp_path, monkeypatch, field, value, code):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                before = database_rows()
                response = await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc) | {field: value})
                assert response.status_code in (400, 409) and response.json() == {"code": code}
                assert database_rows() == before
        finally:
            await api.close()
    asyncio.run(run())


def test_conflict_resync_and_same_save_id_reuse(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/recipe'
                first = save_body(doc)
                assert (await http.put(url, json=first)).status_code == 200
                doc = await change(http, doc, 2.)
                assert (await http.put(url, json=first | {"documentRevision": doc["revision"]})).json() == {"code": "raw_recipe_save_id_reused"}
                stale = await http.put(url, json=save_body(doc))
                assert stale.status_code == 409 and stale.json()["code"] == "raw_recipe_revision_conflict"
                saved = (await http.get(url, headers=headers(doc))).json()
                assert saved["recipeRevision"] == 1
                assert (await http.put(url, json=save_body(doc, saved["recipeRevision"]))).status_code == 200
        finally:
            await api.close()
    asyncio.run(run())


def test_save_failure_keeps_snapshot_for_exact_retry(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await change(http, doc, 1.)
                url, body = f'/api/raw/documents/{doc["handle"]}/recipe', save_body(doc)
                before = database_rows()
                with monkeypatch.context() as patch:
                    def fail(*_): raise store.StoreUnavailable()
                    patch.setattr(store, "put_raw_recipe", fail)
                    failed = await http.put(url, json=body)
                    assert failed.status_code == 503 and failed.json()["code"] == "raw_recipe_save_failed"
                assert database_rows() == before
                await change(http, doc, 3.)
                assert (await http.put(url, json=body)).status_code == 200
                saved = store.get_raw_recipe(api._recipe_save["identity"])
                assert saved["recipe"]["settings"]["light"]["exposure"] == 1.
        finally:
            await api.close()
    asyncio.run(run())


def test_disconnected_save_waiter_keeps_owned_write_and_replays_ack(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        entered, gate = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()
        put = store.put_raw_recipe
        def delayed(*args):
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            return put(*args)
        monkeypatch.setattr(store, "put_raw_recipe", delayed)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                body, url = save_body(doc), f'/api/raw/documents/{doc["handle"]}/recipe'
                saving = asyncio.create_task(http.put(url, json=body))
                await entered.wait()
                saving.cancel()
                with pytest.raises(asyncio.CancelledError): await saving
                gate.set()
                await until(lambda: not api._tasks)
                ack = await http.put(url, json=body)
                assert ack.status_code == 200 and ack.json()["recipeRevision"] == 1
                assert len(database_rows()["raw_recipe_saves"]) == 1
        finally:
            gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


def test_recipe_get_auth_identity_and_no_native_commands(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                assert (await http.put('/api/raw/documents/x/recipe', json={})).status_code == 401
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/recipe'
                for change in ({"Origin": "http://evil.example"}, {"Host": "evil.example"}):
                    assert (await http.put(url, json=save_body(doc), headers=change)).status_code == 403
                commands = list(children[0].commands)
                assert (await http.get(url, headers=headers(doc))).status_code == 200
                assert (await http.get(url, headers=headers(doc) | {"X-Raw-Token": "wrong"})).status_code == 409
                assert children[0].commands == commands
        finally:
            await api.close()
    asyncio.run(run())


def test_shutdown_during_save_reports_unknown_not_a_successful_stale_document(local, tmp_path, monkeypatch):
    async def run():
        api, manager, _, root = await setup(tmp_path, local, monkeypatch)
        entered, gate = asyncio.Event(), threading.Event()
        loop, put = asyncio.get_running_loop(), store.put_raw_recipe
        def delayed(*args):
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            return put(*args)
        monkeypatch.setattr(store, "put_raw_recipe", delayed)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                saving = asyncio.create_task(http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc)))
                await entered.wait()
                closing = asyncio.create_task(api.close())
                await until(lambda: manager.status().state == "stopped")
                assert not closing.done()
                gate.set()
                result = await saving
                assert result.status_code == 502 and result.json()["code"] == "raw_recipe_save_unknown"
                await closing
                assert api.document is None and not list(root.iterdir()) and not api._tasks
                assert len(database_rows()["asset_raw_recipes"]) == 1
        finally:
            gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


def test_readback_revision_change_is_not_silently_saved(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                children[0].photos[1]["settings"]["light"]["exposure"] = .9
                url = f'/api/raw/documents/{doc["handle"]}/recipe'
                assert (await http.put(url, json=save_body(doc))).json()["code"] == "raw_revision_conflict"
                assert database_rows()["asset_raw_recipes"] == []
                confirmed = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                assert (await http.put(url, json=save_body(confirmed))).status_code == 200
                saved = store.get_raw_recipe(api._recipe_save["identity"])
                assert saved["recipe"]["settings"]["light"]["exposure"] == .9
        finally:
            await api.close()
    asyncio.run(run())


def test_new_backend_host_restores_the_sqlite_recipe_after_restart(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await change(http, doc, 1.75)
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc))).status_code == 200
            await api.close()
            restarted = type(local)(main.app, dist=tmp_path / "dist")
            folder = tmp_path / "restart"
            folder.mkdir()
            restored_api, _, children, _ = await setup(folder, restarted, monkeypatch)
            try:
                async with client(restarted) as http:
                    await authenticate(http, restarted)
                    _, response = await open_asset(http, doc["assetId"])
                    assert response.status_code == 200 and response.json()["recipeStatus"] == "restored"
                    assert children[0].photos[1]["settings"]["light"]["exposure"] == 1.75
            finally:
                await restored_api.close()
        finally:
            await api.close()
    asyncio.run(run())
