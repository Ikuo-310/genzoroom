import asyncio
import copy
import io
import json
import sqlite3
import threading
from contextlib import closing
from uuid import uuid4

import pytest
from PIL import Image

import edit_store
import main
import raw_recipe_store as store
from lightcraft_mcp import LightCraftError
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_raw_recipe_api import change, save_body, headers
from tests.test_raw_recipe_restore import open_asset
from tests.test_raw_recipe_restore import hold_merge, seed
from tests.test_raw_controls import identity
from tests.test_lightcraft_mcp import until
from tests import test_lightcraft_raw as fake_native
from tests.test_windows_raw_api import preview_body
from windows_local import LocalHost


def url(doc, action=None):
    return f'/api/raw/documents/{doc["handle"]}/history' + (f'/{action}' if action else '')


def body(doc, revision=None, save_id=None):
    return identity(doc) | {"documentRevision": doc["revision"], "settingsFingerprint": doc["settingsFingerprint"],
        "expectedRecipeRevision": doc["recipeRevision"] if revision is None else revision, "saveId": str(save_id or uuid4())}


def commit_body(doc, revision=None, save_id=None):
    return body(doc, revision, save_id) | {"kind": "control", "metadata": {"control": "light.exposure"}}


async def operation(http, doc, action, request=None):
    response = await http.post(url(doc, action), json=body(doc) if request is None else request)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert len(response.content) <= 4096
    return response.json()


async def recover(http, api, doc):
    current = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
    state = (await http.get(url(doc), headers=headers(doc))).json()
    request = body(current, state["recipeRevision"])
    request.pop("saveId")
    return await operation(http, current, "recover", request)


def rows():
    with closing(sqlite3.connect(edit_store.DB_PATH)) as connection:
        return {table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in (
            "asset_raw_recipes", "raw_recipe_saves", "asset_raw_histories", "asset_raw_history_steps", "raw_history_saves")}


def test_metadata_is_lazy_bounded_and_does_not_expose_settings(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                before, commands = rows(), list(children[0].commands)
                response = await http.get(url(doc), headers=headers(doc))
                assert response.status_code == 200 and len(response.content) <= 16384
                result = response.json()
                assert result["history"] == {"initialized": False, "cursor": 0, "length": 0, "selectedStepId": None}
                assert result["steps"] == [] and rows() == before and commands == children[0].commands
                serialized = json.dumps(result)
                for forbidden in ("sourceContentHash", "photo_id", "settings_json", "baselineSettings", "C:/", "geometry"):
                    assert forbidden not in serialized
                doc = await change(http, doc, 1.)
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc))).status_code == 200
                response = await http.get(url(doc), headers=headers(doc))
                assert response.json()["recipeRevision"] == 1 and not response.json()["history"]["initialized"]
                assert not rows()["asset_raw_histories"]
        finally:
            await api.close()
    asyncio.run(run())


