import asyncio
from uuid import uuid4

import httpx
import pytest

import main
import windows_raw_api as module
from raw_source import RawSourceCache
from tests.test_raw_source import Original
from tests.test_lightcraft_raw import create, png
from tests.test_lightcraft_mcp import until
from tests.test_windows_local import local, client, authenticate
from lightcraft_mcp import LightCraftError


async def setup(tmp_path, local, monkeypatch):
    raw, manager, children, _ = await create(tmp_path)
    api = local.raw_api
    api.bind(raw, manager)
    cache_root = tmp_path / "sources"
    cache_root.mkdir()
    async def acquire(_): return Original(), "dng"
    monkeypatch.setattr(module, "RawSourceCache", lambda: RawSourceCache(root=cache_root, acquire=acquire))
    return api, manager, children, cache_root


async def open_document(http):
    response = await http.post("/api/raw/workspaces", json={})
    assert response.status_code == 200, response.text
    workspace = response.json()["workspaceId"]
    response = await http.post("/api/raw/documents", json={"workspaceId": workspace, "assetId": str(uuid4())})
    assert response.status_code == 200, response.text
    return workspace, response.json()


def preview_body(doc, serial=1):
    return {key: doc[key] for key in ("workspaceId", "generation", "documentToken", "revision")} | {"serial": serial}


def test_actual_adapter_render_preview_and_safe_release(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, cache_root = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                assert (await http.get("/api/raw/capabilities")).status_code == 401
                await authenticate(http, local)
                cap = await http.get("/api/raw/capabilities")
                assert cap.json()["available"] is True
                for headers in ({"Origin": "http://evil.example"}, {"Host": "evil.example"}):
                    assert (await http.get("/api/raw/capabilities", headers=headers)).status_code == 403
                workspace, doc = await open_document(http)
                assert set(doc) == {"handle", "assetId", "generation", "documentToken", "revision", "workspaceId"}
                state = await http.get(f'/api/raw/documents/{doc["handle"]}', headers={"X-Raw-Workspace": workspace})
                assert state.json()["revision"] == doc["revision"]
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc))
                assert response.status_code == 200, response.text
                assert response.content == png()
                assert children[0].render_count == 1
                assert response.headers["x-raw-token"] == doc["documentToken"]
                assert response.headers["x-raw-generation"] == str(doc["generation"])
                assert response.headers["content-type"] == "image/png"
                assert response.headers["cache-control"] == "no-store"
                assert (await http.delete(f"/api/raw/workspaces/{workspace}")).status_code == 204
                assert not list(cache_root.iterdir())
                assert children[0].returncode is not None
                assert (await http.get(f'/api/raw/documents/{doc["handle"]}', headers={"X-Raw-Workspace": workspace})).status_code == 409
                assert (await http.get("/api/health")).status_code == 200
        finally: await api.close()
        assert not api._tasks and manager.status().state == "stopped"
    asyncio.run(run())


@pytest.mark.parametrize("change", ["workspace", "handle", "generation", "revision", "token", "extra", "oversize"])
def test_invalid_ownership_metadata_and_body_never_render(local, tmp_path, monkeypatch, change):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                body = preview_body(doc)
                handle = doc["handle"]
                if change == "workspace": body["workspaceId"] = "wrong"
                if change == "handle": handle = "wrong"
                if change == "generation": body["generation"] += 1
                if change == "revision": body["revision"] += 1
                if change == "token": body["documentToken"] = "wrong"
                if change == "extra": body["path"] = "PRIVATE"
                if change == "oversize": body["path"] = "x" * 4096
                response = await http.post(f"/api/raw/documents/{handle}/preview", json=body)
                assert response.status_code in (409, 413)
                assert children[0].render_count == 0 and "PRIVATE" not in response.text
        finally: await api.close()
    asyncio.run(run())


def test_stale_generation_and_child_failure_leave_jpeg_available(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, root = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                workspace, doc = await open_document(http)
                await manager.restart()
                await until(lambda: manager.status().state == "ready")
                response = await http.get(f'/api/raw/documents/{doc["handle"]}', headers={"X-Raw-Workspace": workspace})
                assert response.status_code == 409
                children[-1].exit(1)
                await until(lambda: manager.status().state == "failed")
                assert not (await http.get("/api/raw/capabilities")).json()["available"]
                assert (await http.get("/api/health")).status_code == 200
        finally: await api.close()
        assert not list(root.iterdir())
    asyncio.run(run())


def test_cancelled_http_waiter_does_not_cancel_render_or_delete_source(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, root = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                workspace, doc = await open_document(http)
                gate = children[0].gate = asyncio.Event()
                task = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc)))
                await children[0].render_started.wait()
                task.cancel()
                with pytest.raises(asyncio.CancelledError): await task
                release = asyncio.create_task(http.delete(f"/api/raw/workspaces/{workspace}"))
                await asyncio.sleep(.02)
                assert list(root.rglob("*.dng")) and manager.status().state == "ready"
                gate.set()
                assert (await release).status_code == 204
                assert not list(root.iterdir()) and not api._tasks
        finally: await api.close()
    asyncio.run(run())


