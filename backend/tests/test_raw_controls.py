import asyncio

import pytest

from lightcraft_mcp import LightCraftError
from raw_controls import (CONTROLS, HISTORY_CONTROLS, complete_snapshot_for_merge, settings_snapshot_for_comparison,
                          validate_controls)
from tests.test_lightcraft_raw import DEFAULT
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document, preview_body


def test_nr_outliers_snapshot_conversion_isolated_from_partial_merge():
    snapshot = {"detail": {"nr_luminance": 0}, "wb": {"temp": 5000}}
    payload = complete_snapshot_for_merge(snapshot)
    assert payload["detail"] == {"nr_luminance": 0, "nr_outliers": False}
    assert snapshot == {"detail": {"nr_luminance": 0}, "wb": {"temp": 5000}}
    assert settings_snapshot_for_comparison({"detail": {"nr_luminance": 0}})["detail"] == payload["detail"]
    assert settings_snapshot_for_comparison({"detail": {"nr_luminance": 0, "nr_outliers": False}})["detail"] == payload["detail"]
    assert settings_snapshot_for_comparison({"detail": {"nr_luminance": 0, "nr_outliers": True}})["detail"] != payload["detail"]
    with pytest.raises(LightCraftError, match="raw_invalid_settings"):
        complete_snapshot_for_merge({"detail": {"nr_outliers": "false"}})


def identity(doc):
    return {key: doc[key] for key in ("workspaceId", "generation", "documentToken")}


@pytest.mark.parametrize("values", [{}, {"arbitrary": 1}, {"light.exposure": True}, {"light.exposure": float("nan")},
                                   {"light.exposure": float("inf")}, {"light.exposure": 6}, {"wb.temp": 1999}])
def test_invalid_control_values(values):
    with pytest.raises(LightCraftError, match="raw_invalid_controls"):
        validate_controls(values, True)


def test_optics_specs_and_typed_switches_match_lightcraft():
    from raw_controls import controls_state
    expected = {'profileDistortion': (0, 200, 100), 'profileVignetting': (0, 200, 100),
        'distortion': (-100, 100, 0), 'vignetting': (-100, 100, 0), 'vignettingMidpoint': (0, 100, 50),
        'defringePurple': (0, 20, 0), 'defringePurpleHueLo': (0, 90, 30),
        'defringePurpleHueHi': (10, 100, 70), 'defringeGreen': (0, 20, 0),
        'defringeGreenHueLo': (0, 90, 40), 'defringeGreenHueHi': (10, 100, 60),
        'caRed': (-100, 100, 0), 'caBlue': (-100, 100, 0)}
    assert all(CONTROLS[f'optics.{name}'][:2] + (CONTROLS[f'optics.{name}'][3],) == spec
               for name, spec in expected.items())
    for flag in ('optics.remove_ca', 'optics.lens_profile'):
        assert validate_controls({flag: True}, True) == {flag: True}
        with pytest.raises(LightCraftError, match='raw_invalid_controls'):
            validate_controls({flag: 1}, True)
    with pytest.raises(LightCraftError, match='raw_invalid_controls'):
        validate_controls({'optics.remove_ca': True, 'light.exposure': 1}, True)


