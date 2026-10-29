import asyncio
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image

import edit_store
import raw_recipe_store as raw
import raw_thumbnail_generator as generator
from lightcraft_raw import PreviewFrame
from thumbnail_cache import ThumbnailCache
from thumbnail_scheduler import ThumbnailScheduler
from tests.test_raw_recipe_store import identity, settings

ASSET = uuid4()


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "edits.db")
    edit_store.initialize_database()


def save(kind="edited"):
    baseline = settings()
    current = deepcopy(baseline)
    if kind != "default":
        current["light"]["exposure"] = .7
    return raw.put_raw_recipe(identity(assetId=str(ASSET)), 0, uuid4(), current,
        import_defaults_fingerprint=None if kind == "unknown" else raw._digest(raw._settings_json(baseline, 1)))


def frame(size=(1024, 683)):
    output = BytesIO()
    with Image.new("RGB", size, (130, 90, 60)) as image:
        image.save(output, format="PNG")
    return PreviewFrame(None, 2, 1, 1, *size, output.getvalue())


@pytest.mark.parametrize("kind,code", [("missing", "recipe_missing"), ("default", "recipe_default"),
                                       ("unknown", "recipe_unknown")])
def test_ineligible_does_not_fetch_or_start(db, monkeypatch, kind, code):
    if kind != "missing":
        save(kind)
    monkeypatch.setattr(generator, "get_asset_detail", lambda *a, **k: pytest.fail("unexpected fetch"))
    with pytest.raises(generator.ThumbnailGenerationError, match=code):
        asyncio.run(generator.generate_raw_thumbnail(ASSET, immich_url=None, api_key=None))


@pytest.mark.parametrize("failure", [False, True])
def test_saved_state_source_history_and_cache(db, tmp_path, monkeypatch, failure):
    key = identity(assetId=str(ASSET))
    baseline = settings()
    current = deepcopy(baseline)
    current["light"]["exposure"] = .7
    raw.append_raw_history(key, 0, uuid4(), current, kind="control",
        metadata={"control": "light.exposure"}, baseline_settings=baseline,
        import_defaults_fingerprint=raw._digest(raw._settings_json(baseline, 1)))
    saved = raw.get_raw_recipe(key)
    before = edit_store.DB_PATH.read_bytes()
    paths = []
    class Original:
        closed = False
        async def chunks(self):
            yield b"immutable RAW"
        async def close(self):
            self.closed = True
    original = Original()
    async def detail(*a, **k):
        return SimpleNamespace(is_raw=True, filename="arbitrary.PEF")
    async def fetch(*a, **k):
        assert k["allow_raw"] is True
        return original
    async def render(asset, path, recipe, **kw):
        assert asset == ASSET and recipe == saved["recipe"]
        assert path.read_bytes() == b"immutable RAW" and path.suffix == ".PEF"
        paths.append(path)
        if failure:
            raise ValueError("private failure")
        return generator._encode(frame())
    monkeypatch.setattr(generator, "get_asset_detail", detail)
    monkeypatch.setattr(generator, "get_asset_original", fetch)
    monkeypatch.setattr(generator, "render_raw_thumbnail", render)
    cache = ThumbnailCache(tmp_path / "cache")
    previous = generator._encode(frame((16, 16)))
    cache.store(ASSET, previous)
    if failure:
        with pytest.raises(generator.ThumbnailGenerationError, match="raw_thumbnail_failed"):
            asyncio.run(generator.generate_raw_thumbnail(ASSET, immich_url=None, api_key=None))
        assert cache.read(ASSET) == previous
    else:
        result = asyncio.run(generator.generate_raw_thumbnail(ASSET, immich_url=None, api_key=None))
        with Image.open(BytesIO(result)) as image:
            image.load()
            assert image.format == "JPEG" and image.size == (1024, 683) and image.info["icc_profile"]
        cache.store(ASSET, result)
        assert cache.read(ASSET) == result
    assert original.closed and not paths[0].parent.exists()
    assert edit_store.DB_PATH.read_bytes() == before
    assert raw.get_raw_recipe(identity(assetId=str(ASSET))) == saved