def test_confirmed_gesture_undo_redo_jump_noop_and_replay(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                init_request = body(doc)
                doc = await operation(http, doc, "initialize", init_request)
                assert doc["history"]["length"] == 0
                for exposure in (.25, .5, 1.):
                    doc = await change(http, doc, exposure)
                assert not rows()["asset_raw_history_steps"]
                first_request = commit_body(doc)
                doc = await operation(http, doc, "commit", first_request)
                one = doc["ack"]["stepId"]
                assert doc["history"]["length"] == doc["history"]["cursor"] == 1
                assert doc["values"]["light.exposure"] == 1.
                doc = await change(http, doc, 2.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                two = doc["ack"]["stepId"]
                undo_request = body(doc)
                doc = await operation(http, doc, "undo", undo_request)
                assert doc["values"]["light.exposure"] == 1. and doc["history"]["cursor"] == 1
                attempt = doc["mutationAttempts"]
                replay = await operation(http, doc, "undo", undo_request)
                assert replay["replayed"] and replay["mutationAttempts"] == attempt
                assert replay["history"]["cursor"] == 1
                doc = await operation(http, doc, "commit", commit_body(doc))
                assert not doc["ack"]["changed"] and doc["history"]["length"] == 2
                doc = await operation(http, doc, "redo")
                assert doc["values"]["light.exposure"] == 2.
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": None})
                assert doc["history"]["cursor"] == 0 and doc["values"]["light.exposure"] == 0.
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": one})
                doc = await change(http, doc, 3.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                listing = (await http.get(url(doc), headers=headers(doc))).json()
                assert len(listing["steps"]) == 2 and two not in {step["stepId"] for step in listing["steps"]}
                old = await operation(http, doc, "commit", first_request)
                assert old["replayed"] and old["ack"]["revision"] < old["recipeRevision"]
                assert old["values"]["light.exposure"] == 3. and old["history"]["cursor"] == 2
                assert all(command not in {"edit.undo", "edit.redo", "history.restore"} for command, _ in children[0].commands)
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("field,value,code", [
    ("generation", 999, "raw_stale_handle"), ("documentToken", "wrong", "raw_stale_handle"),
    ("documentRevision", 999, "raw_revision_conflict"), ("settingsFingerprint", "0" * 64, "raw_revision_conflict"),
    ("expectedRecipeRevision", 1, "raw_history_revision_conflict"),
    ("expectedRecipeRevision", True, "raw_invalid_request"), ("saveId", "bad", "raw_invalid_request"),
    ("settings", {}, "raw_invalid_request"), ("kind", "allReset", "raw_invalid_request"),
    ("metadata", {"control": "crop.angle"}, "raw_invalid_request"),
])
def test_invalid_operation_never_changes_native_or_database(local, tmp_path, monkeypatch, field, value, code):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                commands, previous = list(children[0].commands), rows()
                result = await http.post(url(doc, "commit"), json=commit_body(doc) | {field: value})
                assert result.status_code in (400, 409) and result.json()["code"] == code
                assert commands == children[0].commands and rows() == previous
        finally:
            await api.close()
    asyncio.run(run())


def test_uninitialized_commit_and_legacy_dirty_optin_are_safe(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                assert (await http.post(url(doc, "commit"), json=commit_body(doc))).json()["code"] == "raw_history_not_initialized"
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc))).status_code == 200
                doc = await change(http, doc, 1.)
                doc["recipeRevision"] = 1
                refused = await http.post(url(doc, "initialize"), json=body(doc))
                assert refused.json()["code"] == "raw_history_commit_required" and not api._history_save
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc, 1))).status_code == 200
                doc["recipeRevision"] = 2
                doc = await operation(http, doc, "initialize")
                assert doc["history"]["length"] == 0 and doc["values"]["light.exposure"] == 1.
        finally:
            await api.close()
    asyncio.run(run())


