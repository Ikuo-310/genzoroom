import asyncio

import pytest

from lightcraft_mcp import LightCraftError
from raw_controls import CONTROLS, validate_controls
from tests.test_lightcraft_raw import DEFAULT
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document, preview_body


def identity(doc):
    return {key: doc[key] for key in ("workspaceId", "generation", "documentToken")}


@pytest.mark.parametrize("values", [{}, {"arbitrary": 1}, {"light.exposure": True}, {"light.exposure": float("nan")},
                                   {"light.exposure": float("inf")}, {"light.exposure": 6}, {"wb.temp": 1999}])
def test_invalid_control_values(values):
    with pytest.raises(LightCraftError, match="raw_invalid_controls"):
        validate_controls(values, True)


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
                patch = {key: 5500 if key == "wb.temp" else 1 for key in CONTROLS}
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


@pytest.mark.parametrize("white,scale,available", [(None, "kelvin", False), ([5200., 6.], "legacy", False),
                                                   ([5200., 6.], None, False), ([5200., 6.], "kelvin", True)])
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
