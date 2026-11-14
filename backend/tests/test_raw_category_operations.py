import asyncio
import json
import copy

import pytest

import raw_recipe_store as store
from raw_controls import CONTROLS, control_location
from edit_store import StoreUnavailable
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document, preview_body
from tests.test_raw_recipe_api import headers
from tests.test_raw_controls import identity
from tests.test_raw_history_api import url, body, operation, recover, rows
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


def point_colors(settings):
    return settings["point_colors"]


def point_color_mutations(commands):
    return [(command, params) for command, params in commands if command in ("pointColor.pick", "pointColor.delete")
        or command == "develop.set" and params.get("control", "").startswith("pointColor.")
        or command == "develop.resetControl" and params.get("control", "").startswith("pointColor.")
        or command == "develop.merge" and params.get("settings") == {"point_colors": []}]


@pytest.mark.parametrize("channel", ["master", "red", "green", "blue"])
def test_point_curve_is_one_history_operation_with_snapshot_navigation(channel, local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                native_before = copy.deepcopy(children[0].photos[children[0].active]["settings"])
                channel_points = [[0, 0], [0.4, 0.7], [1, 1]]
                request = body(doc) | {"kind": "curve", "metadata": {"channel": channel}, "curvePoints": channel_points}
                result = await operation(http, doc, "operate", request)
                assert result["history"]["length"] == 1
                commands = list(children[0].commands)
                replay = await operation(http, doc, "operate", request)
                assert replay["replayed"] and replay["history"]["length"] == 1
                assert children[0].commands == commands
                no_op = await operation(http, result, "operate", body(result) | {"kind": "curve",
                    "metadata": {"channel": channel}, "curvePoints": channel_points})
                assert no_op["history"]["length"] == 1 and no_op["ack"]["changed"] is False
                step = rows()["asset_raw_history_steps"][0]
                metadata = json.loads(step[9])
                assert metadata == {"channel": channel}
                native_after = children[0].photos[children[0].active]["settings"]
                assert native_after["curve"][channel] == [{"x": x, "y": y} for x, y in channel_points]
                for other in ("master", "red", "green", "blue"):
                    if other != channel:
                        assert native_after["curve"][other] == native_before["curve"][other]
                for field in ("highlights", "lights", "darks", "shadows", "split_shadows", "split_mid",
                              "split_highlights", "refine_saturation"):
                    assert native_after["curve"][field] == native_before["curve"][field]
                undo = await operation(http, no_op, "undo")
                assert children[0].photos[children[0].active]["settings"]["curve"] == native_before["curve"]
                redo = await operation(http, undo, "redo")
                assert children[0].photos[children[0].active]["settings"]["curve"][channel] == native_after["curve"][channel]
                jump = await operation(http, redo, "jump", body(redo) | {"targetStepId": None})
                assert children[0].photos[children[0].active]["settings"]["curve"] == native_before["curve"]
                assert jump["history"]["cursor"] == 0
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("channel", ["master", "red", "green", "blue", "point"])
def test_point_curve_reset_is_one_history_operation(channel, local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                commands = list(children[0].commands)
                noop = await operation(http, doc, "operate", body(doc) | {"kind": "curveReset", "metadata": {"channel": "red"}})
                assert noop["history"]["length"] == 0 and noop["ack"]["changed"] is False
                assert not any(command == "curve.reset" for command, _ in children[0].commands[len(commands):])
                doc = noop

                seed_points = {name: [[0, 0], [0.4, 0.6], [1, 1]] for name in ("master", "red", "green", "blue")}
                for name, points in seed_points.items():
                    doc = await operation(http, doc, "operate", body(doc) | {"kind": "curve",
                        "metadata": {"channel": name}, "curvePoints": points})
                before = copy.deepcopy(children[0].photos[children[0].active]["settings"])
                before_length = doc["history"]["length"]
                last_seed_step = doc["ack"]["stepId"]
                request = body(doc) | {"kind": "curveReset", "metadata": {"channel": channel}}
                commands = list(children[0].commands)
                reset = await operation(http, doc, "operate", request)
                assert reset["history"]["length"] == before_length + 1
                assert [command for command, _ in children[0].commands[len(commands):] if command == "curve.reset"] == ["curve.reset"]
                assert ("curve.reset", {"channel": channel}) in children[0].commands
                step = rows()["asset_raw_history_steps"][-1]
                assert step[8] == "curveReset" and json.loads(step[9]) == {"channel": channel}

                after = children[0].photos[children[0].active]["settings"]
                expected = copy.deepcopy(before)
                targets = ("master", "red", "green", "blue") if channel == "point" else (channel,)
                for target in targets:
                    expected["curve"][target] = []
                assert after == expected

                replay_commands = list(children[0].commands)
                replay = await operation(http, doc, "operate", request)
                assert replay["replayed"] and replay["history"]["length"] == before_length + 1
                assert children[0].commands == replay_commands
                no_op = await operation(http, reset, "operate", body(reset) | {"kind": "curveReset",
                    "metadata": {"channel": channel}})
                assert no_op["history"]["length"] == before_length + 1 and no_op["ack"]["changed"] is False

                undo = await operation(http, no_op, "undo")
                assert children[0].photos[children[0].active]["settings"] == before
                redo = await operation(http, undo, "redo")
                assert children[0].photos[children[0].active]["settings"] == expected
                jump = await operation(http, redo, "jump", body(redo) | {"targetStepId": last_seed_step})
                assert children[0].photos[children[0].active]["settings"] == before
                assert jump["history"]["cursor"] == before_length
        finally:
            await api.close()
    asyncio.run(run())


def test_point_curve_reset_rejects_all_without_native_mutation(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                commands = list(children[0].commands)
                response = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "curveReset", "metadata": {"channel": "all"}})
                assert response.status_code == 400
                assert not any(command == "curve.reset" for command, _ in children[0].commands[len(commands):])
                assert store.get_raw_history(api._history_identity)["history"]["steps"] == []
        finally:
            await api.close()
    asyncio.run(run())


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
    "light.shadows", "light.blacks", "color.vibrance", "color.saturation", "wb.temp", "wb.tint",
    "detail.sharpenAmount", "detail.sharpenMasking", "detail.nrLuminance", "detail.nrDetail",
    "detail.nrColor", "detail.nrColorDetail", "detail.nrColorSmoothness"])
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
                section = "light" if control.startswith("light.") else "detail" if control.startswith("detail.") else "color"
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
                    assert result["values"][control] == (50 if control in ('detail.nrDetail', 'detail.nrColorDetail', 'detail.nrColorSmoothness') else 0)
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
    ("sectionReset", {"section": "color"}, 2), ("sectionReset", {"section": "mixer"}, 1), ("allReset", {}, 3)])
