import asyncio
import json
import threading

import pytest

import lightcraft_raw as adapter
from lightcraft_mcp import LightCraftError
from tests.test_lightcraft_raw import create
from tests.test_lightcraft_mcp import until
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document, preview_body
from tests.test_raw_history_api import operation, commit_body
from tests.test_raw_recipe_api import change
import raw_recipe_store as store
import windows_raw_api as http_api


def target(doc, serial=1, quality="draft"):
    return preview_body(doc, serial) | {"quality": quality, "mode": "whole", "maxSide": 1024,
                                       "viewGeneration": 1, "geometryId": None}


@pytest.mark.parametrize("native,code,status", [
    ("preview_invalid_quality", "raw_invalid_preview_request", 400),
    ("preview_invalid_contract", "raw_invalid_preview_request", 400),
    ("preview_invalid_stage_cache", "raw_invalid_preview_request", 400),
    ("preview_unsupported", "raw_preview_unsupported", 503),
    ("preview_geometry_unavailable", "raw_preview_geometry_unavailable", 502),
    ("preview_geometry_mismatch", "raw_preview_geometry_unavailable", 502),
    ("preview_budget_exceeded", "raw_preview_budget_exceeded", 413),
    ("preview_render_failed", "raw_invalid_preview", 502),
    ("PRIVATE C:/photo.raw secret", "lightcraft_tool_error", 502),
])
def test_safe_native_tool_errors(local, tmp_path, monkeypatch, native, code, status):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].adaptive_supported = True
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                children[0].preview_error_code = native
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=target(doc))
                assert response.status_code == status and response.json() == {"code": code}
                assert not api._image_leases and not api.raw._lost
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("budget", [None, "0", "-1", "1073741825", "1.5"])
def test_internal_stage_cache_requires_finite_budget(monkeypatch, budget):
    monkeypatch.setenv("GENZOROOM_RAW_STAGE_CACHE", "on")
    if budget is None:
        monkeypatch.delenv("GENZOROOM_RAW_STAGE_CACHE_BUDGET_BYTES", raising=False)
    else:
        monkeypatch.setenv("GENZOROOM_RAW_STAGE_CACHE_BUDGET_BYTES", budget)
    with pytest.raises(LightCraftError, match="raw_invalid_preview_request"):
        adapter.LightCraftRawSession(None)