def test_auth_pagination_and_no_arbitrary_settings(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                assert (await http.get('/api/raw/documents/x/history')).status_code == 401
                assert (await http.post('/api/raw/documents/x/history/undo', json={})).status_code == 401
                await authenticate(http, local)
                _, doc = await open_document(http)
                for illegal in ({"Origin": "http://evil.example"}, {"Host": "evil.example"}):
                    assert (await http.post(url(doc, "initialize"), json=body(doc), headers=illegal)).status_code == 403
                assert (await http.get(url(doc), headers=headers(doc) | {"X-Raw-Token": "bad"})).status_code == 409
                for query in ("limit=21", "offset=-1", "offset=201", "limit=x", "random=1"):
                    assert (await http.get(url(doc) + "?" + query, headers=headers(doc))).status_code == 400
                oversized = await http.post(url(doc, "initialize"), content=json.dumps({"x": "x" * 4096}),
                                            headers={"Content-Type": "application/json"})
                assert oversized.status_code == 413
                doc = await operation(http, doc, "initialize")
                for index in range(22):
                    doc = await change(http, doc, (index + 1) / 10)
                    doc = await operation(http, doc, "commit", commit_body(doc))
                response = await http.get(url(doc), headers=headers(doc))
                assert len(response.content) <= 16384 and len(response.json()["steps"]) == 20
                assert response.json()["hasMore"]
                first = response.json()["steps"][0]
                assert first["changes"] == [{"control": "light.exposure", "before": 0, "after": .1}]
                last = (await http.get(url(doc) + "?offset=20", headers=headers(doc))).json()
                assert len(last["steps"]) == 2 and not last["hasMore"]
                assert last["steps"][0]["changes"] == [{"control": "light.exposure", "before": 2., "after": 2.1}]
                assert not {"settings", "sourceContentHash", "baselineSettings"} & set(last)
                assert all(set(step) == {"stepId", "kind", "metadata", "createdAt", "changes"} for step in last["steps"])
        finally:
            await api.close()
    asyncio.run(run())


def test_history_page_diffs_follow_rolled_baseline_and_new_branch(local, tmp_path, monkeypatch):
    import raw_recipe_store

    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        monkeypatch.setattr(raw_recipe_store, "HISTORY_LIMIT", 2)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                ids = []
                for exposure in (1., 2., 3.):
                    doc = await change(http, doc, exposure)
                    doc = await operation(http, doc, "commit", commit_body(doc))
                    ids.append(doc["history"]["selectedStepId"])

                rolled = (await http.get(url(doc), headers=headers(doc))).json()
                assert rolled["history"]["length"] == rolled["history"]["cursor"] == 2
                assert [step["stepId"] for step in rolled["steps"]] == ids[1:]
                assert rolled["steps"][0]["changes"] == [{"control": "light.exposure", "before": 1., "after": 2.}]

                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": None})
                doc = await change(http, doc, .5)
                doc = await operation(http, doc, "commit", commit_body(doc))
                branched = (await http.get(url(doc), headers=headers(doc))).json()
                assert branched["history"]["length"] == branched["history"]["cursor"] == 1
                assert branched["steps"][0]["changes"] == [{"control": "light.exposure", "before": 1., "after": .5}]
        finally:
            await api.close()
    asyncio.run(run())


def test_history_change_projection_fails_closed_for_unusable_snapshots():
    from windows_raw_api import RawPreviewApi

    step = {"kind": "control", "metadata": {"control": "light.exposure"}}
    valid = {"light": {"exposure": .7}}
    assert RawPreviewApi._history_changes(step, valid, {"light": {"exposure": .6}}) == [
        {"control": "light.exposure", "before": .7, "after": .6}]
    for broken in ({"light": {"exposure": True}}, {"light": {"exposure": float("nan")}}, {"light": []}, {}):
        assert RawPreviewApi._history_changes(step, broken, valid) is None


@pytest.mark.parametrize("failure", ["busy", "full", "commit", "unknown"])
def test_native_move_then_db_failure_is_locked_and_retry_does_not_mutate_again(local, tmp_path, monkeypatch, failure):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                request, previous = body(doc), rows()
                original, connect = store.move_raw_history_cursor, sqlite3.connect
                class FailingConnection(sqlite3.Connection):
                    def execute(self, sql, parameters=()):
                        if sql == "BEGIN IMMEDIATE":
                            self.writing = True
                        if sql == "PRAGMA busy_timeout=3000" and failure == "busy":
                            sql = "PRAGMA busy_timeout=0"
                        if sql == "BEGIN IMMEDIATE" and failure == "full":
                            super().execute(f'PRAGMA max_page_count={super().execute("PRAGMA page_count").fetchone()[0]}')
                        if sql.startswith("INSERT INTO raw_history_saves") and failure == "full":
                            error = sqlite3.OperationalError("database or disk is full")
                            error.sqlite_errorcode = sqlite3.SQLITE_FULL
                            raise error
                        return super().execute(sql, parameters)
                    def commit(self):
                        if failure == "commit" and getattr(self, "writing", False):
                            raise sqlite3.OperationalError("injected commit I/O failure")
                        return super().commit()
                with closing(connect(edit_store.DB_PATH, isolation_level=None)) as locker:
                    if failure == "busy":
                        locker.execute("BEGIN IMMEDIATE")
                    with monkeypatch.context() as patch:
                        if failure == "unknown":
                            def hidden(*args, **kwargs):
                                original(*args, **kwargs)
                                raise store.StoreUnavailable()
                            patch.setattr(store, "move_raw_history_cursor", hidden)
                        else:
                            patch.setattr(edit_store.sqlite3, "connect", lambda *a, **kw: connect(*a, **kw, factory=FailingConnection))
                        result = await http.post(url(doc, "undo"), json=request)
                        assert result.status_code == 503 and result.json()["code"] == "raw_history_save_failed"
                    locker.rollback()
                if failure != "unknown":
                    assert rows() == previous
                assert children[0].photos[1]["settings"]["light"]["exposure"] == 0.
                attempt, commands = api.raw.status().edits, list(children[0].commands)
                assert (await http.post(f'/api/raw/documents/{doc["handle"]}/controls', json=identity(doc) |
                    {"expectedRevision": api.document["revision"], "values": {"light.exposure": 2}})).json()["code"] == "raw_history_save_pending"
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc))).json()["code"] == "raw_history_save_pending"
                assert (await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')).json()["code"] == "raw_history_save_pending"
                with pytest.raises(LightCraftError, match="raw_history_save_pending"):
                    await api.close()
                doc = await operation(http, doc, "undo", request)
                assert doc["history"]["cursor"] == 0 and doc["nativeMatchesRecipe"]
                assert not doc["historyPending"] and api.raw.status().edits == attempt
                assert children[0].commands == commands
        finally:
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 15))


