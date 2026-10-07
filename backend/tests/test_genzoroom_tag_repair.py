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
from jpeg_metadata import GenzoRoomMarker, inspect_genzoroom_export_marker
from tests.test_export_artifact import artifact, jpeg as artifact_jpeg


ASSET, TAG = UUID(int=71), UUID(int=72)


def jpeg(software=None, *, xmp=b"", progressive=False):
    exif = Image.Exif()
    if software is not None:
        exif[ExifTags.Base.Software] = software
        if type(software) in (bytes, int):
            # Force the TIFF type; Pillow's Software writer otherwise coerces integers to ASCII.
            directory = TiffImagePlugin.ImageFileDirectory_v2()
            directory[ExifTags.Base.Software] = software
            directory.tagtype[ExifTags.Base.Software] = 7 if type(software) is bytes else 3
            exif = b"Exif\0\0II\x2a\x00\x08\x00\x00\x00" + directory.tobytes(8)
    buffer = BytesIO()
    with Image.new("RGB", (2, 2)) as image:
        image.save(buffer, "JPEG", exif=exif, xmp=xmp, progressive=progressive)
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
    ("GenzoRoom", GenzoRoomMarker.MATCH), (None, GenzoRoomMarker.NO_MATCH),
    ("genzoroom", GenzoRoomMarker.NO_MATCH), ("GenzoRoom 1.0", GenzoRoomMarker.NO_MATCH),
    (" GenzoRoom", GenzoRoomMarker.NO_MATCH), ("GenzoRoom\0", GenzoRoomMarker.NO_MATCH),
    ("123", GenzoRoomMarker.NO_MATCH),
    (123, GenzoRoomMarker.INVALID), (b"GenzoRoom", GenzoRoomMarker.INVALID),
])
def test_marker_is_exact_and_does_not_decode_pixels(software, expected, monkeypatch):
    data = jpeg(software)
    def forbidden(*args, **kwargs):
        raise AssertionError("Pixel decode is forbidden")
    monkeypatch.setattr(Image.Image, "load", forbidden)
    monkeypatch.setattr(ImageFile.ImageFile, "load", forbidden)
    assert inspect_genzoroom_export_marker(data) is expected


def test_xmp_alone_is_not_a_marker():
    assert inspect_genzoroom_export_marker(jpeg(xmp=b'<xmp CreatorTool="GenzoRoom"/>')) is GenzoRoomMarker.NO_MATCH


@pytest.mark.parametrize("progressive", [False, True])
def test_normal_jpeg_without_exif_is_no_match(progressive):
    buffer = BytesIO()
    with Image.new("RGB", (5, 7)) as image:
        image.save(buffer, "JPEG", progressive=progressive)
    assert inspect_genzoroom_export_marker(buffer.getvalue()) is GenzoRoomMarker.NO_MATCH


def test_progressive_jpeg_with_exact_marker_matches():
    assert inspect_genzoroom_export_marker(jpeg("GenzoRoom", progressive=True)) is GenzoRoomMarker.MATCH


@pytest.mark.parametrize("data", [b"bad", jpeg("GenzoRoom")[:-2]], ids=["not_jpeg", "truncated"])
def test_corrupt_container_or_exif_is_controlled(data):
    assert inspect_genzoroom_export_marker(data) is GenzoRoomMarker.INVALID


def test_malformed_exif_never_matches():
    data = jpeg("GenzoRoom").replace(b"MM\x00\x2a", b"bad!", 1)
    assert inspect_genzoroom_export_marker(data) is GenzoRoomMarker.INVALID


def test_real_export_artifact_matches_without_pixel_decode(monkeypatch):
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "Camera"
    exif[ExifTags.Base.ExifOffset] = {ExifTags.Base.ExposureTime: TiffImagePlugin.IFDRational(1, 125)}
    exif[ExifTags.Base.GPSInfo] = {ExifTags.GPS.GPSLatitudeRef: "N",
        ExifTags.GPS.GPSLatitude: (TiffImagePlugin.IFDRational(35), TiffImagePlugin.IFDRational(1), TiffImagePlugin.IFDRational(2))}
    data = artifact(artifact_jpeg(exif)).jpeg
    def forbidden(*args, **kwargs):
        raise AssertionError("Pixel decode is forbidden")
    monkeypatch.setattr(Image.Image, "load", forbidden)
    monkeypatch.setattr(ImageFile.ImageFile, "load", forbidden)
    assert inspect_genzoroom_export_marker(data) is GenzoRoomMarker.MATCH