def test_compound_reset_keeps_bypass_one_step_and_reopens(local, tmp_path, monkeypatch, kind, metadata, cost):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {"light.exposure": 1., "wb.temp": 11000., "wb.tint": 26.,
                    "color.vibrance": 15., "mixer.red.hue": 24., "mixer.blue.sat": -37.})
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
                commands_before_reset = list(children[0].commands)
                doc = await edit(http, doc, kind, metadata)
                assert doc["history"]["length"] == before["history"]["length"] + 1
                assert doc["sections"] == {"light": False, "color": False, "grading": True, "effects": True,
                                            "detail": False, "optics": True}
                actual = store.get_raw_history(api._history_identity)["recipe"]["settings"]
                assert actual["disabled_sections"] == before_settings["disabled_sections"]
                if kind == "sectionReset":
                    assert actual["curve"] == before_settings["curve"]
                    if metadata.get("section") == "color":
                        assert actual["mixer"] == before_settings["mixer"]
                    if metadata.get("section") == "mixer":
                        expected_settings = copy.deepcopy(before_settings)
                        for channels in expected_settings["mixer"].values():
                            for field in ("hue", "sat", "lum"):
                                channels[field] = 0.
                        assert actual == expected_settings
                        reset_commands = children[0].commands[len(commands_before_reset):]
                        assert reset_commands.count(("develop.resetSection", {"section": "mixer"})) == 1
                        assert api.raw.status().edits - attempts == cost
                        history_length = doc["history"]["length"]
                        doc = await edit(http, doc, kind, metadata)
                        assert doc["history"]["length"] == history_length and doc["ack"]["changed"] is False
                if metadata.get("section") != "mixer":
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