def test_docker_app_has_no_raw_routes():
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as http:
            assert (await http.get("/raw/capabilities")).status_code == 404
            assert (await http.post("/raw/documents", json={})).status_code == 404
    asyncio.run(run())


def test_shutdown_during_preview_reaps_before_cache_cleanup(local, tmp_path, monkeypatch):
    async def run():
        api, manager, children, root = await setup(tmp_path, local, monkeypatch)
        async with client(local) as http:
            await authenticate(http, local)
            _, doc = await open_document(http)
            children[0].gate = asyncio.Event()
            task = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc)))
            await children[0].render_started.wait()
            await api.close()
            assert (await task).status_code == 502
            assert children[0].returncode is not None and manager.status().state == "stopped"
            assert not api._tasks and not list(root.iterdir())
    asyncio.run(run())


def test_invalid_native_png_never_returns_image_bytes(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                children[0].bad_image = True
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc))
                assert response.status_code == 502
                assert response.headers["content-type"] == "application/json"
                assert len(response.content) < 4096
        finally: await api.close()
    asyncio.run(run())


def test_shutdown_cancels_only_download_and_reclaims_its_partial(local, tmp_path, monkeypatch):
    async def run():
        api, manager, _, root = await setup(tmp_path, local, monkeypatch)
        original = Original(gate=asyncio.Event())
        async def acquire(_): return original, "dng"
        monkeypatch.setattr(module, "RawSourceCache", lambda: RawSourceCache(root=root, acquire=acquire))
        async with client(local) as http:
            await authenticate(http, local)
            workspace = (await http.post("/api/raw/workspaces", json={})).json()["workspaceId"]
            opening = asyncio.create_task(http.post("/api/raw/documents", json={"workspaceId": workspace, "assetId": str(uuid4())}))
            await until(lambda: bool(list(root.rglob("*.part"))))
            await api.close()
            assert (await opening).status_code == 502
            assert original.closed and not list(root.iterdir()) and not api._tasks
            assert manager.status().state == "stopped"
    asyncio.run(run())


def test_failed_native_close_never_deletes_an_in_use_source(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, root = await setup(tmp_path, local, monkeypatch)
        async with client(local) as http:
            await authenticate(http, local)
            await open_document(http)
        close = api.raw.close
        async def failed(): raise LightCraftError("lightcraft_cleanup_failed")
        monkeypatch.setattr(api.raw, "close", failed)
        with pytest.raises(LightCraftError, match="lightcraft_cleanup_failed"):
            await api.close()
        assert list(root.rglob("*.dng"))
        monkeypatch.setattr(api.raw, "close", close)
        await api.close()
        assert not list(root.iterdir())
    asyncio.run(run())


def test_cancelled_shutdown_waits_for_owned_process_and_cache_cleanup(local, tmp_path, monkeypatch):
    async def run():
        api, manager, _, root = await setup(tmp_path, local, monkeypatch)
        async with client(local) as http:
            await authenticate(http, local)
            await open_document(http)
        entered, gate = asyncio.Event(), asyncio.Event()
        close = api.raw.close
        async def delayed():
            entered.set()
            await gate.wait()
            await close()
        monkeypatch.setattr(api.raw, "close", delayed)
        closing = asyncio.create_task(api.close())
        await entered.wait()
        closing.cancel()
        gate.set()
        with pytest.raises(asyncio.CancelledError): await closing
        assert manager.status().state == "stopped" and not list(root.iterdir())
    asyncio.run(run())


def test_expired_workspace_releases_native_source_and_allows_new_owner(local, tmp_path, monkeypatch):
    async def run():
        monkeypatch.setattr(module, "LEASE_POLL_SECONDS", .01)
        api, _, children, root = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                await open_document(http)
                api._touched -= module.LEASE_SECONDS + 1
                await until(lambda: api.workspace is None)
                assert children[0].returncode is not None and not list(root.iterdir())
                assert (await http.post("/api/raw/workspaces", json={})).status_code == 200
        finally: await api.close()
    asyncio.run(run())
