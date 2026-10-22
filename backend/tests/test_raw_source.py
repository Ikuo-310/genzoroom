import asyncio
import threading
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

import raw_source as module
from lightcraft_mcp import LightCraftError
from raw_source import RawSourceCache, get_raw_original


class Original:
    def __init__(self, data=b"raw-original", *, length=None, error=False, gate=None):
        self.data, self.error, self.gate = data, error, gate
        self.closed = False
        self.response = SimpleNamespace(headers={} if length is None else {"content-length": str(length)})

    async def chunks(self):
        yield self.data
        if self.gate:
            await self.gate.wait()
        if self.error:
            raise httpx.ReadError("PRIVATE original path")

    async def close(self):
        self.closed = True


def test_raw_download_uses_read_only_original_endpoint_and_existing_auth(monkeypatch):
    asset = uuid4()
    monkeypatch.setenv("IMMICH_URL", "http://immich.example")
    monkeypatch.setenv("IMMICH_API_KEY", "secret")
    async def detail(*args, **kwargs):
        return SimpleNamespace(id=asset, is_raw=True, format="DNG")
    monkeypatch.setattr(module, "get_asset_detail", detail)
    calls = []
    def handler(request):
        calls.append(request)
        assert request.method == "GET" and request.url.path == f"/api/assets/{asset}/original"
        assert request.headers["x-api-key"] == "secret"
        return httpx.Response(200, content=b"RAW", headers={"Content-Type": "image/x-adobe-dng"})
    async def run():
        original, extension = await get_raw_original(asset, transport=httpx.MockTransport(handler))
        assert extension == "dng"
        assert b"".join([chunk async for chunk in original.chunks()]) == b"RAW"
        assert original.response.is_closed
    asyncio.run(run())
    assert len(calls) == 1


@pytest.mark.parametrize("kind", ["JPEG", "PNG", "unknown"])
def test_non_raw_never_downloads_original(monkeypatch, kind):
    monkeypatch.setenv("IMMICH_URL", "http://immich.example")
    monkeypatch.setenv("IMMICH_API_KEY", "secret")
    async def detail(*args, **kwargs):
        return SimpleNamespace(id=args[2], is_raw=kind == "unknown", format=kind)
    monkeypatch.setattr(module, "get_asset_detail", detail)
    async def run():
        with pytest.raises(LightCraftError, match="raw_unsupported_source"):
            await get_raw_original(uuid4(), transport=httpx.MockTransport(lambda _: pytest.fail("original fetched")))
    asyncio.run(run())


@pytest.mark.parametrize("failure,code", [
    ("declared", "raw_source_too_large"), ("stream", "raw_source_too_large"),
    ("cache", "raw_cache_capacity"), ("disk", "raw_disk_capacity"),
    ("incomplete", "raw_source_incomplete"), ("network", "raw_download_failed"),
    ("timeout", "raw_download_timeout"),
])
def test_download_limits_and_partial_cleanup(tmp_path, monkeypatch, failure, code):
    async def run():
        original = Original(length=999 if failure in {"declared", "incomplete"} else None,
                            error=failure == "network", gate=asyncio.Event() if failure == "timeout" else None)
        async def acquire(_): return original, "dng"
        cache = RawSourceCache(root=tmp_path, acquire=acquire)
        if failure == "declared": monkeypatch.setattr(module, "MAX_RAW_BYTES", 50)
        if failure == "stream": monkeypatch.setattr(module, "MAX_RAW_BYTES", 3)
        if failure == "cache": monkeypatch.setattr(module, "MAX_CACHE_BYTES", 3)
        if failure == "disk": monkeypatch.setattr(module.shutil, "disk_usage", lambda _: SimpleNamespace(free=1))
        if failure == "timeout": monkeypatch.setattr(module, "DOWNLOAD_SECONDS", .05)
        with pytest.raises(LightCraftError, match=code):
            await cache.download(uuid4())
        assert original.closed
        await cache.close()
        assert list(tmp_path.iterdir()) == []
    asyncio.run(run())


def test_completed_source_is_private_and_cleanup_preserves_neighbors(tmp_path):
    sentinel = tmp_path / "keep.DNG"
    sentinel.write_bytes(b"untouched")
    async def run():
        original = Original()
        async def acquire(_): return original, "dng"
        cache = RawSourceCache(root=tmp_path, acquire=acquire)
        path = await cache.download(uuid4())
        assert path.read_bytes() == original.data and path.suffix == ".dng"
        assert not list(path.parent.glob("*.part"))
        await cache.close()
        assert sentinel.read_bytes() == b"untouched"
    asyncio.run(run())


def test_stopped_download_releases_network_and_retains_owned_partial_until_cleanup(tmp_path):
    async def run():
        original = Original(gate=asyncio.Event())
        async def acquire(_): return original, "dng"
        cache = RawSourceCache(root=tmp_path, acquire=acquire)
        task = asyncio.create_task(cache.download(uuid4()))
        while not list(tmp_path.rglob("*.part")):
            await asyncio.sleep(.01)
        cache.stop_download()
        with pytest.raises(LightCraftError, match="raw_download_cancelled"):
            await task
        assert original.closed
        await cache.close()
        assert not list(tmp_path.iterdir())
    asyncio.run(run())


