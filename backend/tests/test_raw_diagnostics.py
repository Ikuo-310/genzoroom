import asyncio
import json
from uuid import uuid4

import httpx
import pytest

import main
import raw_diagnostics as module
from raw_source import RawSourceCache
from tests.test_lightcraft_mcp import until
from tests.test_raw_source import Original
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_lightcraft_runtime import FakeProcess
from lightcraft_mcp import LightCraftError
from lightcraft_raw import LightCraftRawSession, RawTimeouts


def config(**changes):
    return {"assetId": str(uuid4()), "quality": "both", "stageCache": "both", "backend": "cpu",
            "temperature": "both", "repeats": 2, "budgetBytes": 1024**3, **changes}


@pytest.mark.parametrize("outcome,backend,reason", [
    ("gpu_success", "gpu", "none"),
    ("cpu_not_tried", "cpu", "gpu_unavailable"),
    ("cpu_fallback", "cpu", "gpu_failed"),
])
def test_render_local_execution_reaches_a4_and_structured_logs(local, tmp_path, monkeypatch, outcome, backend, reason):
    import lightcraft_raw
    events = []
    monkeypatch.setattr(lightcraft_raw, "lightcraft_log", lambda event, **context: events.append((event, context)))
    execution = {"outcome": outcome, "backend": backend, "reason": reason}
    async def run():
        diag, editing, _, children, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                started = (await http.post("/api/developer/raw-preview/start", json=config(
                    backend="gpu", quality="full", stageCache="off", temperature="cold", repeats=1))).json()
                body = {"runId": started["runId"], "index": 0}
                assert (await http.post("/api/developer/raw-preview/prepare", json=body)).status_code == 200
                children[-1].execution = execution
                # A stale process-wide fallback must not override this render's successful result.
                children[-1].gpu["lastFallback"] = "older failure"
                response = await http.post("/api/developer/raw-preview/render", json=body)
                assert response.status_code == 200, response.text
                meta = json.loads(response.headers["x-raw-diagnostic"])
                assert meta["metrics"]["execution"] == execution
                assert meta["backend"]["execution"] == backend
                assert meta["backend"]["fallbackReported"] == (outcome == "cpu_fallback")
                assert any(e == "preview.measured" and c.get("execution") == execution for e, c in events)
                assert any(e == "preview.gpuFallback" and c.get("level") == "warn" for e, c in events) == (outcome == "cpu_fallback")
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())


async def diagnostic_setup(tmp_path, local, monkeypatch):
    editing, manager, children, _ = await setup(tmp_path, local, monkeypatch)
    root = tmp_path / "diagnostic-sources"
    root.mkdir()
    downloads = []
    async def acquire(asset):
        downloads.append(asset)
        return Original(), "dng"
    monkeypatch.setattr(module, "RawSourceCache", lambda: RawSourceCache(root=root, acquire=acquire))
    spawn = manager._spawn
    async def diagnostic_spawn(*args, **kwargs):
        child = await spawn(*args, **kwargs)
        child.adaptive_supported = True
        enabled = kwargs["env"]["LIGHTCRAFT_GPU_BACKEND"] != "off"
        child.gpu = {"enabled": enabled, "available": enabled, "adapter": None, "reason": None, "lastFallback": None}
        respond = child.respond
        def with_gpu(message):
            if message["method"] == "tools/call" and message["params"]["arguments"].get("id") == "app.gpu":
                return FakeProcess.respond(child, message)
            return respond(message)
        child.stdin.respond = with_gpu
        return child
    manager._spawn = diagnostic_spawn
    return local.raw_diagnostics, editing, manager, children, downloads


