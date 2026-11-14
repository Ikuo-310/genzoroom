import asyncio

import pytest

from lightcraft_mcp import LightCraftError
from raw_controls import (CONTROLS, HISTORY_CONTROLS, complete_snapshot_for_merge, settings_snapshot_for_comparison,
                          mixer_target_readback, validate_controls, POINT_COLOR_FIELDS,
                          validate_point_colors, validate_point_color_control, validate_point_color_value,
                          validate_point_color_coordinates, validate_point_color_delete, validate_point_color_append,
                          validate_point_color_history_operation)
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


def point_color(**overrides):
    value = {"lum": 0.62, "chroma": 0.14, "hue": 207.5}
    value.update({spec[0]: spec[3] for spec in POINT_COLOR_FIELDS.values()})
    value.update(overrides)
    return value


def test_point_color_readback_validation_preserves_order_duplicates_and_fractional_values():
    first = point_color(hue_shift=12.375, range=33.625)
    second = point_color(hue_shift=12.375, range=33.625)
    values = validate_point_colors({"point_colors": [first, second]})
    assert values == [first, second]
    assert values[0] is first and values[1] is second
    assert values[0]["hue_shift"] == 12.375 and values[0]["range"] == 33.625
    assert len(validate_point_colors({"point_colors": [point_color() for _ in range(8)]})) == 8


@pytest.mark.parametrize("entry", [
    {**point_color(), "unknown": 1},
    {key: value for key, value in point_color().items() if key != "hue"},
    {**point_color(), "lum": True},
    {**point_color(), "chroma": float("nan")},
    {**point_color(), "hue": float("inf")},
    {**point_color(), "lum": -0.01},
    {**point_color(), "lum": 1.01},
    {**point_color(), "chroma": -0.01},
    {**point_color(), "hue": 360},
    {**point_color(), "hue_shift": 100.01},
    {**point_color(), "variance": float("-inf")},
    "not an entry",
])
def test_point_color_readback_rejects_malformed_entries(entry):
    with pytest.raises(LightCraftError, match="raw_invalid_point_colors"):
        validate_point_colors({"point_colors": [entry]})


@pytest.mark.parametrize("settings", [{}, {"point_colors": None}, {"point_colors": tuple()},
                                      {"point_colors": [point_color() for _ in range(9)]}])
def test_point_color_readback_rejects_missing_wrong_shape_and_over_limit(settings):
    with pytest.raises(LightCraftError, match="raw_invalid_point_colors"):
        validate_point_colors(settings)


def test_point_color_indexed_controls_validate_shape_index_field_and_fractional_value():
    assert validate_point_color_control("pointColor.0.hueShift", 1) == (0, POINT_COLOR_FIELDS["hueShift"])
    assert validate_point_color_control("pointColor.7.lumRange", 8) == (7, POINT_COLOR_FIELDS["lumRange"])
    assert validate_point_color_value("hueShift", 12.375) == 12.375
    assert validate_controls({"mixer.red.hue": 12.375}, True) == {"mixer.red.hue": 12.375}
    for control, count in [("pointColor.1.hueShift", 1), ("pointColor.0.feather", 1),
                           ("pointColor.-1.range", 1), ("pointColor.00.range", 1),
                           ("pointColor.0.range.extra", 1), ("pointColor.8.range", 8)]:
        with pytest.raises(LightCraftError, match="raw_invalid_point_color_control"):
            validate_point_color_control(control, count)
    for value in [True, float("nan"), float("inf"), -100.01, 100.01]:
        with pytest.raises(LightCraftError, match="raw_invalid_controls"):
            validate_point_color_value("hueShift", value)


def test_point_color_coordinate_append_and_delete_validation():
    assert validate_point_color_coordinates(0.0, 1) == (0.0, 1)
    assert validate_point_color_delete(0, 1) == 0
    validate_point_color_append(7)
    with pytest.raises(LightCraftError, match="raw_invalid_point_color_coordinates"):
        validate_point_color_coordinates(float("nan"), .5)
    with pytest.raises(LightCraftError, match="raw_invalid_point_color_coordinates"):
        validate_point_color_coordinates(-.01, .5)
    with pytest.raises(LightCraftError, match="raw_point_color_limit"):
        validate_point_color_append(8)
    for index, count in [(-1, 1), (1, 1), (0, 0), (True, 1)]:
        with pytest.raises(LightCraftError, match="raw_invalid_point_color_index"):
            validate_point_color_delete(index, count)