@pytest.mark.parametrize("failure", ["native", "mismatch", "readback-change"])
def test_failed_apply_or_readback_never_changes_db_and_explicit_retry_recovers(local, tmp_path, monkeypatch, failure):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                previous = rows()
                if failure == "readback-change":
                    children[0].photos[1]["settings"]["light"]["exposure"] = 2.
                    response = await http.post(url(doc, "commit"), json=commit_body(doc))
                    assert response.json()["code"] == "raw_revision_conflict"
                    assert rows() == previous
                    doc = await recover(http, api, doc)
                else:
                    request = body(doc)
                    if failure == "mismatch":
                        children[0].mismatch = True
                    else:
                        original = children[0].respond
                        def fail(message):
                            args = message.get("params", {}).get("arguments", {})
                            if args.get("id") == "develop.merge":
                                return children[0].tool(message, error=True)
                            return original(message)
                        monkeypatch.setattr(children[0].stdin, "respond", fail)
                    response = await http.post(url(doc, "undo"), json=request)
                    assert response.status_code == 502 and rows() == previous
                    assert api.raw.status().state == "desynchronized"
                    assert (await http.get(url(doc), headers=headers(doc))).json()["historyPending"]
                    children[0].mismatch = False
                    if failure == "native":
                        monkeypatch.setattr(children[0].stdin, "respond", original)
                    doc = await operation(http, doc, "undo", request)
                    assert doc["history"]["cursor"] == 0
                assert doc["nativeMatchesRecipe"] and not doc["historyPending"]
        finally:
            children[0].mismatch = False
            await api.close()
    asyncio.run(run())


def test_http_cancel_and_shutdown_wait_for_native_and_database(local, tmp_path, monkeypatch):
    async def run():
        api, manager, _, root = await setup(tmp_path, local, monkeypatch)
        entered, gate = asyncio.Event(), threading.Event()
        loop, write = asyncio.get_running_loop(), store.append_raw_history
        def delayed(*args, **kwargs):
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            return write(*args, **kwargs)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                monkeypatch.setattr(store, "append_raw_history", delayed)
                request = commit_body(doc)
                task = asyncio.create_task(http.post(url(doc, "commit"), json=request))
                await entered.wait()
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                closing = asyncio.create_task(api.close())
                await until(lambda: api._history_draining)
                assert not closing.done() and manager.status().state == "ready" and list(root.iterdir())
                gate.set()
                await closing
                assert len(rows()["asset_raw_history_steps"]) == 1
                assert manager.status().state == "stopped" and not api._tasks and not list(root.iterdir())
        finally:
            gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 15))


