import asyncio
import copy

import pytest

import raw_recipe_store as store
from edit_store import StoreUnavailable
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document, preview_body
from tests.test_raw_recipe_api import headers
from tests.test_raw_controls import identity
from tests.test_raw_history_api import url, body, operation, rows
from tests.test_raw_recipe_restore import open_asset


async def open_history(http, local, api):
    await authenticate(http, local)
    _, doc = await open_document(http)
    return await operation(http, doc, "initialize")


async def patch(http, doc, values):
    response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
        json=identity(doc) | {"expectedRevision": doc["revision"], "values": values})
    assert response.status_code == 200, response.text
    return response.json()


async def edit(http, doc, kind, metadata):
    return await operation(http, doc, "operate", body(doc) | {"kind": kind, "metadata": metadata})


def test_before_cache_is_read_only_across_category_reset_and_history_branch(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.before_supported = True
        child.as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                key = doc["beforeKey"]
                serial = 0
                before_png = None

                async def compare(current):
                    nonlocal serial, before_png
                    serial += 1
                    durable = rows()
                    document = copy.deepcopy(api.document)
                    settings = copy.deepcopy(child.photos[child.active]["settings"])
                    attempts = api.raw.status().edits
                    response = await http.post(f'/api/raw/documents/{current["handle"]}/preview',
                        json=preview_body(current, serial) | {"kind": "before"})
                    assert response.status_code == 200, response.text
                    assert response.headers["x-raw-kind"] == "before"
                    assert response.headers["x-raw-before-key"] == key == current["beforeKey"]
                    assert response.headers["x-raw-revision"] == str(current["revision"])
                    if before_png is None:
                        before_png = response.content
                    assert response.content == before_png and child.render_count == 1
                    # A cached comparison must not touch even receipts or the native mutation budget.
                    assert rows() == durable and api.document == document
                    assert child.photos[child.active]["settings"] == settings
                    assert api.raw.status().edits == attempts

                await compare(doc)
                doc = await patch(http, doc, {"light.exposure": 1.25, "wb.temp": 11000., "color.vibrance": 15.})
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "light.exposure"}})
                await compare(doc)
                for kind, metadata in (("sectionToggle", {"section": "color", "enabled": False}),
                        ("controlReset", {"control": "wb.temp"}),
                        ("sectionReset", {"section": "color"}), ("allReset", {})):
                    length = doc["history"]["length"]
                    doc = await edit(http, doc, kind, metadata)
                    assert doc["history"]["length"] == length + 1
                    await compare(doc)
                for action in ("undo", "redo"):
                    doc = await operation(http, doc, action)
                    await compare(doc)
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": None})
                await compare(doc)
                doc = await patch(http, doc, {"light.exposure": .5})
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "light.exposure"}})
                assert doc["history"]["cursor"] == doc["history"]["length"] == 1
                await compare(doc)
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc, serial + 1))
                assert response.status_code == 200 and response.headers["x-raw-kind"] == "after"
                assert child.render_count == 2
                assert child.photos[child.active]["settings"] == store.get_raw_history(api._history_identity)["recipe"]["settings"]
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("control", ["light.exposure", "light.contrast", "light.highlights", "light.whites",
    "light.shadows", "light.blacks", "color.vibrance", "color.saturation", "wb.temp", "wb.tint"])
def test_control_reset_off_as_shot_history_and_replay(local, tmp_path, monkeypatch, control):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                values = {"wb.temp": 11000., "wb.tint": 26.} if control.startswith("wb.") else {control: 1.}
                doc = await patch(http, doc, values)
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": control}})
                section = "light" if control.startswith("light.") else "color"
                before_values = doc["values"]
                doc = await edit(http, doc, "sectionToggle", {"section": section, "enabled": False})
                assert doc["values"] == before_values and doc["sections"][section] is False
                request = body(doc) | {"kind": "controlReset", "metadata": {"control": control}}
                result = await operation(http, doc, "operate", request)
                assert result["history"]["length"] == 3 and result["sections"][section] is False
                if control.startswith("wb."):
                    assert result["wb"] == {"available": True, "mode": "asShot", "scale": "kelvin"}
                    assert (result["values"]["wb.temp"], result["values"]["wb.tint"]) == (4875., 13.)
                else:
                    assert result["values"][control] == 0.
                page = (await http.get(url(result), headers=headers(result))).json()
                changes = page["steps"][-1]["changes"]
                assert {change["control"] for change in changes} == ({"wb.temp", "wb.tint"} if control.startswith("wb.") else {control})
                commands = list(children[0].commands)
                replay = await operation(http, doc, "operate", request)
                assert replay["replayed"] and children[0].commands == commands
                undone = await operation(http, result, "undo")
                assert undone["values"] == before_values and undone["sections"][section] is False
                redone = await operation(http, undone, "redo")
                assert redone["values"] == result["values"]
                enabled = await edit(http, redone, "sectionToggle", {"section": section, "enabled": True})
                assert enabled["sections"][section] and enabled["values"] == redone["values"]
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind,metadata,cost", [("sectionReset", {"section": "light"}, 1),
    ("sectionReset", {"section": "color"}, 2), ("allReset", {}, 3)])