def test_isolated_quality_cache_cold_warm_and_no_persistence(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, manager, children, downloads = await diagnostic_setup(tmp_path, local, monkeypatch)
        normal_generation = manager.status().generation
        try:
            async with client(local) as http:
                await authenticate(http, local)
                response = await http.post("/api/developer/raw-preview/start", json=config())
                assert response.status_code == 200, response.text
                run_id, plan = response.json()["runId"], response.json()["plan"]
                assert len(plan) == 16
                assert (await http.post("/api/raw/workspaces", json={})).json()["code"] == "raw_busy"
                for trial in plan:
                    body = {"runId": run_id, "index": trial["index"]}
                    prepared = await http.post("/api/developer/raw-preview/prepare", json=body)
                    assert prepared.status_code == 200, prepared.text
                    response = await http.post("/api/developer/raw-preview/render", json=body)
                    assert response.status_code == 200, response.text
                    metadata = json.loads(response.headers["x-raw-diagnostic"])
                    assert metadata["trial"] == trial and metadata["backend"]["execution"] == "cpu"
                    assert metadata["metrics"]["stageCache"]["mode"] == trial["stageCache"]
                    assert metadata["metrics"]["nativeMs"] >= 0 and metadata["metrics"]["validationMs"] >= 0
                    assert metadata["rssBytes"] is None and metadata["vramBytes"] is None
                    assert metadata["metrics"]["pngSha256"] is not None if trial["quality"] == "full" else metadata["metrics"]["pngSha256"] is None
                await http.post("/api/developer/raw-preview/stop", json={"runId": run_id})
                await until(lambda: diag.run is None)
                assert len(downloads) == 1
                assert manager.status().generation == normal_generation
                assert children[0].photos == {} and editing.workspace is None
                assert editing._history_save is None and editing._recipe_save is None
                # Each cold sample gets its own process; warm samples share a process after one warmup.
                assert len(children) == 1 + 4 * 3
                assert sum(child.render_count for child in children[1:]) == 16 + 4
                assert all(child.returncode is not None for child in children[1:])
                assert (await http.post("/api/raw/workspaces", json={})).status_code == 200
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())


def test_editing_workspace_prevents_diagnostics(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, _, children, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                before = editing.document.copy()
                response = await http.post("/api/developer/raw-preview/start", json=config())
                assert response.status_code == 409 and editing.document == before
                assert len(children) == 1 and children[0].photos
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())