def test_session_renewal_at_200_preserves_history_and_rejects_stale_owner(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                workspace, doc = await open_document(http)
                original = doc
                first_id = None
                for cycle in range(2):
                    doc = await operation(http, doc, "initialize")
                    for index in range(200 - doc["mutationAttempts"]):
                        doc = await change(http, doc, (index % 30) / 10)
                    assert doc["mutationAttempts"] == 200
                    doc = await change(http, doc, 1.25 + cycle)
                    assert doc["mutationAttempts"] == 201
                    doc = await operation(http, doc, "commit", commit_body(doc))
                    if first_id is None:
                        first_id = doc["ack"]["stepId"]
                    assert doc["history"]["length"] == cycle + 1
                    checkpoint = await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc, doc["recipeRevision"]))
                    assert checkpoint.status_code == 200
                    assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
                    workspace, response = await open_asset(http, doc["assetId"])
                    reopened = response.json()
                    assert reopened["generation"] > doc["generation"] and reopened["mutationAttempts"] == 1
                    listing = (await http.get(url(reopened), headers=headers(reopened))).json()
                    assert listing["history"]["length"] == listing["history"]["cursor"] == cycle + 1
                    assert listing["steps"][0]["stepId"] == first_id
                    # An older client may inspect persisted History but must opt in before editing it.
                    rejected = await http.post(f'/api/raw/documents/{reopened["handle"]}/controls', json=identity(reopened) |
                        {"expectedRevision": reopened["revision"], "values": {"light.exposure": 3}})
                    assert rejected.json()["code"] == "raw_history_client_required"
                    assert (await http.post(url(reopened, "undo"), json=body(original))).status_code == 409
                    assert (await http.post(url(original, "undo"), json=body(original))).status_code == 409
                    doc = reopened
                other_asset = str(uuid4())
                assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
                _, other = await open_asset(http, other_asset)
                doc = await operation(http, other.json(), "initialize")
                rejected = await http.post(url(doc, "jump"), json=body(doc) | {"targetStepId": first_id})
                assert rejected.json()["code"] == "raw_history_target_missing"
        finally:
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 30))


def test_equal_settings_cursor_move_and_recipe_checkpoint(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                for exposure in (1., 0.):
                    doc = await change(http, doc, exposure)
                    doc = await operation(http, doc, "commit", commit_body(doc))
                mutation = doc["mutationAttempts"]
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": None})
                assert doc["ack"]["changed"] and doc["history"]["cursor"] == 0
                assert doc["mutationAttempts"] == mutation
                doc = await change(http, doc, 2.)
                rejected = await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc, doc["recipeRevision"]))
                assert rejected.json()["code"] == "raw_history_requires_operation"
                # A known rejected checkpoint must not permanently prevent the correct History commit.
                assert rows()["asset_raw_history_steps"]
                doc = await operation(http, doc, "commit", commit_body(doc))
                assert doc["history"]["length"] == 1
        finally:
            await api.close()
    asyncio.run(run())


def test_same_save_id_cannot_identify_another_request_or_recipe_only_save(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                legacy_id = uuid4()
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=save_body(doc, 0, legacy_id))).status_code == 200
                doc["recipeRevision"] = 1
                assert (await http.post(url(doc, "initialize"), json=body(doc, 0, legacy_id))).json()["code"] == "raw_history_save_id_reused"
                request = body(doc)
                doc = await operation(http, doc, "initialize", request)
                previous, commands = rows(), list(children[0].commands)
                for change_request in (request | {"documentRevision": doc["revision"] + 1}, request | {"expectedRecipeRevision": 99}):
                    rejected = await http.post(url(doc, "initialize"), json=change_request)
                    assert rejected.json()["code"] == "raw_history_save_id_reused"
                assert rows() == previous and children[0].commands == commands
        finally:
            await api.close()
    asyncio.run(run())


