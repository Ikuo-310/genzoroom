import asyncio
import copy
import json
from uuid import uuid4

import pytest

import raw_recipe_store
from edit_store import StoreUnavailable
from lightcraft_mcp import LightCraftError
from raw_edit_settings_copy import (COPY_SETTING_IDS, CROP_SETTING_ID, extract_copy_settings,
                                    validate_copy_payload)
from tests.test_lightcraft_raw import DEFAULT
from tests.test_raw_controls import identity, point_color
from tests.raw_document_helpers import change, headers
from tests.test_windows_local import authenticate, client, local
from tests.test_windows_raw_api import close_headers, open_document, setup


def history_body(doc, **fields):
    return identity(doc) | {"documentRevision": doc["revision"],
        "settingsFingerprint": doc["settingsFingerprint"], "expectedRecipeRevision": doc["recipeRevision"],
        "saveId": str(uuid4()), **fields}


def paste_body(doc, selected_ids, settings, *, source_asset_id=None, source_filename="source.jpg", save_id=None):
    return history_body(doc, saveId=str(save_id or uuid4()), kind="settingsPaste",
        metadata={"sourceAssetId": source_asset_id or str(uuid4()), "sourceFilename": source_filename,
                  "selectedIds": selected_ids,
                  "sourceWbMode": "absolute" if settings.get("wb", {}).get("scale") == "kelvin" else "relative"},
        copySettings=settings)


async def history_request(http, doc, action, request=None):
    response = await http.post(f'/api/raw/documents/{doc["handle"]}/history/{action}',
                               json=history_body(doc) if request is None else request)
    return response


async def initialize_history(http, doc):
    response = await history_request(http, doc, "initialize")
    assert response.status_code == 200, response.text
    return response.json()


async def commit_control(http, doc, control="light.exposure"):
    request = history_body(doc, kind="control", metadata={"control": control})
    response = await history_request(http, doc, "commit", request)
    assert response.status_code == 200, response.text
    return response.json()


def test_copy_payload_validation_reuses_p1a_allowlist_and_native_field_shapes():
    selected = sorted(COPY_SETTING_IDS - {CROP_SETTING_ID})
    source = copy.deepcopy(DEFAULT)
    source["point_colors"] = [point_color()]
    payload = extract_copy_settings(source, selected)
    assert validate_copy_payload(selected, payload) == payload

    for invalid in (
        payload | {"process": 1},
        {"light": {}},
        extract_copy_settings({"light": {"exposure": 9}}, ["basic.exposure"]),
        {"point_colors": [{"hue": 1}]},
        {"curve": {"master": [[0, 0]]}},
    ):
        ids = selected if "process" in invalid else ["basic.exposure"] if "light" in invalid else ["pointColor"] if "point_colors" in invalid else ["pointCurve"]
        with pytest.raises(LightCraftError):
            validate_copy_payload(ids, invalid)

    crop = extract_copy_settings(source, [CROP_SETTING_ID])
    assert validate_copy_payload([CROP_SETTING_ID], crop) == crop
    with pytest.raises(LightCraftError):
        validate_copy_payload(["basic.exposure"], {"light": {"exposure": 1}, "crop": crop["crop"]})
    with pytest.raises(LightCraftError):
        validate_copy_payload(["basic.exposure"], {"light": {"exposure": 1e100}})
    with pytest.raises(LightCraftError):
        validate_copy_payload(["pointColor"], {"point_colors": ["x" * 70_000]})