@pytest.mark.parametrize('budget', [536870912, 1024**3])
def test_internal_stage_cache_reaches_native_and_stays_out_of_history(local, tmp_path, monkeypatch, budget):
    monkeypatch.setenv("GENZOROOM_RAW_STAGE_CACHE", "on")
    monkeypatch.setenv("GENZOROOM_RAW_STAGE_CACHE_BUDGET_BYTES", str(budget))
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].adaptive_supported = True
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                settings = api.raw._photos[doc["assetId"]].settings_json
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=target(doc, quality="full"))
                assert response.status_code == 200
                assert children[0].preview_arguments[-1]["stage_cache"] == "on"
                assert children[0].preview_arguments[-1]["stage_cache_budget_bytes"] == budget
                assert api.raw._photos[doc["assetId"]].settings_json == settings
                assert api.document["recipeRevision"] == 0 and api.document["revision"] == doc["revision"]
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("kind", ["after", "before"])
def test_render_readback_revision_discards_old_frame_and_requires_resync(local, tmp_path, monkeypatch, kind):
    async def run():
        api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = child.before_supported = True
        original = manager._raw_preview
        first = True
        async def render(*args, **kwargs):
            nonlocal first
            result = await original(*args, **kwargs)
            if first:
                first = False
                child.photos[1]["settings"]["wb"]["temp"] = 5000.
            return result
        monkeypatch.setattr(manager, "_raw_preview", render)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}'
                response = await http.post(url + "/preview", json=target(doc) | {"kind": kind})
                assert response.status_code == 204 and response.headers["x-raw-superseded-reason"] == "revision"
                identity = {k: doc[k] for k in ("workspaceId", "generation", "documentToken")}
                synced = (await http.post(url + "/settings", json=identity)).json()
                assert synced["revision"] > doc["revision"] and synced["recipeRevision"] == 0
                response = await http.post(url + "/preview", json=target(synced, 2) | {"kind": kind})
                assert response.status_code == 200 and api.raw.status().edits == 0
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("adaptive", [False, True])
def test_actual_runtime_quality_frame_and_same_revision_full(local, tmp_path, monkeypatch, adaptive):
    async def run():
        api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].adaptive_supported = adaptive
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/preview'
                responses = [await http.post(url, json=target(doc, i, q))
                             for i, q in ((1, "draft"), (2, "full"))]
                assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
                assert children[0].render_count == 2
                assert responses[1].headers["x-raw-quality"] == "full"
                assert responses[0].headers["x-raw-preview-contract"] == str(int(adaptive))
                args = children[0].preview_arguments
                if adaptive:
                    assert [a["quality"] for a in args] == ["draft", "full"]
                    frame = json.loads(responses[0].headers["x-raw-frame"])
                    assert frame["nativeWidth"] == 6000 and frame["fullWidth"] == 16
                    assert frame["geometryId"] != "a" * 64
                    assert frame == json.loads(responses[1].headers["x-raw-frame"])
                else:
                    assert all("quality" not in a for a in args)
                    assert responses[0].headers["x-raw-quality"] == "full"
                    assert "x-raw-frame" not in responses[0].headers
                assert not api._image_leases
        finally:
            await api.close()
    asyncio.run(run())


def test_validation_does_not_block_mutation_history_save_or_control_admission(local, tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = adapter._validate_png
    def validate(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)
    monkeypatch.setattr(adapter, "_validate_png", validate)
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                preview = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=target(doc)))
                await until(entered.is_set)
                assert not api.raw._lock.locked() and not api._lock.locked()
                async with asyncio.timeout(1):
                    changed = await change(http, doc, 1.)
                    saved = await operation(http, changed, "commit", commit_body(changed))
                assert saved["nativeMatchesRecipe"] and saved["history"]["length"] == 1
                assert not preview.done() and children[0].render_count == 1
                release.set()
                assert (await preview).status_code == 204
                assert not api._image_leases and api.raw._control_reservations == 0
        finally:
            release.set()
            await api.close()
    asyncio.run(run())