@pytest.mark.parametrize("failure", [None, "restore", "preview", "cancel"])
def test_isolated_session_settings_size_and_cleanup(tmp_path, monkeypatch, failure):
    source = tmp_path / "source.dng"
    source.write_bytes(b"immutable")
    recipe = {"settings": {"saved": True}}
    calls = []
    class Owned:
        async def start(self): calls.append("start")
        def status(self): return SimpleNamespace(state="ready")
        def _ready_client(self): return self
        async def call_tool(self, name, args, **kw):
            assert args == {"id": "library.xmpPreferences", "params": {"autoWrite": False}}
            calls.append("sidecars_off")
    owned = Owned()
    class Editing:
        _gpu_backend = "dx12"
        def diagnostic_manager(self, backend):
            assert backend == "dx12"
            return owned
    class Session:
        def __init__(self, manager, **kw):
            assert manager is owned and kw == {"stage_cache": "off"}
        async def open_raw(self, key, path):
            assert key == str(ASSET) and path == str(source)
            calls.append("open")
            return "isolated", SimpleNamespace(revision=1)
        async def restore_persisted_settings(self, handle, value, revision):
            assert handle == "isolated" and value == recipe and revision == 1
            if failure == "restore": raise ValueError()
            calls.append("restored")
            return SimpleNamespace(revision=2)
        def request_preview(self, handle, revision, max_side, **kw):
            assert handle == "isolated" and revision == 2 and max_side == 1024 and kw == {"quality": "full"}
            async def result():
                if failure == "cancel": raise asyncio.CancelledError()
                if failure == "preview": raise ValueError()
                return frame()
            return result()
        async def close(self): calls.append("closed")
    monkeypatch.setattr(generator, "LightCraftRawSession", Session)
    async def run():
        return await generator.render_raw_thumbnail(ASSET, source, recipe, manager=Editing())
    if failure:
        with pytest.raises(asyncio.CancelledError if failure == "cancel" else ValueError): asyncio.run(run())
    else:
        assert asyncio.run(run()).startswith(b"\xff\xd8")
    assert calls[:3] == ["start", "sidecars_off", "open"] and calls[-1] == "closed"
    assert source.read_bytes() == b"immutable" and list(tmp_path.iterdir()) == [source]


def test_oversized_preview_rejected():
    with pytest.raises(generator.ThumbnailGenerationError, match="raw_preview_invalid"):
        generator._encode(frame((1025, 16)))


def test_dispatch_never_uses_jpeg_recipe_or_renderer(monkeypatch):
    import thumbnail_generator as jpeg
    async def raw_thumbnail(asset, **kwargs):
        assert asset == ASSET
        return b"raw-result"
    monkeypatch.setattr(generator, "generate_raw_thumbnail", raw_thumbnail)
    monkeypatch.setattr(jpeg, "_load_recipe", lambda *a: pytest.fail("JPEG recipe used"))
    assert asyncio.run(jpeg.generate_thumbnail(ASSET, immich_url=None, api_key=None, input_kind="raw")) == b"raw-result"
    with pytest.raises(jpeg.ThumbnailGenerationError, match="unsupported_input_kind"):
        asyncio.run(jpeg.generate_thumbnail(ASSET, immich_url=None, api_key=None, input_kind="other"))


def test_raw_failure_keeps_previous_cache(db, tmp_path):
    save()
    cache = ThumbnailCache(tmp_path / "cache")
    previous = generator._encode(frame((32, 16)))
    cache.store(ASSET, previous)
    async def fail(asset):
        raise generator.ThumbnailGenerationError("raw_thumbnail_failed")
    async def run():
        scheduler = ThumbnailScheduler(cache, fail)
        await scheduler.start()
        scheduler.schedule(ASSET, immediate=True)
        await asyncio.sleep(.05)
        await scheduler.close()
    asyncio.run(run())
    assert cache.read(ASSET) == previous
