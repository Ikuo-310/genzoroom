import asyncio
from io import BytesIO
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest
from PIL import ExifTags, Image, ImageFile, TiffImagePlugin

import genzoroom_tag_repair as repair_module
import main
from export_artifact import is_genzoroom_export_filename
from genzoroom_tag_repair import GenzoRoomTagRepair
from immich import RecentAsset
from immich_tags import assign_genzoroom_tag
from jpeg_metadata import has_genzoroom_export_marker


ASSET, TAG = UUID(int=71), UUID(int=72)


def jpeg(software=None, *, xmp=b""):
    exif = Image.Exif()
    if software is not None:
        exif[ExifTags.Base.Software] = software
        if type(software) is bytes:
            # Store an actual UNDEFINED field rather than letting Pillow encode bytes as ASCII.
            directory = TiffImagePlugin.ImageFileDirectory_v2()
            directory[ExifTags.Base.Software] = software
            directory.tagtype[ExifTags.Base.Software] = 7
            exif = b"Exif\0\0II\x2a\x00\x08\x00\x00\x00" + directory.tobytes(8)
    buffer = BytesIO()
    with Image.new("RGB", (2, 2)) as image:
        image.save(buffer, "JPEG", exif=exif, xmp=xmp)
    return buffer.getvalue()


def asset(state=False, filename="IMG-Genzo01.jpg", asset_id=ASSET):
    return RecentAsset(id=asset_id, filename=filename, date="2026-10-01T00:00:00Z",
        thumbnail_url="", format="JPEG", is_raw=False, isGenzoRoomExport=state)


@pytest.mark.parametrize("filename,expected", [
    ("IMG-Genzo01.jpg", True), ("IMG-Genzo123.jpg", True), ("IMG-Genzo00.jpg", False),
    ("IMG-Genzo1.jpg", False), ("IMG-Genzo" + "9" * 5000 + ".jpg", True),
    ("IMG-Genzo.jpg", False), ("IMG-GenzoAA.jpg", False), ("IMG-Genzo01.png", False),
    ("IMG-Genzo01.jpeg", False), ("IMG-genzo01.jpg", False), ("IMG-Genzo01-edit.jpg", False),
    ("IMG-Genzo01.JPG", False), ("-Genzo01.jpg", False), ("IMG.edit-Genzo01.jpg", False),
    ("IMG-Genzo01.jpg\n", False), ("dir/IMG-Genzo01.jpg", False),
])
def test_filename_uses_export_suffix_without_decimal_conversion(filename, expected):
    assert is_genzoroom_export_filename(filename) is expected


@pytest.mark.parametrize("software,expected", [
    ("GenzoRoom", True), (None, False), ("genzoroom", False), ("GenzoRoom 1.0", False),
    (" GenzoRoom", False), ("GenzoRoom\0", False), (123, False), (b"GenzoRoom", False),
])
def test_marker_is_exact_and_does_not_decode_pixels(software, expected, monkeypatch):
    data = jpeg(software)
    def forbidden(*args, **kwargs):
        raise AssertionError("Pixel decode is forbidden")
    monkeypatch.setattr(Image.Image, "load", forbidden)
    monkeypatch.setattr(ImageFile.ImageFile, "load", forbidden)
    assert has_genzoroom_export_marker(data) is expected


def test_xmp_alone_is_not_a_marker():
    assert not has_genzoroom_export_marker(jpeg(xmp=b'<xmp CreatorTool="GenzoRoom"/>'))


@pytest.mark.parametrize("data", [b"bad", jpeg("GenzoRoom")[:-2]], ids=["not_jpeg", "truncated"])
def test_corrupt_container_or_exif_is_controlled(data):
    with pytest.raises(ValueError, match="invalid_jpeg_metadata"):
        has_genzoroom_export_marker(data)


def test_malformed_exif_never_matches():
    data = jpeg("GenzoRoom").replace(b"MM\x00\x2a", b"bad!", 1)
    try:
        assert not has_genzoroom_export_marker(data)
    except ValueError as error:
        assert str(error) == "invalid_jpeg_metadata"