def test_mixer_controls_are_native_numeric_controls_and_legacy_defaults_are_zero():
    from raw_controls import CONTROL_PATHS, validate_history_operation
    from raw_recipe_store import _history_metadata
    colors = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")
    ids = {f"mixer.{color}.{field}" for color in colors for field in ("hue", "sat", "lum")}
    assert ids <= CONTROLS.keys() and ids <= CONTROL_PATHS.keys()
    assert ids <= HISTORY_CONTROLS
    assert all(CONTROLS[control] == (-100, 100, 1, 0, 0) for control in ids)
    for control in ids:
        validate_controls({control: 12.375}, True)
        with pytest.raises(LightCraftError, match="raw_invalid_controls"):
            validate_controls({control: 100.01}, True)
        with pytest.raises(LightCraftError, match="raw_invalid_controls"):
            validate_controls({control: float("inf")}, True)
    validate_history_operation("controlReset", {"control": "mixer.red.hue"})
    assert _history_metadata("control", {"control": "mixer.blue.sat"}) == {"control": "mixer.blue.sat"}
    assert CONTROL_PATHS["mixer.blue.sat"] == ("mixer", "blue", "sat")
    settings = {"version": 1, "process": 1, "wb": {}, "mixer": {
        "red": {"hue": 12.375}, "blue": {"sat": -40.25}}}
    from raw_controls import with_legacy_mixer_defaults
    normalized = with_legacy_mixer_defaults(settings)
    assert settings["mixer"] == {"red": {"hue": 12.375}, "blue": {"sat": -40.25}}
    assert normalized["mixer"]["red"] == {"hue": 12.375, "sat": 0., "lum": 0.}
    assert normalized["mixer"]["blue"] == {"hue": 0., "sat": -40.25, "lum": 0.}
    assert normalized["mixer"]["orange"] == {"hue": 0., "sat": 0., "lum": 0.}
    assert settings_snapshot_for_comparison({"version": 1, "process": 1, "wb": {}})["mixer"]["red"] == {
        "hue": 0., "sat": 0., "lum": 0.}


def test_optics_numeric_and_boolean_settings_use_native_merge_and_readback(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                values = {'optics.profileDistortion': 125, 'optics.defringeGreen': 7,
                          'optics.remove_ca': True, 'optics.lens_profile': True}
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                    json=identity(doc) | {'expectedRevision': doc['revision'], 'values': values})
                assert response.status_code == 200, response.text
                result = response.json()
                assert result['values']['optics.profileDistortion'] == 125
                assert result['values']['optics.defringeGreen'] == 7
                assert result['opticsFlags'] == {'remove_ca': True, 'lens_profile': True}
                assert result['sections']['optics'] is True
                assert children[0].commands[-2][0] == 'develop.merge'
                assert children[0].commands[-2][1]['settings']['optics'] == {
                    'profile_distortion': 125, 'defringe_green_amount': 7,
                    'remove_ca': True, 'lens_profile': True}
                assert result['revision'] > doc['revision']
        finally:
            await api.close()
    asyncio.run(run())


def test_photo_specific_lens_info_is_readonly_and_applied_state_tracks_settings(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            children[0].lens_profile_info["profileHasVignetting"] = True
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                settings_url = f'/api/raw/documents/{doc["handle"]}/settings'
                initial = (await http.post(settings_url, json=identity(doc))).json()
                info = initial["lensProfileInfo"]
                assert info == {"cameraMake": "Testcam", "cameraModel": "TC-1", "lensMake": "Testcam",
                    "lensModel": "18-55mm", "lensId": None, "profileAvailable": True, "profileSource": "database",
                    "profileName": "Testcam 18-55mm", "profileApplied": False}
                assert "lensProfileInfo" not in api.raw._photos[doc["assetId"]].settings_json
                assert "profileName" not in initial.get("history", {})
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls', json=identity(doc) |
                    {"expectedRevision": doc["revision"], "values": {"optics.lens_profile": True}})
                assert response.status_code == 200, response.text
                assert response.json()["lensProfileInfo"]["profileApplied"] is True
                toggled = response.json()
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls', json=identity(toggled) |
                    {"expectedRevision": toggled["revision"], "values": {"optics.profileDistortion": 0, "optics.profileVignetting": 0}})
                assert response.status_code == 200 and response.json()["lensProfileInfo"]["profileApplied"] is False
                assert any(command == "photo.lensProfileInfo" for command, _ in children[0].commands)
        finally:
            await api.close()
    asyncio.run(run())


def test_lens_info_failure_degrades_to_unknown_without_failing_raw_open(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].fail_commands.add("photo.lensProfileInfo")
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert response.status_code == 200, response.text
                info = response.json()["lensProfileInfo"]
                assert info["profileSource"] == "unknown" and info["profileAvailable"] is None
                assert info["profileApplied"] is False
        finally:
            await api.close()
    asyncio.run(run())


