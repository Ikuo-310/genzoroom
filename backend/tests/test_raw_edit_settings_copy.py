import asyncio
import copy
import re
from pathlib import Path
from uuid import uuid4

import pytest

import windows_raw_api as api_module
from lightcraft_mcp import LightCraftError
from raw_edit_settings_copy import (COPY_SETTING_IDS, CROP_SETTING_ID, extract_copy_settings)
from raw_edit_settings_copy import source_wb_mode
from tests.test_lightcraft_raw import DEFAULT
from tests.test_raw_controls import identity
from tests.test_windows_local import authenticate, client, local
from tests.test_windows_raw_api import open_document, setup


def test_frontend_copy_setting_ids_match_backend_contract():
    source = (Path(__file__).resolve().parents[2] / "frontend/src/rawApi.ts").read_text(encoding="utf-8")
    match = re.search(r"RAW_COPY_SETTING_IDS = \[(.*?)\] as const", source, re.S)
    assert match is not None
    frontend_ids = re.findall(r"'([^']+)'", match.group(1))
    assert len(frontend_ids) == 25
    assert set(frontend_ids) == COPY_SETTING_IDS


@pytest.mark.parametrize(("scale", "expected"), [("kelvin", "absolute"), ("legacy", "relative"),
                                                    (None, "relative"), ("future", "unknown")])
def test_source_wb_mode_comes_from_native_import_settings(scale, expected):
    settings = {"wb": {} if scale is None else {"scale": scale}}
    assert source_wb_mode(settings) == expected


def test_copy_selection_projects_only_published_fields_and_excludes_crop_from_all():
    source = copy.deepcopy(DEFAULT)
    source["crop"]["geometry"]["angle"] = 12.123456789123
    source["grain"] = {"amount": 10}
    source["enhance"] = {"denoise": 20}
    source["grading"]["global"]["hue"] = 123
    source["profile"] = {"id": "camera-specific"}
    selected = sorted(COPY_SETTING_IDS - {CROP_SETTING_ID})

    result = extract_copy_settings(source, selected)

    assert "crop" not in result and "orientation" not in result
    assert "grain" not in result and "enhance" not in result
    assert "global" not in result["grading"]
    assert result["profile"] == {"camera_local_tone": False}
    assert result["wb"] == source["wb"]
    assert result["curve"] == source["curve"]
    assert result["point_colors"] == []
    cropped = extract_copy_settings(source, [CROP_SETTING_ID])
    assert cropped["crop"] == source["crop"] and cropped["orientation"] == source["orientation"]
    lens = extract_copy_settings(source, ["lensCorrection"])["optics"]
    aberration = extract_copy_settings(source, ["chromaticAberration"])["optics"]
    assert "defringe_purple_amount" not in lens and "profile_distortion" in lens
    assert "defringe_purple_amount" in aberration and "profile_distortion" not in aberration


def test_copy_projection_preserves_precision_arrays_and_known_omitted_defaults():
    source = {"light": {"exposure": 1.234567890123}, "color": {"vibrance": 0.0},
              "optics": {"remove_ca": True}, "point_colors": [],
              "curve": copy.deepcopy(DEFAULT["curve"])}
    source["curve"]["master"] = [{"x": 0.123456789123, "y": 0.987654321987}]

    result = extract_copy_settings(source, ["basic.exposure", "color.vibrance", "pointColor",
                                            "localToneMapping", "chromaticAberration", "pointCurve"])

    assert result["light"]["exposure"] == source["light"]["exposure"]
    assert result["color"]["vibrance"] == 0.0
    assert result["point_colors"] == []
    assert result["profile"]["camera_local_tone"] is False
    assert result["optics"]["remove_ca"] is True
    assert result["curve"]["master"] == source["curve"]["master"]
    assert result["optics"]["ca_red"] == 0


@pytest.mark.parametrize("selected", [["unknown"], ["crop", "crop"], []])
def test_copy_projection_rejects_invalid_or_empty_selection(selected):
    with pytest.raises(LightCraftError, match="^raw_invalid_request$"):
        extract_copy_settings({}, selected)


