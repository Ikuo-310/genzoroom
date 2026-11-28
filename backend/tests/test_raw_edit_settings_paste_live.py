"""Opt-in Native checks for the partial develop.merge and subsequent WB controls."""

import asyncio
import os
from pathlib import Path
import shutil
from uuid import uuid4

import pytest
from PIL import Image

from lightcraft_raw import LightCraftRawSession
from lightcraft_runtime import LightCraftManager
from raw_edit_settings_copy import extract_copy_settings, validate_copy_payload


@pytest.mark.skipif(not os.environ.get("GENZOROOM_TEST_LIGHTCRAFT_EXE"), reason="real Native executable not requested")
@pytest.mark.parametrize(("source_kind", "target_kind", "raw_environment"), [
    ("jpeg", "jpeg", None),
    ("pentax", "jpeg", "GENZOROOM_TEST_RESET_PENTAX"),
    ("jpeg", "pentax", "GENZOROOM_TEST_RESET_PENTAX"),
    ("pixel", "jpeg", "GENZOROOM_TEST_RESET_PIXEL"),
    ("jpeg", "pixel", "GENZOROOM_TEST_RESET_PIXEL"),
])
def test_real_native_paste_wb_merge_and_existing_control(tmp_path, source_kind, target_kind, raw_environment):
    raw_path = Path(os.environ.get(raw_environment, "")) if raw_environment else None
    if raw_environment and not raw_path.is_file():
        pytest.skip("representative RAW/DNG material not supplied")

    async def run():
        jpeg_path = Path(__file__).resolve().parents[2] / "docs/images/Anshitsu_Sakura.jpg"
        source_template = jpeg_path if source_kind == "jpeg" else raw_path
        target_template = jpeg_path if target_kind == "jpeg" else raw_path
        source_path = tmp_path / f"source{source_template.suffix}"
        target_path = tmp_path / f"target{target_template.suffix}"
        shutil.copyfile(source_template, source_path)
        if source_kind == target_kind == "jpeg":
            with Image.open(target_template) as image:
                image.save(target_path, format="JPEG", quality=91, progressive=True)
        else:
            shutil.copyfile(target_template, target_path)
        manager = LightCraftManager(environment={**os.environ,
            "GENZOROOM_LIGHTCRAFT_EXE": os.environ["GENZOROOM_TEST_LIGHTCRAFT_EXE"]},
            platform="win32", gpu_backend="off")
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(35):
                while manager.status().state in ("starting", "initializing"):
                    await asyncio.sleep(.05)
            assert manager.status().state == "ready"

            source_handle, source = await raw.open_raw(f"paste-source-{uuid4()}", str(source_path))
            wb = dict(source.settings["wb"])
            wb.update(mode="custom", temp=5500.0, tint=3.0)
            if wb.get("scale") not in ("legacy", "kelvin"):
                pytest.skip(f"Native source WB scale is unsupported by the published contract: {wb.get('scale')!r}")
            source = await raw.merge_settings(source_handle, {"wb": wb}, source.revision)
            selected = ["whiteBalance"]
            payload = validate_copy_payload(selected, extract_copy_settings(source.settings, selected))

            target_handle, target = await raw.open_raw(f"paste-target-{uuid4()}", str(target_path))
            pasted = await raw.merge_settings(target_handle, payload, target.revision)
            assert pasted.settings["wb"] == payload["wb"]
            next_temp = 5550.0 if payload["wb"]["temp"] != 5550.0 else 5600.0
            controlled = await raw.set_controls(target_handle, {"wb.temp": next_temp}, pasted.revision)
            assert controlled.settings["wb"]["temp"] == next_temp
        finally:
            await raw.close()
    asyncio.run(run())