def without_marker(data, marker):
    while marker in data:
        start = data.index(marker)
        length = int.from_bytes(data[start + 2:start + 4], "big")
        data = data[:start] + data[start + 2 + length:]
    return data


def test_missing_quantization_tables_is_invalid_even_with_readable_marker():
    data = without_marker(jpeg("GenzoRoom"), b"\xff\xdb")
    with Image.open(BytesIO(data)) as image:
        assert image.getexif()[ExifTags.Base.Software] == "GenzoRoom"
        with pytest.raises(OSError):
            image.load()
    assert data.endswith(b"\xff\xd9")
    assert inspect_genzoroom_export_marker(data) is GenzoRoomMarker.INVALID


@pytest.mark.parametrize("mode", ["missing_dqt", "missing_dht", "short_length", "overrun_length",
    "truncated_segment", "no_sos", "no_scan_data", "early_eoi", "bad_exif_offset"])
def test_repair_rejects_structural_damage(mode, monkeypatch):
    data = jpeg("GenzoRoom")
    if mode in ("missing_dqt", "missing_dht"):
        data = without_marker(data, b"\xff\xdb" if mode == "missing_dqt" else b"\xff\xc4")
    elif mode in ("short_length", "overrun_length", "truncated_segment"):
        start = data.index(b"\xff\xdb")
        if mode == "truncated_segment":
            data = data[:start + 10] + b"\xff\xd9"
        else:
            data = data[:start + 2] + (b"\x00\x01" if mode == "short_length" else b"\xff\xff") + data[start + 4:]
    elif mode in ("no_sos", "no_scan_data", "early_eoi"):
        start = data.index(b"\xff\xda")
        end = start + 2 + int.from_bytes(data[start + 2:start + 4], "big")
        data = data[:end if mode == "no_scan_data" else start] + b"\xff\xd9"
        if mode == "early_eoi":
            data += b"unexpected trailing bytes"
    else:
        data = data.replace(b"MM\x00\x2a\x00\x00\x00\x08", b"MM\x00\x2a\xff\xff\xff\xff", 1)
    assert inspect_genzoroom_export_marker(data) is GenzoRoomMarker.INVALID
    reads, writes = [], []
    original = Original(data)
    mock_original(monkeypatch, [original], reads)
    service = GenzoRoomTagRepair("http://immich/api", "key", transport=write_transport(writes))
    async def run():
        await service.submit([asset()])
        await service._task
        assert not service._negative and not service._in_flight
        await service.close()
    asyncio.run(run())
    assert original.closed and not writes


def test_broken_exif_is_retryable_and_restores_tag_on_next_home_load(monkeypatch):
    reads, writes, logs = [], [], []
    broken = Original(jpeg("GenzoRoom").replace(b"MM\x00\x2a", b"bad!", 1))
    fixed = Original(artifact().jpeg)
    mock_original(monkeypatch, [broken, fixed], reads)
    monkeypatch.setattr(repair_module, "_log", lambda *args, **kwargs: logs.append((args, kwargs)))
    service = GenzoRoomTagRepair("http://immich/api", "key", transport=write_transport(writes))
    async def run():
        await service.submit([asset()])
        await service._task
        assert not writes and not service._negative and not service._in_flight
        assert logs[-1][0] == ("tagRepair.failed",)
        assert logs[-1][1]["level"] == "warn"
        assert logs[-1][1]["errorCode"] == "invalid_jpeg_metadata"
        await service.submit([asset()])
        await service._task
        assert len(reads) == 2 and len(writes) == 2
        assert logs[-1][0] == ("tagRepair.completed",)
        await service.close()
    asyncio.run(run())
    assert broken.closed and fixed.closed


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
        assert not service._negative
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
        assert not service._negative
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