def test_compound_reset_keeps_bypass_one_step_and_reopens(local, tmp_path, monkeypatch, kind, metadata, cost):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {"light.exposure": 1., "wb.temp": 11000., "wb.tint": 26., "color.vibrance": 15.})
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "light.exposure"}})
                # Model a complete saved native state containing settings outside the current UI.
                children[0].photos[children[0].active]["settings"]["disabled_sections"] = ["detail"]
                children[0].photos[children[0].active]["settings"]["curve"]["master"][1]["y"] = .8
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                doc = response.json()
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "light.exposure"}})
                for section in ("light", "color"):
                    doc = await edit(http, doc, "sectionToggle", {"section": section, "enabled": False})
                before = copy.deepcopy(doc)
                before_settings = store.get_raw_history(api._history_identity)["recipe"]["settings"]
                attempts = api.raw.status().edits
                doc = await edit(http, doc, kind, metadata)
                assert doc["history"]["length"] == before["history"]["length"] + 1
                assert doc["sections"] == {"light": False, "color": False}
                actual = store.get_raw_history(api._history_identity)["recipe"]["settings"]
                assert actual["disabled_sections"] == before_settings["disabled_sections"]
                if kind == "sectionReset":
                    assert actual["curve"] == before_settings["curve"]
                assert api.raw.status().edits - attempts == cost
                if kind == "allReset" or metadata.get("section") == "color":
                    assert (doc["wb"]["mode"], doc["values"]["wb.temp"], doc["values"]["wb.tint"], doc["wb"]["scale"]) == ("asShot", 4875., 13., "kelvin")
                undone = await operation(http, doc, "undo")
                assert undone["values"] == before["values"] and undone["sections"] == before["sections"]
                doc = await operation(http, undone, "redo")
                saved = store.get_raw_history(api._history_identity)
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc["assetId"])
                assert response.status_code == 200, response.text
                reopened = await operation(http, response.json(), "initialize")
                assert reopened["values"] == doc["values"] and reopened["sections"] == doc["sections"]
                assert store.get_raw_history(api._history_identity)["history"] == saved["history"]
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("failure", ["wbMismatch", "wbFailure", "rollbackFailure", "sqlite"])
def test_failed_reset_does_not_commit_and_retry_preserves_intent(local, tmp_path, monkeypatch, failure):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {"color.vibrance": 20., "wb.temp": 11000.})
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "color.vibrance"}})
                before = store.get_raw_history(api._history_identity)
                request = body(doc) | {"kind": "sectionReset", "metadata": {"section": "color"}}
                writer = store.append_raw_history
                if failure == "sqlite":
                    monkeypatch.setattr(store, "append_raw_history", lambda *args, **kwargs: (_ for _ in ()).throw(StoreUnavailable()))
                elif failure == "wbMismatch":
                    child.wb_mismatch = True
                else:
                    child.fail_commands = {"develop.wb"} | ({"develop.merge"} if failure == "rollbackFailure" else set())
                response = await http.post(url(doc, "operate"), json=request)
                assert response.status_code >= 500
                assert store.get_raw_history(api._history_identity) == before
                if failure in ("wbMismatch", "wbFailure"):
                    assert api.raw.status().state == "synced"
                    assert child.photos[child.active]["settings"] == before["recipe"]["settings"]
                elif failure == "rollbackFailure":
                    assert api.raw.status().state == "desynchronized"
                else:
                    assert api._history_save["stage"] == "save"
                commands = len(child.commands)
                child.wb_mismatch = False
                child.fail_commands.clear()
                monkeypatch.setattr(store, "append_raw_history", writer)
                result = await operation(http, doc, "operate", request)
                assert result["history"]["length"] == 2 and result["nativeMatchesRecipe"]
                if failure == "sqlite":
                    assert len(child.commands) == commands
                assert result["values"]["wb.temp"] == 4875.
        finally:
            child.fail_commands.clear()
            child.wb_mismatch = False
            await api.close()
    asyncio.run(run())