def test_history_settings_paste_uses_one_partial_merge_and_existing_undo_redo_recipe(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                workspace, doc = await open_document(http)
                baseline = {"optics": {"remove_ca": True, "lens_profile": True},
                    "disabled_sections": ["optics"],
                    "crop": {"geometry": {"rect": {"x0": .1, "y0": .15, "x1": .9, "y1": .85}, "angle": 2.5},
                             "aspect": None, "flip_h": False, "flip_v": False}}
                await api.raw.merge_settings(api._raw_handle, baseline, doc["revision"])
                refreshed = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert refreshed.status_code == 200
                doc = await initialize_history(http, refreshed.json())
                before = api.raw.confirmed_settings(api._raw_handle, doc["revision"]).settings

                source = copy.deepcopy(DEFAULT)
                source["light"]["exposure"] = 0.0
                source["optics"]["remove_ca"] = False
                source["optics"]["lens_profile"] = False
                source["profile"] = {"camera_local_tone": True}
                source["point_colors"] = []
                selected = ["basic.exposure", "lensCorrection", "chromaticAberration", "localToneMapping", "pointColor"]
                payload = extract_copy_settings(source, selected)
                before_merges = sum(command == "develop.merge" for command, _ in children[0].commands)
                request = paste_body(doc, selected, payload, source_asset_id=str(uuid4()), source_filename="portrait.jpg")
                response = await history_request(http, doc, "operate", request)
                assert response.status_code == 200, response.text
                result = response.json()
                assert sum(command == "develop.merge" for command, _ in children[0].commands) == before_merges + 1
                merge = [params for command, params in children[0].commands if command == "develop.merge"][-1]
                assert merge == {"settings": payload}
                actual = api.raw.confirmed_settings(api._raw_handle, result["revision"]).settings
                assert actual["light"]["exposure"] == 0.0
                assert actual["optics"]["remove_ca"] is False and actual["optics"]["lens_profile"] is False
                assert actual["profile"]["camera_local_tone"] is True
                assert actual["point_colors"] == []
                assert actual["optics"]["defringe_purple_amount"] == before["optics"]["defringe_purple_amount"]
                assert actual["disabled_sections"] == ["optics"]
                assert actual["crop"] == before["crop"] and actual["orientation"] == before["orientation"]

                history = await http.get(f'/api/raw/documents/{doc["handle"]}/history', headers=headers(doc))
                step = history.json()["steps"][-1]
                assert step["kind"] == "settingsPaste"
                assert step["metadata"] == request["metadata"]
                assert "copySettings" not in step["metadata"]
                assert step["flagChanges"] == [
                    {"control": "optics.lens_profile", "before": True, "after": False},
                    {"control": "optics.remove_ca", "before": True, "after": False},
                    {"control": "profile.camera_local_tone", "before": False, "after": True},
                ]
                assert len(history.json()["steps"]) == 1 and history.json()["history"]["cursor"] == 1

                crop_payload = extract_copy_settings(DEFAULT, [CROP_SETTING_ID])
                crop_request = paste_body(result, [CROP_SETTING_ID], crop_payload, source_filename="crop-source.jpg")
                cropped = await history_request(http, result, "operate", crop_request)
                assert cropped.status_code == 200, cropped.text
                crop_snapshot = api.raw.confirmed_settings(api._raw_handle, cropped.json()["revision"]).settings
                assert crop_snapshot["crop"] == DEFAULT["crop"]
                assert crop_snapshot["orientation"] == DEFAULT["orientation"]
                assert crop_snapshot["disabled_sections"] == ["optics"]
                history = await http.get(f'/api/raw/documents/{doc["handle"]}/history', headers=headers(cropped.json()))
                assert history.json()["steps"][-1]["metadata"]["selectedIds"] == [CROP_SETTING_ID]
                assert len(history.json()["steps"]) == 2

                undo = await history_request(http, cropped.json(), "undo")
                assert undo.status_code == 200 and undo.json()["history"]["cursor"] == 1
                assert undo.json()["settingsFingerprint"] == result["settingsFingerprint"]
                redo = await history_request(http, undo.json(), "redo")
                assert redo.status_code == 200 and redo.json()["history"]["cursor"] == 2
                assert redo.json()["settingsFingerprint"] == cropped.json()["settingsFingerprint"]
                closed = await http.delete(f'/api/raw/documents/{redo.json()["handle"]}',
                                           headers=close_headers(redo.json()))
                assert closed.status_code == 204
                reopened = await http.post("/api/raw/documents", json={"workspaceId": workspace,
                    "assetId": redo.json()["assetId"]})
                assert reopened.status_code == 200, reopened.text
                reopened_doc = reopened.json()
                assert reopened_doc["recipeStatus"] == "restored"
                reopened_history = await http.get(f'/api/raw/documents/{reopened_doc["handle"]}/history',
                                                  headers=headers(reopened_doc))
                assert reopened_history.status_code == 200
                assert reopened_history.json()["history"]["cursor"] == 2
                assert reopened_history.json()["history"]["length"] == 2
                assert (await http.delete(f'/api/raw/workspaces/{workspace}')).status_code == 204
        finally:
            await api.close()
    asyncio.run(run())


def test_noop_paste_keeps_redo_and_replayed_save_id_does_not_apply_again(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await initialize_history(http, doc)
                doc = await change(http, doc, 1.0)
                doc = await commit_control(http, doc)
                doc = await change(http, doc, 2.0)
                doc = await commit_control(http, doc)
                undo = await history_request(http, doc, "undo")
                assert undo.status_code == 200 and undo.json()["history"]["cursor"] == 1
                doc = undo.json()

                selected = ["basic.exposure"]
                payload = extract_copy_settings({"light": {"exposure": 1.0}}, selected)
                request = paste_body(doc, selected, payload, save_id=uuid4())
                before_merges = sum(command == "develop.merge" for command, _ in children[0].commands)
                pasted = await history_request(http, doc, "operate", request)
                assert pasted.status_code == 200 and pasted.json()["ack"]["changed"] is False
                assert pasted.json()["history"]["cursor"] == 1 and pasted.json()["history"]["length"] == 2
                assert sum(command == "develop.merge" for command, _ in children[0].commands) == before_merges

                replayed = await history_request(http, pasted.json(), "operate", request)
                assert replayed.status_code == 200 and replayed.json()["replayed"] is True
                assert sum(command == "develop.merge" for command, _ in children[0].commands) == before_merges

                redo = await history_request(http, replayed.json(), "redo")
                assert redo.status_code == 200 and redo.json()["history"]["cursor"] == 2
                assert redo.json()["values"]["light.exposure"] == 2.0
                history = await http.get(f'/api/raw/documents/{redo.json()["handle"]}/history', headers=headers(redo.json()))
                jump = await history_request(http, redo.json(), "jump", history_body(redo.json(),
                    targetStepId=history.json()["steps"][0]["stepId"]))
                assert jump.status_code == 200 and jump.json()["history"]["cursor"] == 1
                assert jump.json()["values"]["light.exposure"] == 1.0
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize(("source_mode", "target_mode", "allowed"), [
    ("absolute", "absolute", True), ("relative", "relative", True),
    ("absolute", "relative", False), ("relative", "absolute", False),
])
def test_paste_enforces_native_import_wb_mode(source_mode, target_mode, allowed, local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                photo = api.raw._photo(api._raw_handle, active=True)
                source_scale = "kelvin" if source_mode == "absolute" else "legacy"
                target_scale = "kelvin" if target_mode == "absolute" else "legacy"
                photo.import_settings_json = json.dumps({"wb": {"scale": target_scale}})
                api.document["sourceWbMode"] = target_mode
                doc["sourceWbMode"] = target_mode
                doc = await initialize_history(http, doc)
                selected = ["whiteBalance"]
                source = {"wb": {"mode": "custom", "scale": source_scale, "temp": 5100.125, "tint": -3.25}}
                payload = extract_copy_settings(source, selected)
                before_merges = sum(command == "develop.merge" for command, _ in children[0].commands)
                response = await history_request(http, doc, "operate", paste_body(doc, selected, payload))
                if allowed:
                    assert response.status_code == 200, response.text
                    assert response.json()["history"]["length"] == 1
                    assert sum(command == "develop.merge" for command, _ in children[0].commands) == before_merges + 1
                else:
                    assert response.status_code == 409 and response.json()["code"] == "raw_wb_incompatible"
                    assert sum(command == "develop.merge" for command, _ in children[0].commands) == before_merges
                    current_history = await http.get(f'/api/raw/documents/{doc["handle"]}/history', headers=headers(doc))
                    assert current_history.status_code == 200 and current_history.json()["history"]["length"] == 0
        finally:
            await api.close()
    asyncio.run(run())


def test_non_wb_copy_remains_allowed_across_source_modes(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                photo = api.raw._photo(api._raw_handle, active=True)
                photo.import_settings_json = json.dumps({"wb": {"scale": "legacy"}})
                api.document["sourceWbMode"] = doc["sourceWbMode"] = "relative"
                doc = await initialize_history(http, doc)
                selected = ["basic.exposure"]
                payload = extract_copy_settings({"light": {"exposure": 1.25}}, selected)
                response = await history_request(http, doc, "operate", paste_body(doc, selected, payload))
                assert response.status_code == 200, response.text
                assert response.json()["history"]["length"] == 1
                assert sum(command == "develop.merge" for command, _ in children[0].commands) == 1
        finally:
            await api.close()
    asyncio.run(run())


def test_paste_rejects_unselected_fields_bad_metadata_and_stale_revisions(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await initialize_history(http, doc)
                selected = ["basic.exposure"]
                valid = extract_copy_settings({"light": {"exposure": .5}}, selected)
                url = f'/api/raw/documents/{doc["handle"]}/history/operate'
                base = paste_body(doc, selected, valid)
                bads = [base | {"copySettings": {"light": {"exposure": .5}, "process": 2}},
                        base | {"metadata": base["metadata"] | {"selectedIds": ["unknown"]}},
                        base | {"metadata": base["metadata"] | {"selectedIds": []}},
                        base | {"metadata": base["metadata"] | {"selectedIds": ["basic.exposure", "basic.exposure"]}},
                        base | {"metadata": base["metadata"] | {"sourceFilename": "../secret.jpg"}},
                        base | {"copySettings": {"light": {"exposure": 101}}},
                        base | {"settingsFingerprint": "0" * 64}]
                for bad in bads:
                    response = await http.post(url, json=bad)
                    assert response.status_code in (400, 409), response.text
                assert not any(command == "develop.merge" for command, _ in children[0].commands)
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("failure_point", ["before_commit", "after_commit"])
def test_paste_save_failure_or_unknown_receipt_retries_without_reapplying(failure_point, local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await initialize_history(http, doc)
                selected = ["basic.exposure"]
                payload = extract_copy_settings({"light": {"exposure": 1.25}}, selected)
                request = paste_body(doc, selected, payload)
                append = raw_recipe_store.append_raw_history

                def fail_append(*args, **kwargs):
                    if failure_point == "after_commit":
                        append(*args, **kwargs)
                    raise StoreUnavailable()

                monkeypatch.setattr(raw_recipe_store, "append_raw_history", fail_append)
                url = f'/api/raw/documents/{doc["handle"]}/history/operate'
                failed = await http.post(url, json=request)
                assert failed.status_code == 503 and failed.json()["code"] == "raw_history_save_failed"
                merge_count = sum(command == "develop.merge" for command, _ in children[0].commands)
                assert merge_count == 1

                monkeypatch.setattr(raw_recipe_store, "append_raw_history", append)
                retried = await http.post(url, json=request)
                assert retried.status_code == 200, retried.text
                assert sum(command == "develop.merge" for command, _ in children[0].commands) == merge_count
                history = await http.get(f'/api/raw/documents/{doc["handle"]}/history', headers=headers(retried.json()))
                assert history.status_code == 200
                assert history.json()["history"]["length"] == 1
                assert history.json()["steps"][0]["kind"] == "settingsPaste"
                assert retried.json()["replayed"] is (failure_point == "after_commit")
        finally:
            await api.close()
    asyncio.run(run())