def test_control_reservation_cancel_pending_and_running_are_collected(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        children[0].adaptive_supported = True
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/preview'
                cancel = {k: doc[k] for k in ("workspaceId", "generation", "documentToken")} | {"kind": "after", "serial": 1}
                api.raw.reserve_control()
                pending = asyncio.create_task(http.post(url, json=target(doc)))
                await until(lambda: api.raw._pending is not None)
                async with api._lock:
                    assert (await http.post(url + "/cancel", json=cancel)).status_code == 204
                assert (await pending).status_code == 204 and children[0].render_count == 0
                api.raw.release_control()
                children[0].gate = asyncio.Event()
                running = asyncio.create_task(http.post(url, json=target(doc, 2, "full")))
                await children[0].render_started.wait()
                assert (await http.post(url + "/cancel", json=cancel | {"serial": 2})).status_code == 204
                assert not running.done() and api.raw._running.abandoned
                children[0].gate.set()
                response = await running
                assert response.status_code == 204 and response.headers["x-raw-superseded-reason"] == "cancelled"
                assert not api._image_leases and not api.raw._lost
        finally:
            if api.raw._control_reservations:
                api.raw.release_control()
            await api.close()
    asyncio.run(run())


def test_history_transaction_reserves_native_until_receipt_verified(local, tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = store.append_raw_history
    def append(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(store, "append_raw_history", append)
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, "initialize")
                doc = await change(http, doc, 1.)
                saving = asyncio.create_task(operation(http, doc, "commit", commit_body(doc)))
                await until(entered.is_set)
                assert api.raw._control_reservations and api._lock.locked()
                ticket = api.raw.request_preview(api._raw_handle, doc["revision"])
                await asyncio.sleep(.02)
                assert children[0].render_count == 0
                release.set()
                saved = await saving
                assert saved["nativeMatchesRecipe"]
                frame = await ticket
                assert frame.revision == doc["revision"]
                assert not api.raw._control_reservations
        finally:
            release.set()
            await api.close()
    asyncio.run(run())


def test_http_transfer_owns_three_image_leases_without_blocking_save(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        release = asyncio.Event()
        started = 0
        original = http_api._ImageResponse.__call__
        async def slow_body(response, scope, receive, send):
            async def slow_send(message):
                nonlocal started
                if message["type"] == "http.response.body":
                    started += 1
                    await release.wait()
                await send(message)
            await original(response, scope, receive, slow_send)
        monkeypatch.setattr(http_api._ImageResponse, "__call__", slow_body)
        requests = []
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/preview'
                for serial in range(1, 4):
                    requests.append(asyncio.create_task(http.post(url, json=target(doc, serial))))
                    await until(lambda: started == serial)
                assert len(api._image_leases) == 3 and not api._tasks
                assert (await http.post(url, json=target(doc, 4))).json()["code"] == "raw_busy"
                saved = await operation(http, doc, "initialize")
                assert saved["nativeMatchesRecipe"]
                assert len(api._image_leases) == 3
                release.set()
                assert all(r.status_code == 200 for r in await asyncio.gather(*requests))
                assert not api._image_leases
        finally:
            release.set()
            await asyncio.gather(*requests, return_exceptions=True)
            await api.close()
    asyncio.run(run())


def test_full_image_pool_replaces_unsent_full_with_latest_draft(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = child.before_supported = True
        child.gate = asyncio.Event()
        requests = []
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                url = f'/api/raw/documents/{doc["handle"]}/preview'
                requests.append(asyncio.create_task(http.post(url, json=target(doc))))
                await child.render_started.wait()
                requests.append(asyncio.create_task(http.post(url, json=target(doc, 2, "full"))))
                await until(lambda: api.raw._pending is not None)
                requests.append(asyncio.create_task(http.post(url, json=target(doc) | {"kind": "before"})))
                await until(lambda: api.raw._before_pending is not None)
                assert len(api._image_leases) == 3
                latest = asyncio.create_task(http.post(url, json=target(doc, 3)))
                requests.append(latest)
                await until(lambda: api.raw._pending is not None and api.raw._pending.serial == 3)
                assert (await requests[1]).status_code == 204
                assert len(api._image_leases) <= 3 and child.render_count == 1
                child.gate.set()
                results = await asyncio.gather(*requests)
                assert [r.status_code for r in results] == [204, 204, 200, 200]
                assert [a["quality"] for a in child.preview_arguments] == ["draft", "draft", "draft"]
                assert not api._image_leases and not api._lease_tickets
        finally:
            child.gate.set()
            await asyncio.gather(*requests, return_exceptions=True)
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize("field,value", [("quality", "full"), ("kind", "before"), ("previewContract", True),
    ("mode", "region"), ("frame", {}), ("stageCache", {})])
def test_strict_adaptive_metadata_rejects_corruption(tmp_path, field, value):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        children[0].adaptive_supported = True
        try:
            handle, settings = await raw.open_raw("raw", files[0])
            result = await manager._raw_preview(handle.generation, 1, 1024, timeout=1, quality="draft")
            metadata = json.loads(result["content"][1]["text"])
            metadata[field] = value
            result["content"][1]["text"] = json.dumps(metadata)
            with pytest.raises(LightCraftError, match="lightcraft_invalid_preview"):
                adapter._validate_png(result, 1, 1024, quality="draft")
        finally:
            await raw.close()
    asyncio.run(run())