def test_reset_noop_retains_redo_and_budget_is_per_native_command(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await edit(http, doc, "sectionToggle", {"section": "light", "enabled": False})
                doc = await operation(http, doc, "undo")
                doc = await edit(http, doc, "controlReset", {"control": "light.exposure"})
                assert doc["history"]["length"] == 1 and doc["history"]["cursor"] == 0
                doc = await edit(http, doc, "sectionToggle", {"section": "color", "enabled": False})
                assert doc["history"]["length"] == 1
                api.raw._edits = 199
                doc = await edit(http, doc, "allReset", {})
                assert doc["mutationAttempts"] == 202
                api.raw._edits = 255
                commands = len(children[0].commands)
                denied = await http.post(url(doc, "operate"), json=body(doc) | {"kind": "sectionReset", "metadata": {"section": "color"}})
                assert denied.json()["code"] == "raw_session_edit_limit"
                assert len(children[0].commands) == commands + 1  # Readback only; no mutation was sent.
                assert api.raw.status().edits == 255
                api._history_save = None
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("field,value", [("mode", "custom"), ("temp", 6500.), ("tint", 0.), ("scale", "legacy")])
def test_as_shot_requires_every_reference_field(local, tmp_path, monkeypatch, field, value):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                baseline = store.get_raw_history(api._history_identity)
                child.wb_override = {field: value}
                request = body(doc) | {"kind": "controlReset", "metadata": {"control": "wb.tint"}}
                response = await http.post(url(doc, "operate"), json=request)
                assert response.json()["code"] == "raw_as_shot_mismatch"
                assert store.get_raw_history(api._history_identity) == baseline
                assert api.raw.status().state == "synced"
                child.wb_override.clear()
                await operation(http, doc, "operate", request)
        finally:
            child.wb_override.clear()
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind,metadata", [("command", {"command": "develop.reset"}),
    ("controlReset", {"control": "hdr.maxEv"}), ("sectionToggle", {"section": "detail", "enabled": False}),
    ("sectionToggle", {"section": "color", "enabled": 0}), ("allReset", {"settings": {}})])
def test_operation_endpoint_rejects_unallowlisted_intent(local, tmp_path, monkeypatch, kind, metadata):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                commands = list(children[0].commands)
                response = await http.post(url(doc, "operate"), json=body(doc) | {"kind": kind, "metadata": metadata})
                assert response.status_code == 400 and children[0].commands == commands
                assert api._history_save["stage"] == "complete"
        finally:
            await api.close()
    asyncio.run(run())


def test_missing_as_shot_rejects_reset_without_guess_or_pending_save(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                commands = list(children[0].commands)
                for kind, metadata in [("controlReset", {"control": "wb.temp"}), ("controlReset", {"control": "wb.tint"}),
                                       ("sectionReset", {"section": "color"}), ("allReset", {})]:
                    response = await http.post(url(doc, "operate"), json=body(doc) | {"kind": kind, "metadata": metadata})
                    assert response.status_code == 400 and response.json()["code"] == "raw_wb_unavailable"
                    assert children[0].commands == commands and api._history_save["stage"] == "complete"
        finally:
            await api.close()
    asyncio.run(run())


def test_two_command_reset_reaches_but_never_exceeds_hard_mutation_budget(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                api.raw._edits = 254
                doc = await edit(http, doc, "sectionReset", {"section": "color"})
                assert doc["mutationAttempts"] == 256 and doc["history"]["length"] == 1
                response = await http.post(url(doc, "operate"), json=body(doc) | {"kind": "sectionToggle", "metadata": {"section": "light", "enabled": False}})
                assert response.json()["code"] == "raw_session_edit_limit" and api.raw.status().edits == 256
                api._history_save = None
        finally:
            await api.close()
    asyncio.run(run())


def test_full_history_page_with_repeated_all_reset_deltas_stays_bounded(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [4875.123456789, 13.123456789]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                values = {control: -1.234567891234567 for control in doc["values"]}
                values["wb.temp"] = 23456.123456789
                for _ in range(10):
                    doc = await patch(http, doc, values)
                    doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "light.exposure"}})
                    doc = await edit(http, doc, "allReset", {})
                response = await http.get(url(doc), headers=headers(doc))
                assert response.status_code == 200 and len(response.content) <= 16384
                steps = response.json()["steps"]
                assert len(steps) == 20 and all(len(step["changes"]) == 10 for step in steps[1::2])
        finally:
            await api.close()
    asyncio.run(run())
