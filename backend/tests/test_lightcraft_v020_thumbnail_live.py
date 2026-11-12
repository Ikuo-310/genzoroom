"""Opt-in Native Thumbnail integration using a receipt-verified LightCraft executable."""
import asyncio
from copy import deepcopy
from io import BytesIO
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image

import edit_store
import raw_recipe_store as recipe_store
import raw_thumbnail_generator as thumbnail
from lightcraft_raw import LightCraftRawSession
from lightcraft_runtime import LightCraftManager
from tests.test_raw_source import Original
from tests.test_raw_recipe_store import settings


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", tmp_path / "isolated.sqlite3")
    edit_store.initialize_database()


@pytest.mark.skipif(not os.environ.get("GENZOROOM_TEST_LIGHTCRAFT_EXE"), reason="real Native executable not requested")
@pytest.mark.parametrize("material", ["jpeg", "pixel", "pentax"])
def test_real_native_saved_recipe_thumbnail(tmp_path, monkeypatch, isolated_db, material):
    if material == "jpeg":
        original = Path(__file__).resolve().parents[2] / "docs/images/Anshitsu_Sakura.jpg"
    else:
        original = Path(os.environ.get(f"GENZOROOM_TEST_RESET_{material.upper()}", ""))
    if not original.is_file():
        pytest.skip(f"{material} test source not supplied")

    source = tmp_path / ("source" + original.suffix)
    shutil.copyfile(original, source)
    asset_id = uuid4()
    environment = {**os.environ, "GENZOROOM_LIGHTCRAFT_EXE": os.environ["GENZOROOM_TEST_LIGHTCRAFT_EXE"]}
    manager = LightCraftManager(environment=environment, platform="win32", gpu_backend="off")
    editor = LightCraftRawSession(manager)
    captured = {}
    original_session = thumbnail.LightCraftRawSession

    class CapturingSession:
        def __init__(self, *args, **kwargs):
            self.session = original_session(*args, **kwargs)

        def __getattr__(self, name):
            return getattr(self.session, name)

        async def restore_persisted_settings(self, handle, recipe, revision):
            restored = await self.session.restore_persisted_settings(handle, recipe, revision)
            captured["settings"] = deepcopy(restored.settings)
            return restored

    monkeypatch.setattr(thumbnail, "LightCraftRawSession", CapturingSession)

    class Source(Original):
        def __init__(self, path):
            self.path = path
            self.closed = False

        async def chunks(self):
            yield self.path.read_bytes()

        async def close(self):
            self.closed = True

    source_stream = Source(source)
    monkeypatch.setattr(thumbnail, "get_asset_detail", lambda *a, **k: asyncio.sleep(0, result=
        SimpleNamespace(is_raw=material != "jpeg", filename=source.name)))
    monkeypatch.setattr(thumbnail, "get_asset_original", lambda *a, **k: asyncio.sleep(0, result=source_stream))

    async def run():
        await manager.start()
        async with asyncio.timeout(30):
            while manager.status().state in ("starting", "initializing"):
                await asyncio.sleep(.05)
        assert manager.status().state == "ready"
        handle, initial = await editor.open_raw(str(asset_id), str(source))
        identity = editor.recipe_identity(handle)
        saved = deepcopy(initial.settings)
        revision = initial.revision
        if material != "jpeg":
            reset = await editor.apply_history_operation(handle, "sectionReset", {"section": "detail"}, revision)
            saved = deepcopy(reset.settings)
            revision = reset.revision
            assert saved["detail"].get("nr_outliers", False) is False
            saved["detail"].pop("nr_outliers", None)
        changed = await editor.set_controls(handle, {"light.exposure": .5}, revision)
        saved["light"]["exposure"] = .5
        recipe_store.put_raw_recipe(identity, 0, uuid4(), saved,
            import_defaults_fingerprint=recipe_store._digest(recipe_store._settings_json(initial.settings, 1)))
        stored = recipe_store.get_raw_recipe(identity)
        database_before = edit_store.DB_PATH.read_bytes()
        image_bytes = await thumbnail.generate_raw_thumbnail(asset_id, immich_url=None, api_key=None,
            manager=manager)
        assert recipe_store.get_raw_recipe(identity) == stored
        assert edit_store.DB_PATH.read_bytes() == database_before
        assert source.read_bytes() == original.read_bytes()
        assert source_stream.closed
        assert recipe_store._settings_json(captured["settings"], 1) == recipe_store._settings_json(
            stored["recipe"]["settings"], 1)
        assert captured["settings"]["light"]["exposure"] == .5
        if material != "jpeg":
            assert captured["settings"]["detail"].get("nr_outliers", False) is False
        with Image.open(BytesIO(image_bytes)) as image:
            image.load()
            assert image.format == "JPEG" and 0 < max(image.size) <= 1024
        await editor.close()
        await manager.close()

    asyncio.run(run())