@pytest.mark.parametrize("kind,raw_wb", [("wbReset", True), ("wbReset", False),
    ("colorReset", True), ("colorReset", False)])
def test_wb_and_color_reset_use_one_history_step_and_restore_exact_scope(local, tmp_path, monkeypatch, kind, raw_wb):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.as_shot_wb = [4875., 13.] if raw_wb else None
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                legacy_settings = {"disabled_sections": ["grading"]}
                if not raw_wb:
                    legacy_settings["wb"] = {"scale": "legacy"}
                await api.raw.merge_settings(api._raw_handle, legacy_settings, doc["revision"])
                identity_body = {key: doc[key] for key in ("workspaceId", "generation", "documentToken")}
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity_body)).json()
                doc = await operation(http, doc, "initialize")
                doc = await edit(http, doc, "sectionToggle", {"section": "color", "enabled": False})
                assert store.get_raw_history(api._history_identity)["recipe"]["settings"]["disabled_sections"] == ["grading", "color"]
                doc = await edit(http, doc, "sectionToggle", {"section": "color", "enabled": True})
                assert store.get_raw_history(api._history_identity)["recipe"]["settings"]["disabled_sections"] == ["grading"]
                values = {"wb.temp": 11000., "wb.tint": 26., "light.exposure": 1.25,
                    "color.vibrance": 31., "color.saturation": -17., "mixer.red.hue": 24.,
                    "mixer.blue.sat": -37., "grading.shadows.hue": 120., "grading.midtones.lum": -22.,
                    "grading.highlights.sat": 45., "grading.blending": 63., "grading.balance": -15.}
                doc = await patch(http, doc, values)
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "mixer.red.hue"}})
                before_settings = copy.deepcopy(store.get_raw_history(api._history_identity)["recipe"]["settings"])
                before_length = doc["history"]["length"]
                reset = await edit(http, doc, kind, {})
                assert reset["history"]["length"] == before_length + 1
                saved = store.get_raw_history(api._history_identity)
                after = saved["recipe"]["settings"]
                expected = copy.deepcopy(before_settings)
                if kind == "colorReset":
                    for control, spec in CONTROLS.items():
                        if control.startswith(("color.", "mixer.", "grading.")):
                                group, key = control_location(expected, control)
                                group[key] = spec[3]
                if raw_wb:
                    expected["wb"].update(mode="asShot", temp=4875., tint=13., scale="kelvin")
                    assert reset["wb"] == {"available": True, "mode": "asShot", "scale": "kelvin"}
                else:
                    expected["wb"]["temp"], expected["wb"]["tint"] = 6500., 0.
                    assert reset["wb"]["scale"] == "legacy"
                    assert (reset["values"]["wb.temp"], reset["values"]["wb.tint"]) == (6500., 0.)
                assert after == expected
                step = (await http.get(url(reset), headers=headers(reset))).json()["steps"][-1]
                changed_controls = {control for control in CONTROLS
                    if control.startswith(("wb.", "color.", "mixer.", "grading."))
                    and control_location(before_settings, control)[0][control_location(before_settings, control)[1]]
                    != control_location(expected, control)[0][control_location(expected, control)[1]]}
                assert {change["control"] for change in step["changes"]} == changed_controls
                assert after["light"]["exposure"] == before_settings["light"]["exposure"]
                assert after["disabled_sections"] == before_settings["disabled_sections"]
                undo = await operation(http, reset, "undo")
                assert store.get_raw_history(api._history_identity)["recipe"]["settings"] == before_settings
                redo = await operation(http, undo, "redo")
                assert store.get_raw_history(api._history_identity)["recipe"]["settings"] == expected
                length = redo["history"]["length"]
                noop = await edit(http, redo, kind, {})
                assert noop["history"]["length"] == length and noop["ack"]["changed"] is False
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind", ["wbReset", "colorReset"])
def test_color_reset_failure_rolls_back_and_retries_the_same_operation(local, tmp_path, monkeypatch, kind):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {"wb.temp": 11000., "wb.tint": 26., "color.vibrance": 35.,
                    "mixer.red.hue": 20., "grading.shadows.hue": 120.})
                doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "mixer.red.hue"}})
                before_history = store.get_raw_history(api._history_identity)
                before_native = copy.deepcopy(child.photos[child.active]["settings"])
                request = body(doc) | {"kind": kind, "metadata": {}}
                child.fail_commands = {"develop.wb"}
                failed = await http.post(url(doc, "operate"), json=request)
                assert failed.status_code >= 500
                assert store.get_raw_history(api._history_identity) == before_history
                assert child.photos[child.active]["settings"] == before_native
                assert api.raw.status().state == "synced"
                child.fail_commands.clear()
                retried = await operation(http, doc, "operate", request)
                assert retried["history"]["length"] == doc["history"]["length"] + 1
                assert retried["history"]["selectedStepId"] == retried["ack"]["stepId"]
        finally:
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
    ("controlReset", {"control": "hdr.maxEv"}), ("sectionToggle", {"section": "enhance", "enabled": False}),
    ("sectionToggle", {"section": "color", "enabled": 0}), ("allReset", {"settings": {}}),
    ("pointColorPick", {"x": .25}), ("pointColorDelete", {"index": -1}),
    ("pointColorControl", {"control": "pointColor.0.hueShift"}),
    ("pointColorControlReset", {"control": "pointColor.0.unknown"}), ("pointColorReset", {"extra": 0})])
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


