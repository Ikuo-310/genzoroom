import asyncio
import copy

import pytest

import raw_recipe_store as store
from raw_controls import CONTROLS, CONTROL_PATHS
from tests.test_windows_local import client, local
from tests.test_windows_raw_api import setup
from tests.test_raw_category_operations import edit, open_history, patch
from tests.test_raw_history_api import body, operation, url
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset


OPTICS_NUMERIC = tuple(control for control in CONTROLS if control.startswith("optics."))
OPTICS_FLAGS = ("optics.remove_ca", "optics.lens_profile")


@pytest.mark.parametrize("control", OPTICS_NUMERIC)
def test_optics_numeric_history_reset_undo_redo_jump_and_session_restore(local, tmp_path, monkeypatch, control):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                minimum, maximum, step, default, _ = CONTROLS[control]
                value = default + step if default + step <= maximum else default - step
                doc = await patch(http, doc, {control: value})
                doc = await operation(http, doc, "commit", body(doc) | {
                    "kind": "control", "metadata": {"control": control}})
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page["steps"][-1]["changes"] == [{"control": control, "before": default, "after": value}]
                assert children[0].photos[children[0].active]["settings"]["optics"][CONTROL_PATHS[control][1]] == value

                step_id = doc["history"]["selectedStepId"]
                doc = await operation(http, doc, "undo")
                assert doc["values"][control] == default
                doc = await operation(http, doc, "redo")
                assert doc["values"][control] == value
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": None})
                assert doc["values"][control] == default
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": step_id})
                assert doc["values"][control] == value

                doc = await edit(http, doc, "controlReset", {"control": control})
                assert doc["values"][control] == default
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page["steps"][-1]["changes"] == [{"control": control, "before": value, "after": default}]
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc["assetId"])
                assert response.status_code == 200, response.text
                restored = await operation(http, response.json(), "undo")
                assert restored["values"][control] == value
                assert children[-1].photos[children[-1].active]["settings"]["optics"][CONTROL_PATHS[control][1]] == value
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("control", OPTICS_FLAGS)
def test_optics_boolean_history_preserves_bool_type_and_reset(local, tmp_path, monkeypatch, control):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        field = CONTROL_PATHS[control][1]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await edit(http, doc, "opticsFlag", {"control": control, "enabled": True})
                assert doc["opticsFlags"][field] is True
                assert any(command[0] == "develop.merge" for command in children[0].commands)
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page["steps"][-1]["changes"] == []
                assert page["steps"][-1]["flagChanges"] == [{"control": control, "before": False, "after": True}]
                step_id = doc["history"]["selectedStepId"]
                doc = await operation(http, doc, "undo")
                assert doc["opticsFlags"][field] is False
                doc = await operation(http, doc, "redo")
                assert doc["opticsFlags"][field] is True
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": None})
                assert doc["opticsFlags"][field] is False
                doc = await operation(http, doc, "jump", body(doc) | {"targetStepId": step_id})
                assert doc["opticsFlags"][field] is True
                doc = await edit(http, doc, "opticsFlagReset", {"control": control})
                assert doc["opticsFlags"][field] is False
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page["steps"][-1]["flagChanges"] == [{"control": control, "before": True, "after": False}]
        finally:
            await api.close()
    asyncio.run(run())


def test_optics_flag_readback_mismatch_does_not_append_history(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                child.optics_mismatch = True
                response = await http.post(url(doc, "operate"), json=body(doc) | {"kind": "opticsFlag",
                    "metadata": {"control": "optics.remove_ca", "enabled": True}})
                assert response.status_code >= 500
                history = store.get_raw_history(api._history_identity)["history"]
                assert history["cursor"] == 0 and history["steps"] == []
        finally:
            # This deliberately leaves the operation result unknown; teardown must not checkpoint it.
            api._history_save = None
            await api.close()
    asyncio.run(run())


def test_optics_section_toggle_reset_all_reset_and_recipe_restore(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = [5500., 0.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                before = copy.deepcopy(children[0].photos[children[0].active]["settings"])
                control = "optics.distortion"
                doc = await patch(http, doc, {control: 25})
                doc = await operation(http, doc, "commit", body(doc) | {
                    "kind": "control", "metadata": {"control": control}})
                for flag in OPTICS_FLAGS:
                    doc = await edit(http, doc, "opticsFlag", {"control": flag, "enabled": True})
                retained_values, retained_flags = copy.deepcopy(doc["values"]), copy.deepcopy(doc["opticsFlags"])

                doc = await edit(http, doc, "sectionToggle", {"section": "optics", "enabled": False})
                assert not doc["sections"]["optics"]
                assert doc["values"] == retained_values and doc["opticsFlags"] == retained_flags
                doc = await operation(http, doc, "undo")
                assert doc["sections"]["optics"]
                doc = await operation(http, doc, "redo")
                assert not doc["sections"]["optics"]
                doc = await edit(http, doc, "sectionToggle", {"section": "optics", "enabled": True})

                doc = await edit(http, doc, "sectionReset", {"section": "optics"})
                assert all(doc["values"][control_id] == spec[3] for control_id, spec in CONTROLS.items()
                           if control_id.startswith("optics."))
                assert doc["opticsFlags"] == {"remove_ca": False, "lens_profile": False}
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert {item["control"] for item in page["steps"][-1]["changes"]} == {control}
                assert {item["control"] for item in page["steps"][-1]["flagChanges"]} == set(OPTICS_FLAGS)
                doc = await operation(http, doc, "undo")
                assert doc["values"][control] == 25 and doc["opticsFlags"] == retained_flags
                doc = await operation(http, doc, "redo")
                assert doc["values"][control] == 0 and doc["opticsFlags"] == {"remove_ca": False, "lens_profile": False}

                # All Reset includes Optics while retaining its existing reset command boundary.
                doc = await patch(http, doc, {control: 25})
                doc = await operation(http, doc, "commit", body(doc) | {
                    "kind": "control", "metadata": {"control": control}})
                doc = await edit(http, doc, "opticsFlag", {"control": OPTICS_FLAGS[0], "enabled": True})
                doc = await edit(http, doc, "allReset", {})
                assert doc["values"][control] == 0
                assert doc["opticsFlags"] == {"remove_ca": False, "lens_profile": False}
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert len(page["steps"][-1]["flagChanges"]) == 1
                assert children[-1].photos[children[-1].active]["settings"]["optics"] == before["optics"]

                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc["assetId"])
                assert response.status_code == 200, response.text
                restored = await operation(http, response.json(), "initialize")
                assert restored["values"][control] == 0
                assert restored["opticsFlags"] == {"remove_ca": False, "lens_profile": False}
                assert children[-1].photos[children[-1].active]["settings"]["optics"] == before["optics"]
        finally:
            await api.close()
    asyncio.run(run())


def test_legacy_recipe_engine_view_supplies_optics_defaults_without_mutating_storage():
    from lightcraft_raw import _settings_json

    legacy = {"version": 1, "process": 2, "wb": {"mode": "custom", "temp": 6500, "tint": 0}}
    stored = store._settings_json(legacy, 1)
    restored = __import__("json").loads(_settings_json(legacy))
    assert "optics" not in __import__("json").loads(stored)
    assert restored["optics"]["lens_profile"] is False
    assert restored["optics"]["profile_distortion"] == 100