class Original:
    def __init__(self, data, *, failure=False, declared=None, gate=None):
        self.data, self.failure, self.gate = data, failure, gate
        self.closed = False
        self.response = SimpleNamespace(headers={} if declared is None else {"content-length": str(declared)})

    async def chunks(self):
        if self.gate is not None:
            await self.gate.wait()
        yield self.data
        if self.failure:
            raise httpx.ReadError("private upstream body")

    async def close(self):
        self.closed = True


def mock_original(monkeypatch, originals, calls):
    async def get(*args, **kwargs):
        calls.append(args[2])
        value = originals[len(calls) - 1]
        if isinstance(value, Exception):
            raise value
        return value
    monkeypatch.setattr(repair_module, "get_asset_original", get)


def write_transport(calls, *, count=1, confirmed=True, failed=False):
    def handler(request):
        calls.append((request.method, request.url.path))
        if failed:
            return httpx.Response(503, json={})
        if request.url.path.endswith("/tags"):
            return httpx.Response(200, json=[{"id": str(TAG), "name": "GenzoRoom", "value": "GenzoRoom"}])
        if request.url.path.endswith("/tags/assets"):
            return httpx.Response(200, json={"count": count})
        return httpx.Response(200, json={"id": str(ASSET),
            "tags": [{"id": str(TAG), "value": "GenzoRoom"}] if confirmed else []})
    return httpx.MockTransport(handler)


@pytest.mark.parametrize("count,confirmed,success", [(1, False, True), (0, True, True),
    (0, False, False), (True, True, False), (2, True, False)])
def test_shared_write_helper_preserves_count_verification(count, confirmed, success):
    calls = []
    async def run():
        async with httpx.AsyncClient(trust_env=False, transport=write_transport(calls, count=count, confirmed=confirmed)) as client:
            if success:
                assert await assign_genzoroom_tag(client, "http://immich/api", {}, ASSET) == TAG
            else:
                with pytest.raises(ValueError):
                    await assign_genzoroom_tag(client, "http://immich/api", {}, ASSET)
    asyncio.run(run())
    assert len(calls) == (3 if type(count) is int and count == 0 else 2)


@pytest.mark.parametrize("state,filename,software,reads,writes", [
    (False, "IMG-Genzo01.jpg", "GenzoRoom", 1, 2),
    (True, "IMG-Genzo01.jpg", "GenzoRoom", 0, 0),
    (None, "IMG-Genzo01.jpg", "GenzoRoom", 0, 0),
    (False, "ordinary.jpg", "GenzoRoom", 0, 0),
    (False, "IMG-Genzo01.jpg", "Other", 1, 0),
    (False, "IMG-Genzo01.jpg", None, 1, 0),
])
def test_repair_requires_all_three_conditions(monkeypatch, state, filename, software, reads, writes):
    read_calls, write_calls = [], []
    original = Original(jpeg(software))
    mock_original(monkeypatch, [original], read_calls)
    service = GenzoRoomTagRepair("http://immich/api", "key", transport=write_transport(write_calls))
    async def run():
        await service.submit([asset(state, filename)])
        if service._task:
            await service._task
        await service.close()
    asyncio.run(run())
    assert len(read_calls) == reads and len(write_calls) == writes
    assert original.closed is bool(reads)


