import asyncio
import copy
import json

import pytest

from lightcraft_mcp import LightCraftError
from lightcraft_raw import _validate_png, SUPERSEDED
from tests.test_lightcraft_raw import create, image_result


def test_before_unsupported_preserves_after(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw("a", files[0])
            assert raw.before_key(handle) is None
            with pytest.raises(LightCraftError, match="raw_before_unsupported"):
                raw.request_preview(handle, initial.revision, kind="before")
            assert (await raw.request_preview(handle, initial.revision)).kind == "after"
            assert children[0].render_count == 1
            assert ("beforeAfter.setBefore", {"source": "import"}) in children[0].commands
        finally:
            await raw.close()
            await manager.close()
    asyncio.run(run())


def test_before_native_cache_key_and_read_only_state(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        child = children[0]
        child.before_supported = True
        try:
            handle, initial = await raw.open_raw("a", files[0])
            key = raw.before_key(handle)
            assert key and len(key) == 64
            snapshot = copy.deepcopy(initial.settings)
            before = await raw.request_preview(handle, initial.revision, kind="before")
            assert before.key == key and before.kind == "before"
            assert child.render_count == 1 and raw.status().edits == 0
            assert raw.confirmed_settings(handle, initial.revision).settings == snapshot
            changed = await raw.set_controls(handle, {"light.exposure": 1.5, "wb.temp": 5000}, initial.revision)
            assert raw.before_key(handle) == key
            cached = await raw.request_preview(handle, changed.revision, kind="before")
            assert cached.data == before.data and cached.revision == changed.revision
            assert child.render_count == 1
            for name, value in (("crop", {"x": .1}), ("orientation", 6)):
                child.photos[1]["settings"][name] = value
                changed = await raw.get_settings(handle)
                assert raw.before_key(handle) != key
                key = raw.before_key(handle)
                frame = await raw.request_preview(handle, changed.revision, kind="before")
                assert frame.key == key
            assert child.render_count == 3
            assert raw.before_key(handle, 512) != key
            await raw.request_preview(handle, changed.revision, 512, kind="before")
            assert child.render_count == 4
            # Selection invalidates both the in-memory PNG and document-specific opaque key.
            other, _ = await raw.open_raw("b", files[1])
            assert raw.before_key(other) != key
        finally:
            await raw.close()
            await manager.close()
    asyncio.run(run())


def test_before_wrong_kind_does_not_stop_after(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        children[0].before_supported = True
        try:
            handle, initial = await raw.open_raw("a", files[0])
            children[0].before_wrong_kind = True
            with pytest.raises(LightCraftError, match="lightcraft_invalid_preview"):
                await raw.request_preview(handle, initial.revision, kind="before")
            assert manager.status().state == "ready"
            assert (await raw.request_preview(handle, initial.revision)).kind == "after"
        finally:
            await raw.close()
            await manager.close()
    asyncio.run(run())


def test_before_coalesces_and_queued_after_has_priority(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        children[0].before_supported = True
        try:
            handle, initial = await raw.open_raw("a", files[0])
            await raw._lock.acquire()
            first = raw.request_preview(handle, initial.revision, kind="before")
            await asyncio.sleep(0)
            second = raw.request_preview(handle, initial.revision, kind="before")
            after = raw.request_preview(handle, initial.revision)
            assert first is second
            raw._lock.release()
            assert (await after).kind == "after"
            assert not first._future.done()
            assert (await first).kind == "before"
            assert children[0].render_count == 2
            assert children[0].max_inflight == 1
        finally:
            await raw.close()
            await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize("field,value", [("kind", "after"), ("beforeFingerprint", "c" * 16),
    ("effectiveBeforeFingerprint", "invalid"), ("geometry", {"crop": 1, "orientation": None}), ("width", 17)])
def test_before_metadata_is_fail_closed(field, value):
    result = image_result()
    metadata = {"id": 1, "width": 16, "height": 12, "kind": "before", "beforeFingerprint": "b" * 16,
                "effectiveBeforeFingerprint": "e" * 16, "geometry": {"crop": None, "orientation": None}}
    metadata[field] = value
    result["content"][1]["text"] = json.dumps(metadata)
    with pytest.raises(LightCraftError, match="lightcraft_invalid_preview"):
        _validate_png(result, 1, 1024, "before", "b" * 16, {"crop": None, "orientation": None})