def test_stop_collects_transmitted_render_without_aborting_process(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, _, children, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                started = (await http.post("/api/developer/raw-preview/start", json=config(quality="full", stageCache="off", temperature="cold", repeats=1))).json()
                body = {"runId": started["runId"], "index": 0}
                assert (await http.post("/api/developer/raw-preview/prepare", json=body)).status_code == 200
                child = children[-1]
                child.gate = asyncio.Event()
                rendering = asyncio.create_task(http.post("/api/developer/raw-preview/render", json=body))
                await child.render_started.wait()
                assert (await http.post("/api/developer/raw-preview/stop", json={"runId": started["runId"]})).status_code == 200
                await asyncio.sleep(.02)
                assert not rendering.done() and child.returncode is None
                child.gate.set()
                response = await rendering
                assert response.json()["code"] == "raw_diagnostic_cancelled"
                assert diag.run is None and child.returncode is not None and not child.kills
        finally:
            if len(children) > 1 and children[-1].gate:
                children[-1].gate.set()
            await diag.close()
            await editing.close()
    asyncio.run(run())


@pytest.mark.parametrize("patch", [{"assetId": "C:/private.dng"}, {"repeats": 6}, {"budgetBytes": 0},
    {"budgetBytes": 1024**3 + 1}, {"backend": "arbitrary"}, {"quality": "fast"}, {"maxSide": 8192}])
def test_invalid_diagnostic_conditions_rejected(patch):
    with pytest.raises(Exception, match="raw_invalid_request"):
        module.trial_plan(config(**patch))


def test_raw_diagnostic_route_not_exposed_by_docker():
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as http:
            assert (await http.post("/api/developer/raw-preview/start", json=config())).status_code == 404
    asyncio.run(run())


def test_diagnostic_access_requires_local_auth_origin_and_host(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, _, _, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                url = "/api/developer/raw-preview/start"
                assert (await http.post(url, json=config())).status_code == 401
                await authenticate(http, local)
                for headers in ({"Origin": "http://evil.example"}, {"Host": "evil.example"}):
                    assert (await http.post(url, json=config(), headers=headers)).status_code == 403
                assert diag.run is None
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())


def test_cleanup_failure_retains_owner_and_can_be_retried(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, _, _, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                started = (await http.post("/api/developer/raw-preview/start", json=config())).json()
                body = {"runId": started["runId"]}
                assert (await http.post("/api/developer/raw-preview/prepare", json=body | {"index": 0})).status_code == 200
                original = diag.raw.close
                async def fail():
                    raise LightCraftError("lightcraft_cleanup_failed")
                monkeypatch.setattr(diag.raw, "close", fail)
                await http.post("/api/developer/raw-preview/stop", json=body)
                await until(lambda: diag._op is None)
                assert diag.run["state"] == "cleanup_failed" and diag.raw is not None and diag.cache is not None
                assert (await http.post("/api/raw/workspaces", json={})).json()["code"] == "raw_busy"
                monkeypatch.setattr(diag.raw, "close", original)
                await http.post("/api/developer/raw-preview/stop", json=body)
                await until(lambda: diag.run is None)
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())


def test_timeout_reaps_only_diagnostic_process_and_never_exports_gpu_text(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, manager, children, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        monkeypatch.setattr(module, "LightCraftRawSession", lambda owner, **kwargs: LightCraftRawSession(owner,
            timeouts=RawTimeouts(admission=.5, command=1, import_raw=2, preview=.04, validation=1, ready=1), **kwargs))
        try:
            async with client(local) as http:
                await authenticate(http, local)
                started = (await http.post("/api/developer/raw-preview/start", json=config(backend="gpu", quality="full", stageCache="off", temperature="cold"))).json()
                body = {"runId": started["runId"], "index": 0}
                await http.post("/api/developer/raw-preview/prepare", json=body)
                child = children[-1]
                child.gpu["lastFallback"] = "PRIVATE C:/secret.dng API_KEY"
                response = await http.post("/api/developer/raw-preview/render", json=body)
                metadata = json.loads(response.headers["x-raw-diagnostic"])
                assert metadata["backend"]["execution"] == "unconfirmed" and metadata["backend"]["fallbackReported"]
                assert "PRIVATE" not in json.dumps(metadata)
                body["index"] = 1
                await http.post("/api/developer/raw-preview/prepare", json=body)
                child = children[-1]
                child.gate = asyncio.Event()
                response = await http.post("/api/developer/raw-preview/render", json=body)
                assert response.status_code == 502
                assert diag.run is None and child.returncode is not None
                assert manager.status().state == "ready" and children[0].returncode is None
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())


def test_app_close_collects_render_and_duplicate_start_cannot_steal_owner(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, manager, children, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                started = (await http.post('/api/developer/raw-preview/start', json=config())).json()
                assert (await http.post('/api/developer/raw-preview/start', json=config())).status_code == 409
                assert (await http.post('/api/developer/raw-preview/stop', json={'runId': 'wrong'})).status_code == 409
                body = {'runId': started['runId'], 'index': 0}
                await http.post('/api/developer/raw-preview/prepare', json=body)
                child = children[-1]
                child.gate = asyncio.Event()
                rendering = asyncio.create_task(http.post('/api/developer/raw-preview/render', json=body))
                await child.render_started.wait()
                closing = asyncio.create_task(diag.close())
                await asyncio.sleep(.02)
                assert not closing.done() and child.returncode is None
                child.gate.set()
                await rendering
                await closing
                assert diag.run is None and diag.cache is None and not child.kills
                assert child.returncode is not None and manager.status().state == 'ready'
        finally:
            if len(children) > 1 and children[-1].gate:
                children[-1].gate.set()
            await diag.close()
            await editing.close()
    asyncio.run(run())