def test_copy_settings_http_uses_import_and_saved_snapshots_without_native_or_sqlite_reads(
        local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                initial_body = {"workspaceId": doc["workspaceId"], "generation": doc["generation"],
                                "documentToken": doc["documentToken"], "documentRevision": doc["revision"],
                                "settingsFingerprint": doc["settingsFingerprint"], "recipeRevision": doc["recipeRevision"],
                                "selectedIds": ["pointColor"]}
                initial = await http.post(f'/api/raw/documents/{doc["handle"]}/copy-settings', json=initial_body)
                assert initial.status_code == 200 and initial.json()["settings"]["point_colors"] == []
                assert initial.json()["sourceWbMode"] == "absolute"
                await api.raw.merge_settings(api._raw_handle, {"wb": {"scale": "legacy"}}, doc["revision"])
                settled = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert settled.status_code == 200, settled.text
                doc = settled.json()
                assert doc["wb"]["scale"] == "legacy"
                assert doc["sourceWbMode"] == "absolute"
                current = await http.post(f'/api/raw/documents/{doc["handle"]}/copy-settings', json={
                    "workspaceId": doc["workspaceId"], "generation": doc["generation"],
                    "documentToken": doc["documentToken"], "documentRevision": doc["revision"],
                    "settingsFingerprint": doc["settingsFingerprint"], "recipeRevision": doc["recipeRevision"],
                    "selectedIds": ["whiteBalance"]})
                assert current.status_code == 200 and current.json()["sourceWbMode"] == "absolute"
                assert current.json()["settings"]["wb"]["scale"] == "legacy"
                history_body = identity(doc) | {"documentRevision": doc["revision"],
                    "settingsFingerprint": doc["settingsFingerprint"], "expectedRecipeRevision": doc["recipeRevision"],
                    "saveId": str(uuid4())}
                initialized = await http.post(f'/api/raw/documents/{doc["handle"]}/history/initialize', json=history_body)
                assert initialized.status_code == 200, initialized.text
                doc = initialized.json()
                controls = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                    json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": 1.234567890123}})
                assert controls.status_code == 200, controls.text
                doc = controls.json()
                commit = history_body.copy()
                commit.update(identity(doc), documentRevision=doc["revision"],
                              settingsFingerprint=doc["settingsFingerprint"],
                              expectedRecipeRevision=doc["recipeRevision"], saveId=str(uuid4()),
                              kind="control", metadata={"control": "light.exposure"})
                committed = await http.post(f'/api/raw/documents/{doc["handle"]}/history/commit', json=commit)
                assert committed.status_code == 200, committed.text
                doc = committed.json()
                before_commands = list(children[0].commands)
                body = {"workspaceId": doc["workspaceId"], "generation": doc["generation"],
                        "documentToken": doc["documentToken"], "documentRevision": doc["revision"],
                        "settingsFingerprint": doc["settingsFingerprint"], "recipeRevision": doc["recipeRevision"],
                        "selectedIds": ["basic.exposure", "pointColor", "pointCurve"]}
                with monkeypatch.context() as copy_guard:
                    copy_guard.setattr(api.raw, "get_settings", lambda *args, **kwargs:
                        pytest.fail("copy must not issue Native settings readback"))
                    copy_guard.setattr(api_module, "run_in_threadpool", lambda *args, **kwargs:
                        pytest.fail("copy must not reload SQLite"))
                    response = await http.post(f'/api/raw/documents/{doc["handle"]}/copy-settings', json=body)
                assert response.status_code == 200, response.text
                result = response.json()
                assert result["settings"]["light"]["exposure"] == 1.234567890123
                assert result["settings"]["point_colors"] == []
                assert result["settings"]["curve"] == DEFAULT["curve"]
                assert result["documentRevision"] == doc["revision"]
                assert result["settingsFingerprint"] == doc["settingsFingerprint"]
                assert result["recipeRevision"] == doc["recipeRevision"]
                assert children[0].commands == before_commands
        finally:
            await api.close()
    asyncio.run(run())


def test_copy_settings_http_validates_owner_revision_ids_and_pending_saves(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/copy-settings'
                body = {"workspaceId": doc["workspaceId"], "generation": doc["generation"],
                        "documentToken": doc["documentToken"], "documentRevision": doc["revision"],
                        "settingsFingerprint": doc["settingsFingerprint"], "recipeRevision": doc["recipeRevision"],
                        "selectedIds": ["basic.exposure"]}
                async with client(local) as anonymous:
                    unauthenticated = await anonymous.post(url, json=body)
                    assert unauthenticated.status_code == 401
                bad_id = await http.post(url, json=body | {"selectedIds": ["process"]})
                assert bad_id.status_code == 400
                stale = await http.post(url, json=body | {"documentRevision": doc["revision"] + 1})
                assert stale.status_code == 409 and stale.json()["code"] == "raw_revision_conflict"
                stale_generation = await http.post(url, json=body | {"generation": doc["generation"] + 1})
                assert stale_generation.status_code == 409 and stale_generation.json()["code"] == "raw_stale_handle"
                stale_fingerprint = await http.post(url, json=body | {"settingsFingerprint": "0" * 64})
                assert stale_fingerprint.status_code == 409 and stale_fingerprint.json()["code"] == "raw_revision_conflict"
                stale_recipe = await http.post(url, json=body | {"recipeRevision": doc["recipeRevision"] + 1})
                assert stale_recipe.status_code == 409 and stale_recipe.json()["code"] == "raw_revision_conflict"
                old_owner = await http.post(url, json=body | {"documentToken": "0" * 32})
                assert old_owner.status_code == 409 and old_owner.json()["code"] == "raw_stale_handle"
                api.document["recipeRecoveryPending"] = True
                recovering = await http.post(url, json=body)
                assert recovering.status_code == 409 and recovering.json()["code"] == "raw_history_requires_operation"
                api.document["recipeRecoveryPending"] = False
                api._history_save = {"stage": "writing"}
                history_pending = await http.post(url, json=body)
                assert history_pending.status_code == 409 and history_pending.json()["code"] == "raw_history_save_pending"
                api._history_save = None
        finally:
            await api.close()
    asyncio.run(run())