def test_external_cas_conflict_after_native_apply_can_be_explicitly_recovered(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        gate = None
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                request = body(doc)
                entered, gate = hold_merge(children[0], monkeypatch)
                undo = asyncio.create_task(http.post(url(doc, "undo"), json=request))
                await entered.wait()
                state = store.get_raw_history(api._history_identity)
                external = copy.deepcopy(state["recipe"]["settings"])
                external["light"]["exposure"] = 2.
                store.append_raw_history(api._history_identity, state["revision"], uuid4(), external,
                    kind="control", metadata={"control": "light.exposure"})
                gate.set()
                result = await undo
                assert result.json()["code"] == "raw_history_revision_conflict"
                listing = (await http.get(url(doc), headers=headers(doc))).json()
                assert listing["historyPending"] and not listing["nativeMatchesRecipe"]
                doc = await recover(http, api, doc)
                assert doc["nativeMatchesRecipe"] and not doc["historyPending"]
                assert doc["values"]["light.exposure"] == 2. and doc["history"]["length"] == 2
                assert doc["ack"] is None
        finally:
            if gate:
                gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


def test_legacy_wb_scale_omission_keeps_saved_baseline_and_verified_restore(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        asset_id = uuid4()
        try:
            # This supported C3 representation omits the optional legacy scale.
            seeded = seed(asset_id)
            saved = seeded["recipe"]["settings"]
            saved["wb"].pop("scale")
            store.put_raw_recipe({key: seeded["recipe"][key] for key in store.IDENTITY_FIELDS}, 1, uuid4(), saved)
            async with client(local) as http:
                await authenticate(http, local)
                _, response = await open_asset(http, asset_id)
                doc = await operation(http, response.json(), "initialize")
                doc = await change(http, doc, 2.5)
                doc = await operation(http, doc, "commit", commit_body(doc))
                doc = await operation(http, doc, "undo")
                assert doc["history"]["cursor"] == 0 and doc["nativeMatchesRecipe"]
                assert "scale" not in store.get_raw_history(api._history_identity)["history"]["baselineSettings"]["wb"]
        finally:
            await api.close()
    asyncio.run(run())


def test_close_during_first_history_initialization_waits_for_outcome(local, tmp_path, monkeypatch):
    async def run():
        api, manager, _, _ = await setup(tmp_path, local, monkeypatch)
        entered, gate = asyncio.Event(), threading.Event()
        loop, lookup = asyncio.get_running_loop(), store.get_raw_history_save
        def delayed(*args, **kwargs):
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            return lookup(*args, **kwargs)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                monkeypatch.setattr(store, "get_raw_history_save", delayed)
                task = asyncio.create_task(http.post(url(doc, "initialize"), json=body(doc)))
                await entered.wait()
                assert api._history_save is None
                closing = asyncio.create_task(api.close())
                await until(lambda: api._history_draining)
                assert not closing.done() and manager.status().state == "ready"
                gate.set()
                assert (await task).status_code == 200
                await closing
                assert rows()["asset_raw_histories"] and manager.status().state == "stopped"
        finally:
            gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


def test_shutdown_during_native_restore_waits_for_readback_and_cursor_save(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
        gate = None
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                entered, gate = hold_merge(children[0], monkeypatch)
                undo = asyncio.create_task(http.post(url(doc, "undo"), json=body(doc)))
                await entered.wait()
                closing = asyncio.create_task(api.close())
                await until(lambda: api._history_draining)
                assert manager.status().state == "ready" and not closing.done()
                gate.set()
                assert (await undo).json()["history"]["cursor"] == 0
                await closing
                assert rows()["asset_raw_histories"][0][7] == 0
                assert manager.status().state == "stopped"
        finally:
            if gate:
                gate.set()
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 12))


def test_postcommit_ownership_loss_is_unknown_and_never_advances_old_ack(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                request = commit_body(doc)
                write, verify = store.append_raw_history, api._history_verify
                invalid = threading.Event()
                def committed(*args, **kwargs):
                    result = write(*args, **kwargs)
                    invalid.set()
                    return result
                def stale(current):
                    if invalid.is_set():
                        raise LightCraftError("raw_stale_handle")
                    verify(current)
                with monkeypatch.context() as patch:
                    patch.setattr(store, "append_raw_history", committed)
                    patch.setattr(api, "_history_verify", stale)
                    result = await http.post(url(doc, "commit"), json=request)
                    assert result.status_code == 502 and result.json()["code"] == "raw_history_save_unknown"
                    assert api.document["recipeRevision"] == doc["recipeRevision"]
                doc = await operation(http, doc, "commit", request)
                assert doc["replayed"] and doc["history"]["length"] == 1 and not doc["historyPending"]
        finally:
            await api.close()
    asyncio.run(run())


def test_uncertain_c3_save_resolves_before_history_optin(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                request = save_body(doc)
                with monkeypatch.context() as patch:
                    def fail(*args):
                        raise store.StoreUnavailable()
                    patch.setattr(store, "put_raw_recipe", fail)
                    assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=request)).status_code == 503
                assert (await http.post(url(doc, "initialize"), json=body(doc))).json()["code"] == "raw_recipe_save_pending"
                assert (await http.put(f'/api/raw/documents/{doc["handle"]}/recipe', json=request)).status_code == 200
                doc["recipeRevision"] = 1
                doc = await operation(http, doc, "initialize")
                assert doc["history"]["initialized"] and doc["history"]["length"] == 0
        finally:
            await api.close()
    asyncio.run(run())


def test_failed_intermediate_control_readback_cannot_release_a_history_session(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                children[0].fail_get = True
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls', json=identity(doc) |
                    {"expectedRevision": doc["revision"], "values": {"light.exposure": 1}})
                assert response.status_code == 502 and api._history_save["stage"] == "complete"
                metadata = (await http.get(url(doc), headers=headers(doc))).json()
                assert not metadata["nativeMatchesRecipe"] and metadata["nativeState"] == "desynchronized"
                response = await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                assert response.json()["code"] == "raw_history_commit_required"
                with pytest.raises(LightCraftError, match="raw_history_commit_required"):
                    await api.close()
                assert manager.status().state == "ready"
                children[0].fail_get = False
                doc = await recover(http, api, doc)
                assert doc["nativeMatchesRecipe"] and doc["values"]["light.exposure"] == 0.
        finally:
            children[0].fail_get = False
            await api.close()
    asyncio.run(run())


def test_fresh_undo_readback_change_is_rejected_before_native_restore(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                doc = await operation(http, doc, "commit", commit_body(doc))
                children[0].photos[1]["settings"]["light"]["exposure"] = 2.
                before = rows()
                attempt = api.raw.status().edits
                result = await http.post(url(doc, "undo"), json=body(doc))
                assert result.json()["code"] == "raw_revision_conflict"
                assert rows() == before and api.raw.status().edits == attempt
                assert not api._history_save
                doc = await recover(http, api, doc)
                assert doc["values"]["light.exposure"] == 1.
        finally:
            await api.close()
    asyncio.run(run())


def test_history_lifecycle_restores_preview_cursor_across_switch_renewal_and_restart(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
        child_groups = [children]
        image_result = fake_native.image_result

        def exposure_png(exposure):
            output = io.BytesIO()
            Image.new("RGBA", (16, 12), (100 + round(exposure * 20), 50, 80, 255)).save(output, "PNG")
            return output.getvalue()

        def render_selected_settings(photo=1, **_):
            # An independent color marker detects rendering the wrong native snapshot, not GPU fidelity.
            exposure = children[-1].photos[photo]["settings"]["light"]["exposure"]
            return image_result(photo, data=exposure_png(exposure))

        monkeypatch.setattr(fake_native, "image_result", render_selected_settings)

        async def verify(http, doc, step_ids, cursor, exposure):
            response = await http.get(url(doc), headers=headers(doc))
            assert response.status_code == 200
            page = response.json()
            assert page["history"] == {"initialized": True, "cursor": cursor, "length": len(step_ids),
                                       "selectedStepId": step_ids[cursor - 1] if cursor else None}
            assert [step["stepId"] for step in page["steps"]] == step_ids
            assert page["nativeMatchesRecipe"] and not page["historyPending"]
            stored = store.get_raw_history(api._history_identity)
            selected = stored["history"]["steps"][cursor - 1]["settings"] if cursor else stored["history"]["baselineSettings"]
            snapshot = await api.raw.get_settings(api._raw_handle)
            assert stored["recipe"]["settings"] == selected == snapshot.settings
            assert selected["light"]["exposure"] == doc["values"]["light.exposure"] == exposure
            assert stored["revision"] == page["recipeRevision"] == doc["recipeRevision"]
            frame = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc))
            assert frame.status_code == 200 and frame.content == exposure_png(exposure)
            assert frame.headers["x-raw-token"] == doc["documentToken"]
            assert frame.headers["x-raw-revision"] == str(doc["revision"])

        async def reopen(http, asset_id):
            workspace, response = await open_asset(http, asset_id)
            assert response.status_code == 200, response.text
            return workspace, await operation(http, response.json(), "initialize")

        try:
            async with client(local) as http:
                await authenticate(http, local)
                workspace, doc = await open_document(http)
                asset_id = doc["assetId"]
                doc = await operation(http, doc, "initialize")
                ids = []
                await verify(http, doc, ids, 0, 0.)
                for gesture in ((.25, .5, 1.), (1.25, 1.5, 2.), (2.25, 2.5, 3.)):
                    for exposure in gesture:
                        doc = await change(http, doc, exposure)
                        assert len(store.get_raw_history(api._history_identity)["history"]["steps"]) == len(ids)
                    doc = await operation(http, doc, "commit", commit_body(doc))
                    ids.append(doc["ack"]["stepId"])
                    assert len(set(ids)) == len(ids)
                    await verify(http, doc, ids, len(ids), gesture[-1])
                doc = await operation(http, doc, "undo")
                await verify(http, doc, ids, 2, 2.)
                doc = await operation(http, doc, "redo")
                await verify(http, doc, ids, 3, 3.)
                for target, cursor, exposure in ((None, 0, 0.), (ids[0], 1, 1.), (ids[1], 2, 2.)):
                    doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": target})
                    await verify(http, doc, ids, cursor, exposure)
                doc = await operation(http, doc, "commit", commit_body(doc))
                assert not doc["ack"]["changed"]
                await verify(http, doc, ids, 2, 2.)
                doc = await change(http, doc, 2.25)
                doc = await change(http, doc, 2.5)
                doc = await operation(http, doc, "commit", commit_body(doc))
                removed = ids.pop()
                ids.append(doc["ack"]["stepId"])
                assert removed not in ids
                await verify(http, doc, ids, 3, 2.5)
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": ids[0]})
                await verify(http, doc, ids, 1, 1.)
                assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
                workspace, other = await reopen(http, str(uuid4()))
                other = await change(http, other, .75)
                other = await operation(http, other, "commit", commit_body(other))
                await verify(http, other, [other["ack"]["stepId"]], 1, .75)
                assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
                workspace, doc = await reopen(http, asset_id)
                await verify(http, doc, ids, 1, 1.)
                generation, token = doc["generation"], doc["documentToken"]
                assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
                workspace, doc = await reopen(http, asset_id)
                assert doc["generation"] > generation and doc["documentToken"] != token
                await verify(http, doc, ids, 1, 1.)
            await api.close()
            assert manager.status().state == "stopped"
            # A fresh host and adapter share only SQLite, not the previous document or Python owner.
            restarted = LocalHost(main.app, dist=tmp_path / "dist")
            restart_root = tmp_path / "restart"
            restart_root.mkdir()
            api, manager, children, _ = await setup(restart_root, restarted, monkeypatch)
            child_groups.append(children)
            async with client(restarted) as http:
                await authenticate(http, restarted)
                _, doc = await reopen(http, asset_id)
                await verify(http, doc, ids, 1, 1.)
                doc = await operation(http, doc, "redo")
                await verify(http, doc, ids, 2, 2.)
            assert all(command not in {"edit.undo", "edit.redo", "history.restore"}
                       for group in child_groups for child in group for command, _ in child.commands)
        finally:
            await api.close()
    asyncio.run(asyncio.wait_for(run(), 30))