def test_mixer_target_readback_keeps_fractional_values_and_rejects_other_controls_or_modes():
    changes = {"mixer.red.hue": 1.25, "mixer.orange.hue": .625}
    assert mixer_target_readback(changes, "hue") == changes
    settings = {**DEFAULT, "mixer": {**DEFAULT["mixer"],
        "red": {**DEFAULT["mixer"]["red"], "hue": 1.25},
        "orange": {**DEFAULT["mixer"]["orange"], "hue": .625}}}
    assert mixer_target_readback(settings, "hue", snapshot=True) == {}
    for invalid, mode in [({"color.saturation": 1}, "hue"), ({"mixer.red.sat": 1}, "hue"),
                          ({"mixer.red.hue": True}, "hue"), ({"mixer.red.hue": float("nan")}, "hue"),
                          ({"mixer.red.hue": 101}, "hue")]:
        with pytest.raises(LightCraftError, match="raw_invalid_response"):
            mixer_target_readback(invalid, mode)
    with pytest.raises(LightCraftError, match="raw_invalid_settings"):
        mixer_target_readback({**settings, "mixer": {**settings["mixer"],
            "red": {**settings["mixer"]["red"], "hue": float("inf")}}}, "hue", snapshot=True)


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


@pytest.mark.parametrize("kind,metadata", [
    ("pointColorPick", {"x": .125, "y": .875}),
    ("pointColorDelete", {"index": 999}),
    ("pointColorControl", {"control": "pointColor.999.hueShift", "value": -12.375}),
    ("pointColorControlReset", {"control": "pointColor.999.lumRange"}),
    ("pointColorReset", {}),
])
def test_point_color_history_contract_accepts_request_only_metadata(kind, metadata):
    normalized = validate_point_color_history_operation(kind, metadata)
    assert normalized == metadata
    if kind == "pointColorControl":
        assert normalized["value"] == -12.375
        assert type(normalized["value"]) is float


@pytest.mark.parametrize("kind,metadata", [
    ("unknown", {}), ("pointColorPick", {"x": .5}), ("pointColorPick", {"x": .5, "y": .5, "z": 1}),
    ("pointColorDelete", {}), ("pointColorDelete", {"index": 0, "extra": 1}),
    ("pointColorControl", {"control": "pointColor.0.hueShift"}),
    ("pointColorControlReset", {"control": "pointColor.0.range", "value": 50}),
    ("pointColorReset", {"index": 0}),
    ("pointColorPick", {"x": True, "y": .5}), ("pointColorDelete", {"index": True}),
    ("pointColorDelete", {"index": -1}), ("pointColorDelete", {"index": 1.5}),
    ("pointColorPick", {"x": float("nan"), "y": .5}),
    ("pointColorPick", {"x": .5, "y": float("inf")}),
    ("pointColorPick", {"x": 1.01, "y": .5}),
    ("pointColorControl", {"control": "mixer.red.hue", "value": 1}),
    ("pointColorControlReset", {"control": "pointColor.0.unknown"}),
    ("pointColorControl", {"control": "pointColor.0.range", "value": -0.1}),
    ("pointColorControl", {"control": "pointColor.0.hueShift", "value": 100.1}),
    ("pointColorControl", {"control": "pointColor.0.lumShift", "value": float("nan")}),
    ("pointColorControl", {"control": "pointColor.0.lumShift", "value": float("inf")}),
    ("pointColorControl", {"control": "pointColor.0.hueShift", "value": True}),
])
def test_point_color_history_contract_rejects_invalid_request_metadata(kind, metadata):
    with pytest.raises(LightCraftError, match="raw_invalid_request"):
        validate_point_color_history_operation(kind, metadata)


def test_existing_mixer_curve_and_wb_history_kind_validation_is_unchanged():
    from raw_controls import validate_history_operation
    for kind, metadata in (
        ("controlReset", {"control": "mixer.red.hue"}),
        ("mixerTarget", {"target": "sat"}),
        ("curve", {"channel": "master"}),
        ("curveReset", {"channel": "point"}),
        ("wbReset", {}), ("wbAuto", {}), ("wbPick", {}),
    ):
        validate_history_operation(kind, metadata)


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