def test_point_color_history_api_persists_all_five_operations_and_noops(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                recipe_identity = api._history_identity

                first_request = body(doc) | {"kind": "pointColorPick", "metadata": {"x": .125, "y": .625}}
                doc = await operation(http, doc, "operate", first_request)
                duplicate_request = body(doc) | {"kind": "pointColorPick", "metadata": {"y": .625, "x": .125}}
                doc = await operation(http, doc, "operate", duplicate_request)
                expected_duplicate = point_colors(store.get_raw_recipe(recipe_identity)["recipe"]["settings"])
                assert len(expected_duplicate) == 2 and expected_duplicate[0] == expected_duplicate[1]
                assert doc["history"]["length"] == 2

                command_snapshot = list(children[0].commands)
                saved_rows = rows()
                replay = await operation(http, doc, "operate", duplicate_request)
                assert replay["replayed"] and children[0].commands == command_snapshot and rows() == saved_rows
                altered = duplicate_request | {"metadata": {"x": .25, "y": .625}}
                rejected = await http.post(url(doc, "operate"), json=altered)
                assert rejected.status_code == 409 and rejected.json()["code"] == "raw_history_save_id_reused"
                assert children[0].commands == command_snapshot and rows() == saved_rows

                doc = await edit(http, doc, "pointColorDelete", {"index": 0})
                assert len(point_colors(store.get_raw_recipe(recipe_identity)["recipe"]["settings"])) == 1
                doc = await edit(http, doc, "pointColorControl",
                    {"control": "pointColor.0.hueShift", "value": -12.375})
                settings = store.get_raw_recipe(recipe_identity)["recipe"]["settings"]
                assert point_colors(settings)[0]["hue_shift"] == -12.375
                before_noop = len(rows()["asset_raw_history_steps"])
                before_revision, before_cursor = doc["recipeRevision"], doc["history"]["cursor"]
                native_commands = list(children[0].commands)
                noop_request = body(doc) | {"kind": "pointColorControl",
                    "metadata": {"control": "pointColor.0.hueShift", "value": -12.375}}
                doc = await operation(http, doc, "operate", noop_request)
                assert doc["ack"]["changed"] is False
                assert doc["recipeRevision"] == before_revision + 1 and doc["history"]["cursor"] == before_cursor
                assert len(rows()["asset_raw_history_steps"]) == before_noop
                assert point_color_mutations(children[0].commands) == point_color_mutations(native_commands)
                noop_rows = rows()
                replay = await operation(http, doc, "operate", noop_request)
                assert replay["replayed"] and replay["recipeRevision"] == doc["recipeRevision"]
                assert rows() == noop_rows
                doc = replay

                doc = await edit(http, doc, "pointColorControlReset", {"control": "pointColor.0.hueShift"})
                assert point_colors(store.get_raw_recipe(recipe_identity)["recipe"]["settings"])[0]["hue_shift"] == 0.
                before_noop = len(rows()["asset_raw_history_steps"])
                native_commands = list(children[0].commands)
                doc = await edit(http, doc, "pointColorControlReset", {"control": "pointColor.0.hueShift"})
                assert doc["ack"]["changed"] is False
                assert len(rows()["asset_raw_history_steps"]) == before_noop
                assert point_color_mutations(children[0].commands) == point_color_mutations(native_commands)

                doc = await edit(http, doc, "pointColorReset", {})
                assert point_colors(store.get_raw_recipe(recipe_identity)["recipe"]["settings"]) == []
                before_noop = len(rows()["asset_raw_history_steps"])
                native_commands = list(children[0].commands)
                doc = await edit(http, doc, "pointColorReset", {})
                assert doc["ack"]["changed"] is False
                assert len(rows()["asset_raw_history_steps"]) == before_noop
                assert point_color_mutations(children[0].commands) == point_color_mutations(native_commands)

                history = store.get_raw_history(recipe_identity)["history"]
                recipe = store.get_raw_recipe(recipe_identity)["recipe"]["settings"]
                assert history["steps"][-1]["settings"] == recipe
                assert [step["kind"] for step in history["steps"]] == ["pointColorPick", "pointColorPick",
                    "pointColorDelete", "pointColorControl", "pointColorControlReset", "pointColorReset"]
                assert history["steps"][0]["metadata"] == {"x": .125, "y": .625}
                assert history["steps"][3]["metadata"] == {"control": "pointColor.0.hueShift", "value": -12.375}
                listing = (await http.get(url(doc), headers=headers(doc))).json()
                assert [step["kind"] for step in listing["steps"]] == [step["kind"] for step in history["steps"]]
                assert listing["steps"][3]["metadata"] == history["steps"][3]["metadata"]
                assert doc["nativeMatchesRecipe"]
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind,metadata", [
    ("pointColorPick", {"x": .375, "y": .625}),
    ("pointColorDelete", {"index": 0}),
])
@pytest.mark.parametrize("failure", ["before_commit", "after_commit"])
def test_point_color_save_failure_retries_without_repeating_native_mutation(
        local, tmp_path, monkeypatch, kind, metadata, failure):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        writer = store.append_raw_history
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                if kind == "pointColorDelete":
                    doc = await edit(http, doc, "pointColorPick", {"x": .375, "y": .625})
                request = body(doc) | {"kind": kind, "metadata": metadata}
                before = rows()
                def fail_at_save(*args, **kwargs):
                    if failure == "before_commit":
                        raise StoreUnavailable()
                    writer(*args, **kwargs)
                    raise StoreUnavailable()
                monkeypatch.setattr(store, "append_raw_history", fail_at_save)
                failed = await http.post(url(doc, "operate"), json=request)
                assert failed.status_code == 503 and failed.json()["code"] == "raw_history_save_failed"
                assert api._history_save["stage"] == "save"
                assert (rows() == before) is (failure == "before_commit")
                native_command = "pointColor.pick" if kind == "pointColorPick" else "pointColor.delete"
                assert sum(command == native_command for command, _ in children[0].commands) == 1

                blocked = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "pointColorPick", "metadata": {"x": .5, "y": .5}})
                assert blocked.status_code == 409 and blocked.json()["code"] == "raw_history_save_pending"
                other_metadata = ({"x": .375, "y": .5} if kind == "pointColorPick" else {"index": 1})
                reused = await http.post(url(doc, "operate"), json=request | {"metadata": other_metadata})
                assert reused.status_code == 409 and reused.json()["code"] == "raw_history_save_id_reused"
                assert sum(command == native_command for command, _ in children[0].commands) == 1

                monkeypatch.setattr(store, "append_raw_history", writer)
                saved = await http.post(url(doc, "operate"), json=request)
                assert saved.status_code == 200, saved.text
                result = saved.json()
                assert result["replayed"] is (failure == "after_commit")
                assert result["history"]["length"] == (2 if kind == "pointColorDelete" else 1)
                assert result["nativeMatchesRecipe"]
                assert sum(command == native_command for command, _ in children[0].commands) == 1
                recipe = store.get_raw_recipe(api._history_identity)["recipe"]["settings"]
                history = store.get_raw_history(api._history_identity)["history"]
                assert recipe["point_colors"] == history["steps"][-1]["settings"]["point_colors"]
                assert history["steps"][-1]["kind"] == kind
                assert history["steps"][-1]["metadata"] == metadata
        finally:
            monkeypatch.setattr(store, "append_raw_history", writer)
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind", ["pointColorPick", "pointColorDelete"])
@pytest.mark.parametrize("fault", ["unknown_after_mutation", "readback_failure", "readback_mismatch"])
def test_point_color_uncertain_native_result_retains_history_owner_without_retry(
        local, tmp_path, monkeypatch, kind, fault):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                if kind == "pointColorDelete":
                    doc = await edit(http, doc, "pointColorPick", {"x": .2, "y": .4})
                    doc = await edit(http, doc, "pointColorPick", {"x": .6, "y": .8})
                child.point_mutated = False
                if fault == "unknown_after_mutation":
                    if kind == "pointColorPick":
                        child.point_pick_fault = fault
                    else:
                        child.point_delete_fault = fault
                elif fault == "readback_failure":
                    child.fail_get_after_point_mutation = True
                elif kind == "pointColorPick":
                    child.point_pick_fault = "readback_count"
                else:
                    child.point_delete_fault = "readback_mismatch"
                native_command = "pointColor.pick" if kind == "pointColorPick" else "pointColor.delete"
                metadata = {"x": .375, "y": .625} if kind == "pointColorPick" else {"index": 0}
                request = body(doc) | {"kind": kind, "metadata": metadata}
                failed = await http.post(url(doc, "operate"), json=request)
                assert failed.status_code >= 500
                assert api._history_save["stage"] == "applying"
                assert api.raw.status().state in ("lost", "desynchronized")
                assert sum(command == native_command for command, _ in child.commands) == 1

                retry = await http.post(url(doc, "operate"), json=request)
                assert retry.status_code == 409 and retry.json()["code"] == "raw_history_operation_outcome_unknown"
                assert sum(command == native_command for command, _ in child.commands) == 1
                blocked = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "pointColorPick", "metadata": {"x": .5, "y": .5}})
                assert blocked.status_code == 409 and blocked.json()["code"] == "raw_history_save_pending"
                assert api._history_save["stage"] == "applying"
                child.point_pick_fault = None
                child.point_delete_fault = None
                child.fail_get_after_point_mutation = False
                recovered = await recover(http, api, doc)
                assert recovered["nativeMatchesRecipe"] and not recovered["historyPending"]
                assert api._history_save is None
                expected_count = 0 if kind == "pointColorPick" else 2
                assert len(store.get_raw_recipe(api._history_identity)["recipe"]["settings"]["point_colors"]) == expected_count
                assert sum(command == native_command for command, _ in child.commands) == 1
        finally:
            api._history_save = None
            api._history_initialized = api._history_enabled = False
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind,metadata", [
    ("pointColorDelete", {"index": 0}),
    ("pointColorControl", {"control": "pointColor.0.hueShift", "value": 1.5}),
])
def test_point_color_native_snapshot_rejection_clears_unmutated_history_owner(
        local, tmp_path, monkeypatch, kind, metadata):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                request = body(doc) | {"kind": kind, "metadata": metadata}
                response = await http.post(url(doc, "operate"), json=request)
                assert response.status_code == 400, response.text
                assert response.json()["code"] in ("raw_invalid_point_color_index", "raw_invalid_point_color_control")
                assert api._history_save is None
                assert not any(command in ("pointColor.pick", "pointColor.delete") or
                    command == "develop.set" and params.get("control", "").startswith("pointColor.")
                    for command, params in children[0].commands)
                result = await edit(http, doc, "pointColorPick", {"x": .25, "y": .75})
                assert result["history"]["length"] == 1
        finally:
            await api.close()
    asyncio.run(run())