def test_controls_readback_revision_and_preview(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            children[0].as_shot_wb = [5200., 6.]
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                settings_url = f'/api/raw/documents/{doc["handle"]}/settings'
                controls_url = f'/api/raw/documents/{doc["handle"]}/controls'
                initial = (await http.post(settings_url, json=identity(doc))).json()
                assert initial["wb"] == {"available": True, "mode": "custom", "scale": "kelvin"}
                assert {c["id"] for c in initial["controls"]} == set(CONTROLS)
                patch = {key: 5500 if key == "wb.temp" else spec[3] for key, spec in CONTROLS.items()}
                children[0].mismatch = True
                response = await http.post(controls_url, json=identity(doc) | {"expectedRevision": doc["revision"], "values": patch})
                assert response.status_code == 200, response.text
                actual = response.json()
                assert actual["revision"] > doc["revision"]
                assert actual["values"] == patch | {"light.exposure": 4.}
                assert actual["wb"]["mode"] == "custom" and actual["wb"]["scale"] == "kelvin"
                assert "path" not in response.text and "PRIVATE" not in response.text
                assert (await http.post(controls_url, json=identity(doc) | {"expectedRevision": doc["revision"], "values": patch})).status_code == 409
                assert (await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(actual))).status_code == 200
                assert (await http.post(controls_url, json=identity(doc) | {"expectedRevision": actual["revision"], "values": {"geometry.scale": 90}})).status_code == 400
                assert (await http.post(controls_url, headers={"Origin": "http://evil.example"}, json=identity(doc))).status_code == 403
                wrong = identity(doc) | {"workspaceId": "other"}
                assert (await http.post(settings_url, json=wrong)).status_code == 409
                assert (await http.post(settings_url, json=identity(doc) | {"generation": doc["generation"] + 1})).status_code == 409
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("white,scale,available", [(None, "kelvin", True), ([5200., 6.], "legacy", True),
                                                   ([5200., 6.], None, True), ([5200., 6.], "kelvin", True)])
def test_wb_capability_and_as_shot_custom_transition(local, tmp_path, monkeypatch, white, scale, available):
    monkeypatch.setitem(DEFAULT["wb"], "mode", "asShot")
    monkeypatch.setitem(DEFAULT["wb"], "scale", scale)
    if scale is None:
        monkeypatch.delitem(DEFAULT["wb"], "scale")
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].as_shot_wb = white
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                initial = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                assert initial["wb"]["available"] is available and initial["wb"]["mode"] == "asShot"
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                    json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"wb.temp": 5600, "wb.tint": 7}})
                assert response.status_code == (200 if available else 400), response.text
                if available:
                    assert response.json()["wb"]["mode"] == "custom"
                    assert response.json()["values"]["wb.temp"] == 5600
                else:
                    assert response.json()["code"] == "raw_wb_unavailable"
                    # An unavailable WB must not disable ordinary RAW light controls.
                    assert (await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                        json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": 1}})).status_code == 200
        finally:
            await api.close()
    asyncio.run(run())


def test_disconnected_mutation_stays_owned_until_readback(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        entered, release = asyncio.Event(), asyncio.Event()
        original = api.raw.set_controls
        async def gated(*args):
            entered.set()
            await release.wait()
            return await original(*args)
        monkeypatch.setattr(api.raw, "set_controls", gated)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                task = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                    json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": 1}}))
                await entered.wait()
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert api._tasks and api.document["revision"] == doc["revision"]
                release.set()
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert response.status_code == 200, response.text
                assert response.json()["revision"] > doc["revision"] and response.json()["values"]["light.exposure"] == 1
        finally:
            release.set()
            await api.close()
    asyncio.run(run())


def test_failed_readback_is_not_acknowledged_and_can_resync(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                children[0].fail_get = True
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                    json=identity(doc) | {"expectedRevision": doc["revision"], "values": {"light.exposure": 1}})
                assert response.status_code == 502
                assert api.document["revision"] == doc["revision"]
                children[0].fail_get = False
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert response.status_code == 200, response.text
                assert response.json()["revision"] > doc["revision"] and response.json()["values"]["light.exposure"] == 1
        finally:
            await api.close()
    asyncio.run(run())