def test_timed_out_disk_worker_retains_cache_ownership_until_cleanup(tmp_path, monkeypatch):
    async def run():
        original = Original()
        async def acquire(_): return original, "dng"
        cache = RawSourceCache(root=tmp_path, acquire=acquire)
        gate = threading.Event()
        write = cache._write
        def delayed(path, data):
            with cache._lock:
                gate.wait()
            write(path, data)
        monkeypatch.setattr(cache, "_write", delayed)
        monkeypatch.setattr(module, "IO_SECONDS", .05)
        try:
            with pytest.raises(LightCraftError, match="lightcraft_temp_io_timeout"):
                await cache.download(uuid4())
            directory = cache.directory
            with pytest.raises(LightCraftError, match="raw_cache_cleanup_pending"):
                await cache.close()
            assert cache.directory == directory and directory.exists()
        finally:
            gate.set()
        monkeypatch.setattr(module, "IO_SECONDS", 5)
        await cache.close()
        assert not directory.exists()
    asyncio.run(run())


@pytest.mark.parametrize("cancel", [False, True])
def test_cleanup_timeout_or_cancel_keeps_one_worker_and_fixed_target(tmp_path, monkeypatch, cancel):
    async def run():
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        gate = threading.Event()
        async def acquire(_): return Original(), "dng"
        cache = RawSourceCache(root=tmp_path, acquire=acquire)
        path = await cache.download(uuid4())
        remove = cache._remove
        calls = []
        def delayed(*target):
            calls.append(target)
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            remove(*target)
        monkeypatch.setattr(cache, "_remove", delayed)
        try:
            if cancel:
                closing = asyncio.create_task(cache.close())
                await entered.wait()
                closing.cancel()
                with pytest.raises(asyncio.CancelledError): await closing
            else:
                with monkeypatch.context() as deadline:
                    deadline.setattr(module, "IO_SECONDS", 0)
                    with pytest.raises(LightCraftError, match="raw_cache_cleanup_pending"):
                        await cache.close()
                await entered.wait()
            worker = cache._io_worker
            assert cache.cleanup_pending and not worker[0].done()
            assert cache.directory == path.parent and path.exists()
            with pytest.raises(LightCraftError, match="raw_cache_closed"):
                await cache.download(uuid4())
            with monkeypatch.context() as deadline:
                deadline.setattr(module, "IO_SECONDS", 0)
                with pytest.raises(LightCraftError, match="raw_cache_cleanup_pending"):
                    await cache.close()
            assert cache._io_worker is worker and len(calls) == 1
            successor = RawSourceCache(root=tmp_path, acquire=acquire)
            next_path = await successor.download(uuid4())
        finally:
            gate.set()
        await cache.close()
        assert not cache.cleanup_pending and worker[0].done() and not path.exists()
        assert calls == [(path.parent, tmp_path.resolve(), True)]
        assert next_path.exists()
        await successor.close()
    asyncio.run(asyncio.wait_for(run(), 10))


def test_cleanup_waits_for_timed_out_creation_before_capturing_directory(tmp_path, monkeypatch):
    async def run():
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        gate = threading.Event()
        async def acquire(_): return Original(), "dng"
        cache = RawSourceCache(root=tmp_path, acquire=acquire)
        create = cache._create
        def delayed():
            loop.call_soon_threadsafe(entered.set)
            gate.wait()
            create()
        monkeypatch.setattr(cache, "_create", delayed)
        try:
            with monkeypatch.context() as deadline:
                deadline.setattr(module, "IO_SECONDS", 0)
                with pytest.raises(LightCraftError, match="lightcraft_temp_io_timeout"):
                    await cache.download(uuid4())
            await entered.wait()
            with monkeypatch.context() as deadline:
                deadline.setattr(module, "IO_SECONDS", 0)
                with pytest.raises(LightCraftError, match="raw_cache_cleanup_pending"):
                    await cache.close()
            assert cache._cleanup_target is None and cache.cleanup_pending
        finally:
            gate.set()
        await cache.close()
        assert cache._cleanup_target[2] is True
        assert not list(tmp_path.iterdir())
    asyncio.run(asyncio.wait_for(run(), 10))


def test_failed_worker_start_does_not_leave_unfinishable_io(tmp_path, monkeypatch):
    async def run():
        cache = RawSourceCache(root=tmp_path)
        def failed(_): raise RuntimeError("PRIVATE worker failure")
        with monkeypatch.context() as start:
            start.setattr(module.threading.Thread, "start", failed)
            with pytest.raises(LightCraftError, match="raw_cache_io_failed"):
                await cache._io(lambda: None)
            assert cache._io_worker[0].done()
        await cache.close()
        assert not cache.cleanup_pending
    asyncio.run(run())