def test_point_color_eight_entry_limit_is_enforced_through_history_api(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                for _ in range(8):
                    doc = await edit(http, doc, "pointColorPick", {"x": .25, "y": .75})
                response = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "pointColorPick", "metadata": {"x": .25, "y": .75}})
                assert response.status_code == 400 and response.json()["code"] == "raw_point_color_limit"
                assert sum(command == "pointColor.pick" for command, _ in children[0].commands) == 8
                assert api._history_save is None
                assert len(store.get_raw_recipe(api._history_identity)["recipe"]["settings"]["point_colors"]) == 8
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("extra", [{"curvePoints": []}, {"mixerInteractionId": "0" * 32}])
def test_point_color_history_api_rejects_unrelated_payload_without_native_or_store_change(
        local, tmp_path, monkeypatch, extra):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                before_rows = rows()
                before_commands = list(children[0].commands)
                response = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "pointColorPick", "metadata": {"x": .25, "y": .75}} | extra)
                assert response.status_code == 400 and response.json()["code"] == "raw_invalid_request"
                assert rows() == before_rows and children[0].commands == before_commands
                assert api._history_save["stage"] == "complete"
        finally:
            await api.close()
    asyncio.run(run())


def test_point_color_history_api_rejects_stale_document_revision_before_native_mutation(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                request = body(doc) | {"kind": "pointColorPick", "metadata": {"x": .25, "y": .75}}
                request["documentRevision"] += 1
                before_commands, before_rows = list(children[0].commands), rows()
                response = await http.post(url(doc, "operate"), json=request)
                assert response.status_code == 409 and response.json()["code"] == "raw_revision_conflict"
                assert children[0].commands == before_commands and rows() == before_rows
                assert api._history_save["stage"] == "complete"
        finally:
            await api.close()
    asyncio.run(run())


def test_point_color_history_operation_respects_mixer_interaction_owner(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].adaptive_supported = True
        children[0].frame_supported = False
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                mixer_url = f'/api/raw/documents/{doc["handle"]}/mixer-interaction'
                identity_body = identity(doc) | {"documentRevision": doc["revision"]}
                started = await http.post(f"{mixer_url}/begin", json=identity_body | {
                    "target": "hue", "x": .25, "y": .75})
                assert started.status_code == 200, started.text
                interaction_id = started.json()["interactionId"]
                commands = list(children[0].commands)
                rejected = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "pointColorReset", "metadata": {}})
                assert rejected.status_code == 409 and rejected.json()["code"] == "raw_mixer_interaction_pending"
                assert api._history_save is None
                assert not any(command == "develop.merge" and params.get("settings") == {"point_colors": []}
                    for command, params in children[0].commands[len(commands):])
                cancelled = await http.post(f"{mixer_url}/cancel", json=identity_body | {
                    "interactionId": interaction_id})
                assert cancelled.status_code == 204

                curve_url = f'/api/raw/documents/{doc["handle"]}/curve-interaction'
                curve_started = await http.post(f"{curve_url}/begin", json=identity_body | {
                    "channel": "master", "mode": "targeted"})
                assert curve_started.status_code == 200, curve_started.text
                curve_id = curve_started.json()["interactionId"]
                rejected = await http.post(url(doc, "operate"), json=body(doc) | {
                    "kind": "pointColorReset", "metadata": {}})
                assert rejected.status_code == 409 and rejected.json()["code"] == "raw_curve_interaction_pending"
                assert api._history_save is None
                cancelled = await http.post(f"{curve_url}/cancel", json=identity_body | {
                    "interactionId": curve_id})
                assert cancelled.status_code == 204
        finally:
            await api.close()
    asyncio.run(run())