@pytest.mark.parametrize("failure", ["fetch", "partial", "corrupt", "length", "size", "write"])
def test_failures_are_warning_only_and_release_streams(monkeypatch, failure):
    read_calls, write_calls, logs = [], [], []
    original = Original(b"bad" if failure == "corrupt" else jpeg("GenzoRoom"),
        failure=failure == "partial", declared=1 if failure == "length" else None)
    mock_original(monkeypatch, [httpx.ReadTimeout("private") if failure == "fetch" else original], read_calls)
    if failure == "size":
        monkeypatch.setattr(repair_module, "MAX_ORIGINAL_BYTES", 1)
    monkeypatch.setattr(repair_module, "_log", lambda *args, **kwargs: logs.append((args, kwargs)))
    service = GenzoRoomTagRepair("http://immich/api", "key", transport=write_transport(write_calls, failed=failure == "write"))
    async def run():
        await service.submit([asset()])
        await service._task
        assert not service._in_flight
        await service.close()
    asyncio.run(run())
    assert original.closed is (failure != "fetch")
    assert len(write_calls) == (1 if failure == "write" else 0)
    assert logs[-1][1]["level"] == "warn"
    assert "private" not in str(logs) and "IMG" not in str(logs)


def test_one_worker_deduplicates_across_views_and_cancellation_closes_stream(monkeypatch):
    async def run():
        gate = asyncio.Event()
        reads, writes = [], []
        original = Original(jpeg("GenzoRoom"), gate=gate)
        mock_original(monkeypatch, [original, Original(jpeg("GenzoRoom"))], reads)
        service = GenzoRoomTagRepair("http://immich/api", "key", transport=write_transport(writes))
        await service.submit([asset()])
        await asyncio.sleep(0)
        await service.submit([asset(), asset(asset_id=UUID(int=73))])
        await asyncio.sleep(0)
        assert reads == [ASSET]
        assert len(service._in_flight) == 2
        await service.close()
        assert original.closed and not writes
        assert not service._in_flight and not service._pending
    asyncio.run(run())


def test_queue_and_negative_cache_are_bounded(monkeypatch):
    monkeypatch.setattr(repair_module, "MAX_PENDING_REPAIRS", 2)
    monkeypatch.setattr(repair_module, "MAX_NEGATIVE_CACHE", 1)
    reads = []
    mock_original(monkeypatch, [Original(jpeg()), Original(jpeg())], reads)
    service = GenzoRoomTagRepair("http://immich/api", "key")
    async def run():
        await service.submit([asset(asset_id=UUID(int=i)) for i in range(1, 5)])
        assert len(service._in_flight) == 2
        await service._task
        assert list(service._negative) == [UUID(int=2)]
        await service.submit([asset(asset_id=UUID(int=2))])
        assert len(reads) == 2
        await service.close()
    asyncio.run(run())


@pytest.mark.parametrize("path,fetch", [
    ("/assets/recent", "get_recent_assets"), ("/assets/favorites", "get_favorite_assets"),
    (f"/albums/{ASSET}/assets", "get_album_assets"),
    ("/calendar/2026-10-01/assets", "get_calendar_day_assets"),
])
@pytest.mark.parametrize("failure", ["fetch", "write", "blocked"])
def test_home_returns_before_repair_and_survives_failure(monkeypatch, path, fetch, failure):
    async def run():
        async def home(*args, **kwargs):
            return [asset()]
        monkeypatch.setattr(main, fetch, home)
        reads, writes = [], []
        gate = asyncio.Event() if failure == "blocked" else None
        original = Original(jpeg("GenzoRoom"), gate=gate)
        mock_original(monkeypatch, [httpx.ReadTimeout("private") if failure == "fetch" else original], reads)
        service = GenzoRoomTagRepair("http://immich/api", "key", transport=write_transport(writes, failed=failure == "write"))
        monkeypatch.setattr(main.app.state, "tag_repair", service, raising=False)
        async with httpx.AsyncClient(trust_env=False, transport=httpx.ASGITransport(app=main.app), base_url="http://local") as client:
            response = await asyncio.wait_for(client.get(path), 1)
        assert response.status_code == 200 and response.json()[0]["isGenzoRoomExport"] is False
        if failure == "blocked":
            await asyncio.sleep(0)
            assert not service._task.done()
            gate.set()
        await service._task
        assert len(reads) == 1
        assert len(writes) == (2 if failure == "blocked" else 1 if failure == "write" else 0)
        await service.close()
    asyncio.run(run())