def test_history_save_id_fingerprint_includes_operation_metadata(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                request = body(doc) | {"kind": "sectionToggle",
                    "metadata": {"section": "light", "enabled": False}}
                result = await operation(http, doc, "operate", request)
                durable = rows()
                commands = list(children[0].commands)
                changed_metadata = request | {"metadata": {"section": "color", "enabled": False}}
                response = await http.post(url(result, "operate"), json=changed_metadata)
                assert response.status_code == 409
                assert response.json()["code"] == "raw_history_save_id_reused"
                assert rows() == durable and children[0].commands == commands
        finally:
            await api.close()
    asyncio.run(run())


def test_missing_as_shot_uses_native_reset_without_blocking_wb_history(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                for kind, metadata in [("controlReset", {"control": "wb.temp"}), ("controlReset", {"control": "wb.tint"}),
                                       ("sectionReset", {"section": "color"}), ("allReset", {})]:
                    response = await http.post(url(doc, "operate"), json=body(doc) | {"kind": kind, "metadata": metadata})
                    assert response.status_code == 200, response.text
                    doc = response.json()
                    assert api._history_save["stage"] == "complete"
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
                values = {control: -1.234567891234567 for control in doc["values"] if not control.startswith("optics.")}
                values["wb.temp"] = 23456.123456789
                values.update({"detail.sharpenAmount": 123.4567891234567, "detail.sharpenMasking": 98.7654321987654})
                values.update({control: 12.34567891234567 for control in values if control.startswith('grading.') and not control.endswith('.lum') and control != 'grading.balance' or control.startswith('detail.nr') or control in ('vignette.midpoint', 'vignette.feather', 'vignette.highlights')})
                for _ in range(10):
                    doc = await patch(http, doc, values)
                    doc = await operation(http, doc, "commit", body(doc) | {"kind": "control", "metadata": {"control": "light.exposure"}})
                    ack_bytes = len(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode())
                    assert 4096 < ack_bytes <= 16384
                    doc = await edit(http, doc, "allReset", {})
                response = await http.get(url(doc), headers=headers(doc))
                assert response.status_code == 200 and len(response.content) <= 256 * 1024
                print(f'History 20 steps / 60 controls: {len(response.content)} bytes; full-precision ack: {ack_bytes} bytes')
                steps = response.json()["steps"]
                assert len(steps) == 20 and all(len(step["changes"]) == 60 for step in steps[1::2])
        finally:
            await api.close()
    asyncio.run(run())
