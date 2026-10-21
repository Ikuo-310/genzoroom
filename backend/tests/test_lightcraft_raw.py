import asyncio
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import threading

from PIL import Image
import pytest

import lightcraft_raw as module
from lightcraft_raw import (DevelopSnapshot, LightCraftRawSession, PreviewFrame, RawTimeouts,
                            SUPERSEDED, _settings_json, _validate_png)
from lightcraft_mcp import LightCraftError, MCPTransportError
from lightcraft_runtime import LightCraftManager
from tests.test_lightcraft_mcp import reply, until
from tests.test_lightcraft_runtime import FakeProcess, FAST, assert_reaped


DEFAULT = {"version": 1, "process": 2, "wb": {"mode": "custom", "temp": 6500., "tint": 0., "scale": "kelvin"},
           "light": {"exposure": 0., "contrast": 0.}, "geometry": {"scale": 100.},
           "curve": {"master": [{"x": 0., "y": 0.}, {"x": 1., "y": 1.}]}}
QUICK = RawTimeouts(admission=.5, command=1, import_raw=2, preview=1, validation=1, ready=1)


def png(w=16, h=12):
    buffer = io.BytesIO()
    Image.new("RGBA", (w, h), (30, 50, 80, 255)).save(buffer, "PNG")
    return buffer.getvalue()


def image_result(photo=1, data=None, w=16, h=12):
    return {"isError": False, "content": [
        {"type": "image", "data": base64.b64encode(data or png(w, h)).decode(), "mimeType": "image/png"},
        {"type": "text", "text": json.dumps({"id": photo, "width": w, "height": h})}]}


def merge(base, patch):
    for k, v in patch.items():
        if k not in base:
            continue
        if isinstance(base[k], dict) and isinstance(v, dict):
            merge(base[k], v)
        else:
            base[k] = copy.deepcopy(v)


class RawProcess(FakeProcess):
    def __init__(self):
        super().__init__()
        self.pid = 12345
        self.photos = {}
        self.active = None
        self.commands = []
        self.gate = None
        self.render_started = asyncio.Event()
        self.render_count = self.inflight = self.max_inflight = 0
        self.deferred = set()
        self.kind = "raw"
        self.preview_only = None
        self.import_failure = self.partial_failure = False
        self.fail_get = self.mismatch = False
        self.bad_image = False
        self.raw_tool_error = False

    def tool(self, message, value=None, error=False):
        result = {"isError": error, "content": [{"type": "text", "text": "PRIVATE C:/photo.raw API_KEY secret"}]}
        if not error:
            result["structuredContent"] = value
        reply(self.stdout, message, result)

    def respond(self, message):
        if message["method"] != "tools/call":
            return super().respond(message)
        args = message["params"]["arguments"]
        if message["params"]["name"] == "render_preview":
            self.render_count += 1
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            self.render_started.set()

            async def render():
                try:
                    if self.gate is not None:
                        await self.gate.wait()
                    if self.raw_tool_error:
                        self.tool(message, error=True)
                    else:
                        result = image_result(args["id"])
                        if self.bad_image:
                            result["content"][0]["data"] = "broken"
                        reply(self.stdout, message, result)
                finally:
                    self.inflight -= 1

            task = asyncio.create_task(render())
            self.deferred.add(task)
            task.add_done_callback(self.deferred.discard)
            return
        command, params = args["id"], args["params"]
        self.commands.append((command, copy.deepcopy(params)))
        if command == "app.memoryBudget":
            value = {"budget": params["mb"] * 1024 * 1024}
        elif command == "library.import":
            path = params["paths"][0]
            digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
            old = next((k for k, v in self.photos.items() if v["hash"] == digest), None)
            value = {"imported": [], "duplicates": [], "failed": []}
            if self.import_failure:
                value["failed"] = [[path, "PRIVATE secret"]]
            elif old is not None:
                value["duplicates"] = [{"existing": old, "reason": "content", "path": path}]
            else:
                photo_id = len(self.photos) + 1
                self.photos[photo_id] = {"hash": digest, "settings": copy.deepcopy(DEFAULT)}
                value["imported"] = [photo_id]
            if self.partial_failure:
                value["failed"] = [[path, "PRIVATE secret"]]
        elif command == "photo.inspect":
            value = {"id": params["id"], "kind": self.kind, "width": 4000, "height": 3000,
                     "content_hash": self.photos[params["id"]]["hash"]}
            if self.preview_only:
                value["preview_only"] = self.preview_only
        elif command == "library.select":
            self.active = params["active"]
            value = {"selected": 1}
        elif command == "develop.get":
            if self.fail_get:
                return self.tool(message, error=True)
            value = self.photos[params["id"]]["settings"]
        elif command == "develop.reset":
            self.photos[self.active]["settings"] = copy.deepcopy(DEFAULT)
            value = {"ok": True}
        elif command in ("develop.set", "develop.merge"):
            settings = self.photos[self.active]["settings"]
            if command == "develop.set":
                for k, v in params["values"].items():
                    section, key = k.split(".")
                    if section not in settings or key not in settings[section]:
                        return self.tool(message, error=True)
                    settings[section][key] = v
            else:
                merge(settings, params["settings"])
            # Independent fake clamp oracle: sent extremes must not become the adapter's truth.
            settings["light"]["exposure"] = max(-5., min(5., settings["light"]["exposure"]))
            settings["geometry"]["scale"] = max(50., min(200., settings["geometry"]["scale"]))
            for point in settings["curve"]["master"]:
                point["x"] = max(0., min(1., point["x"]))
                point["y"] = max(0., min(1., point["y"]))
            if self.mismatch:
                settings["light"]["exposure"] = 4.
            value = {"ok": True}
        else:
            raise AssertionError(command)
        self.tool(message, value)

    def exit(self, code):
        for task in self.deferred:
            task.cancel()
        super().exit(code)


async def create(tmp_path, *, timeouts=QUICK):
    exe = tmp_path / "engine.exe"
    exe.write_bytes(b"fake")
    children = []

    async def spawn(*args, **kwargs):
        child = RawProcess()
        children.append(child)
        return child

    manager = LightCraftManager(environment={"GENZOROOM_LIGHTCRAFT_EXE": str(exe)}, platform="win32",
                                spawn=spawn, timeouts=FAST)
    await manager.start()
    await until(lambda: manager.status().state == "ready")
    service = LightCraftRawSession(manager, timeouts=timeouts)
    files = [tmp_path / f"{n}.DNG" for n in range(3)]
    for n, file in enumerate(files):
        file.write_bytes(f"fake-raw-{n}".encode())
    return service, manager, children, files


def test_import_edit_readback_restore_preview_and_capacity(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw("pixel", files[0])
            child = children[0]
            assert child.commands[0] == ("app.memoryBudget", {"mb": 1024})
            assert child.commands[1] == ("library.import", {"paths": [str(files[0])], "mode": "add"})
            changed = await raw.set_controls(handle, {"light.exposure": 1000}, initial.revision)
            assert changed.settings["light"]["exposure"] == 5
            leaked = changed.settings
            leaked["light"]["exposure"] = -5
            assert (await raw.get_settings(handle)).settings["light"]["exposure"] == 5
            merged = await raw.merge_settings(handle, {"geometry": {"scale": 0}, "unknown": 42,
                "curve": {"master": [{"x": -1, "y": 20}]}}, changed.revision)
            assert merged.settings["geometry"]["scale"] == 50
            assert merged.settings["curve"]["master"] == [{"x": 0., "y": 1.}]
            assert "unknown" not in merged.settings
            restored = await raw.restore_settings(handle, initial, merged.revision)
            assert restored.settings == initial.settings
            assert [c for c, _ in child.commands][-3:] == ["develop.reset", "develop.merge", "develop.get"]
            frame = await raw.request_preview(handle, restored.revision)
            assert isinstance(frame, PreviewFrame) and frame.data.startswith(b"\x89PNG")
            assert frame.handle == handle and frame.revision == restored.revision
            second, _ = await raw.open_raw("pentax", files[1])
            assert (await raw.select(handle)).handle == handle
            with pytest.raises(LightCraftError, match="raw_session_capacity"):
                await raw.open_raw("third", files[2])
            await raw.select(second)
            assert raw.status().resident_count == 2
        finally:
            session = manager._session
            await raw.close()
        assert_reaped(session)
        assert raw.status().state == "stopped"
    asyncio.run(run())


def test_reopen_rotates_token_and_reuses_photo_without_import(tmp_path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            old, _ = await raw.open_raw("same", files[0])
            new, _ = await raw.open_raw("same", files[0])
            assert new.document_token != old.document_token
            assert sum(c == "library.import" for c, _ in children[0].commands) == 1
            with pytest.raises(LightCraftError, match="raw_stale_handle"):
                await raw.get_settings(old)
            assert (await raw.get_settings(new)).handle == new
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode,code", [("failed", "raw_import_failed"), ("partial", "raw_import_failed"),
                                      ("jpeg", "raw_unsupported_source"), ("preview", "raw_unsupported_source")])
def test_import_failures_and_raw_confirmation(tmp_path, mode, code):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        child = children[0]
        child.import_failure = mode == "failed"
        child.partial_failure = mode == "partial"
        child.kind = "jpeg" if mode == "jpeg" else "raw"
        child.preview_only = "unsupported" if mode == "preview" else None
        try:
            with pytest.raises(LightCraftError, match=code):
                await raw.open_raw("raw", files[0])
            assert manager.status().state == "ready"
            if mode != "failed":
                assert raw.status().state == "desynchronized"
        finally:
            await raw.close()
    asyncio.run(run())


def test_duplicate_and_fingerprint_changes_require_explicit_reset(tmp_path):
    async def run():
        raw, _, _, files = await create(tmp_path)
        try:
            await raw.open_raw("first", files[0])
            files[1].write_bytes(files[0].read_bytes())
            with pytest.raises(LightCraftError, match="raw_duplicate_source"):
                await raw.open_raw("alias", files[1])
            assert raw.status().resident_count == 1
            files[0].write_bytes(b"changed content")
            with pytest.raises(LightCraftError, match="raw_source_changed"):
                await raw.open_raw("first", files[0])
        finally:
            await raw.close()
    asyncio.run(run())


def test_wb_process_restore_and_partial_failure(tmp_path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, initial = await raw.open_raw("raw", files[0])
            with pytest.raises(LightCraftError, match="raw_wb_scale_required"):
                await raw.merge_settings(handle, {"wb": {"temp": 5500}}, initial.revision)
            state = await raw.merge_settings(handle, {"process": 1, "wb": {"temp": 5500, "scale": "legacy"}}, initial.revision)
            assert state.settings["process"] == 1 and state.settings["wb"]["scale"] == "legacy"
            newer = await raw.set_controls(handle, {"light.exposure": .5}, state.revision)
            restored = await raw.restore_settings(handle, state, newer.revision)
            assert restored.settings == state.settings
            child = children[0]
            child.fail_get = True
            with pytest.raises(LightCraftError, match="lightcraft_tool_error"):
                await raw.set_controls(handle, {"light.exposure": 1}, restored.revision)
            assert raw.status().state == "desynchronized"
            with pytest.raises(LightCraftError, match="raw_desynchronized"):
                raw.request_preview(handle, restored.revision)
            child.fail_get = False
            recovered = await raw.get_settings(handle)
            assert recovered.settings["light"]["exposure"] == 1
            child.mismatch = True
            with pytest.raises(LightCraftError, match="raw_restore_mismatch"):
                await raw.restore_settings(handle, initial, recovered.revision)
            assert raw.status().state == "desynchronized"
        finally:
            await raw.close()
    asyncio.run(run())


def test_preview_coalesces_latest_and_never_returns_running_stale_bytes(tmp_path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, settings = await raw.open_raw("raw", files[0])
            child = children[0]
            child.gate = asyncio.Event()
            a = raw.request_preview(handle, settings.revision)
            await child.render_started.wait()
            b = raw.request_preview(handle, settings.revision)
            c = raw.request_preview(handle, settings.revision)
            assert await b is SUPERSEDED
            assert raw.status().preview_running and raw.status().preview_pending
            child.gate.set()
            assert await a is SUPERSEDED
            latest = await c
            assert isinstance(latest, PreviewFrame) and latest.sequence == c.sequence
            assert child.render_count == 2 and child.max_inflight == 1
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("change", ["edit", "switch", "reopen"])
def test_inflight_preview_is_discarded_on_edit_or_A_B_A_or_reopen(tmp_path, change):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            a, _ = await raw.open_raw("a", files[0])
            b, _ = await raw.open_raw("b", files[1])
            state = await raw.select(a)
            child = children[0]
            child.gate = asyncio.Event()
            old = raw.request_preview(a, state.revision)
            await child.render_started.wait()
            if change == "edit":
                operation = asyncio.create_task(raw.set_controls(a, {"light.exposure": .5}, state.revision))
            elif change == "switch":
                operation = asyncio.create_task(raw.select(b))
            else:
                operation = asyncio.create_task(raw.open_raw("a", files[0]))
            await asyncio.sleep(.01)
            child.gate.set()
            assert await old is SUPERSEDED
            new_state = await operation
            if change == "switch":
                await raw.select(a)
            elif change == "reopen":
                with pytest.raises(LightCraftError, match="raw_stale_handle"):
                    await raw.get_settings(a)
            else:
                assert new_state.settings["light"]["exposure"] == .5
        finally:
            await raw.close()
    asyncio.run(run())


def test_cancelled_ticket_does_not_cancel_mcp_and_errors_are_redacted(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            handle, settings = await raw.open_raw("raw", files[0])
            child = children[0]
            child.gate = asyncio.Event()
            ticket = raw.request_preview(handle, settings.revision)
            waiter = asyncio.create_task(ticket.wait())
            await child.render_started.wait()
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            assert manager.status().state == "ready"
            child.gate.set()
            await until(lambda: raw._worker.done())
            assert manager.status().state == "ready" and ticket._future.result() is SUPERSEDED
            child.raw_tool_error = True
            with pytest.raises(LightCraftError, match="^lightcraft_tool_error$"):
                await raw.request_preview(handle, settings.revision)
            assert manager.status().state == "ready"
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["kill", "timeout", "image"])
def test_runtime_failures_mark_lost_and_release_all_tickets(tmp_path, mode):
    async def run():
        raw, _, children, files = await create(tmp_path,
            timeouts=RawTimeouts(admission=.5, command=.5, import_raw=1, preview=.05, validation=.5, ready=1))
        try:
            handle, settings = await raw.open_raw("raw", files[0])
            child = children[0]
            child.gate = asyncio.Event() if mode != "image" else None
            child.bad_image = mode == "image"
            ticket = raw.request_preview(handle, settings.revision)
            await child.render_started.wait()
            if mode == "kill":
                child.exit(17)
            with pytest.raises(LightCraftError):
                await ticket
            assert raw.status().state == "lost"
            with pytest.raises(LightCraftError, match="raw_session_lost"):
                raw.request_preview(handle, settings.revision)
            assert len(children) == 1
        finally:
            await raw.close()
    asyncio.run(run())


def test_reset_restores_active_and_invalidates_old_generation_handles(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            a, initial = await raw.open_raw("a", files[0])
            expected = await raw.set_controls(a, {"light.exposure": .5}, initial.revision)
            b, _ = await raw.open_raw("b", files[1])
            await raw.select(a)
            old_session = manager._session
            new = await raw.reset_session()
            assert new.generation == 2 and new.document_token != a.document_token
            assert (await raw.get_settings(new)).settings == expected.settings
            assert_reaped(old_session)
            assert children[1].photos[1]["settings"]["light"]["exposure"] == .5
            with pytest.raises(LightCraftError, match="raw_stale_handle"):
                await raw.get_settings(a)
            with pytest.raises(LightCraftError, match="raw_stale_handle"):
                await raw.get_settings(b)
            reopened, _ = await raw.open_raw("b", files[1])
            assert reopened.generation == 2 and raw.status().resident_count == 2
            assert raw.status().edits == 0
        finally:
            await raw.close()
    asyncio.run(run())


def test_external_restart_never_migrates_old_operations_and_edit_limit(tmp_path, monkeypatch):
    async def run():
        raw, manager, _, files = await create(tmp_path)
        try:
            handle, snapshot = await raw.open_raw("raw", files[0])
            monkeypatch.setattr(module, "MAX_EDITS", 1)
            changed = await raw.set_controls(handle, {"light.exposure": .5}, snapshot.revision)
            with pytest.raises(LightCraftError, match="raw_session_edit_limit"):
                await raw.set_controls(handle, {"light.exposure": 1}, changed.revision)
            await manager.restart()
            await until(lambda: manager.status().state == "ready")
            assert raw.status().state == "lost"
            with pytest.raises(LightCraftError, match="raw_session_lost"):
                await raw.get_settings(handle)
        finally:
            await raw.close()
    asyncio.run(run())


def test_image_validation_cancel_is_owned_and_next_preview_waits(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = module._validate_png

    def validate(*args):
        entered.set()
        release.wait(3)
        return original(*args)

    monkeypatch.setattr(module, "_validate_png", validate)

    async def run():
        raw, manager, children, files = await create(tmp_path)
        handle, snapshot = await raw.open_raw("raw", files[0])
        ticket = raw.request_preview(handle, snapshot.revision)
        try:
            await until(entered.is_set)
            raw.request_preview(handle, snapshot.revision)
            assert children[0].render_count == 1
            closing = asyncio.create_task(raw.close())
            await asyncio.sleep(.02)
            assert not closing.done()
            closing.cancel()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await closing
            assert manager.status().state == "stopped"
            assert raw._validation is None and raw._worker.done()
            with pytest.raises(LightCraftError):
                await ticket
            await raw.close()
        finally:
            release.set()
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("invalid", ["base64", "mime", "metadata", "missing", "multiple", "id", "dimensions",
                                   "truncated", "crc", "trailing", "huge", "structured"])
def test_png_response_validation(invalid):
    result = image_result()
    image, text = result["content"]
    if invalid == "base64": image["data"] = "!@#="
    elif invalid == "mime": image["mimeType"] = "image/jpeg"
    elif invalid == "metadata": text["text"] = "x" * (module.MAX_METADATA_BYTES + 1)
    elif invalid == "missing": result["content"] = [text]
    elif invalid == "multiple": result["content"].append(image.copy())
    elif invalid == "id": text["text"] = json.dumps({"id": True, "width": 16, "height": 12})
    elif invalid == "dimensions": text["text"] = json.dumps({"id": 1, "width": 15, "height": 12})
    elif invalid == "truncated": image["data"] = base64.b64encode(png()[:-12]).decode()
    elif invalid == "crc": image["data"] = base64.b64encode(png()[:-1] + b"x").decode()
    elif invalid == "trailing": image["data"] = base64.b64encode(png() + b"junk").decode()
    elif invalid == "huge": image["data"] = "a" * (module.MAX_BASE64_CHARS + 1)
    elif invalid == "structured": result["structuredContent"] = {}
    with pytest.raises(LightCraftError, match="^lightcraft_invalid_preview$"):
        _validate_png(result, 1, 1024)


def test_png_pixel_bounds_before_load_and_encoded_limit(monkeypatch):
    result = image_result()
    huge_header = image_result(data=png(1025, 1))
    def forbidden(*args, **kwargs):
        pytest.fail("oversized header reached pixel allocation")
    monkeypatch.setattr(Image.Image, "load", forbidden)
    with pytest.raises(LightCraftError):
        _validate_png(huge_header, 1, 1024)
    result["content"][1]["text"] = json.dumps({"id": 1, "width": 1_000_000, "height": 1_000_000})
    with pytest.raises(LightCraftError):
        _validate_png(result, 1, 1024)
    monkeypatch.setattr(module, "MAX_IMAGE_BYTES", 20)
    with pytest.raises(LightCraftError):
        _validate_png(huge_header, 1, 1024)


@pytest.mark.parametrize("value", [{"process": float("nan")}, {"x": "s" * (module.MAX_PATCH_BYTES + 1)},
                                 {"x": {"nested": [float("inf")]}}])
def test_settings_reject_nonfinite_and_oversized_input(value):
    with pytest.raises(LightCraftError, match="raw_invalid_settings"):
        module._object_json(value, module.MAX_PATCH_BYTES)


def test_legacy_scale_and_process_are_compared_semantically():
    value = copy.deepcopy(DEFAULT)
    value["process"] = 1
    del value["wb"]["scale"]
    normalized = json.loads(_settings_json(value))
    assert normalized["process"] == 1 and normalized["wb"]["scale"] == "legacy"


def test_real_poc_limits_256_updates_and_two_retained_snapshots(tmp_path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, state = await raw.open_raw("a", files[0])
            for n in range(256):
                state = await raw.set_controls(handle, {"light.exposure": (n % 5) / 4}, state.revision)
            assert raw.status().edits == 256
            sent = len(children[0].commands)
            with pytest.raises(LightCraftError, match="raw_session_edit_limit"):
                await raw.set_controls(handle, {"light.exposure": 2}, state.revision)
            assert len(children[0].commands) == sent
            await raw.open_raw("b", files[1])
            await raw.reset_session(restore_active=False)
            third, _ = await raw.open_raw("c", files[2])
            assert third.generation == 2 and raw.status().resident_count == 1 and raw.status().edits == 0
        finally:
            await raw.close()
    asyncio.run(run())


def test_conflicting_mutations_are_not_coalesced_or_applied_to_wrong_photo(tmp_path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, state = await raw.open_raw("a", files[0])
            child = children[0]
            child.gate = asyncio.Event()
            old = raw.request_preview(handle, state.revision)
            await child.render_started.wait()
            a = asyncio.create_task(raw.set_controls(handle, {"light.exposure": .5}, state.revision))
            b = asyncio.create_task(raw.merge_settings(handle, {"light": {"contrast": 20}}, state.revision))
            await asyncio.sleep(.01)
            with pytest.raises(LightCraftError, match="raw_busy"):
                await raw.get_settings(handle)
            child.gate.set()
            assert await old is SUPERSEDED
            changed = await a
            with pytest.raises(LightCraftError, match="raw_revision_conflict"):
                await b
            assert changed.settings["light"] == {"exposure": .5, "contrast": 0.}
            assert (await raw.request_preview(handle, changed.revision)).revision == changed.revision
        finally:
            await raw.close()
    asyncio.run(run())


def test_cancel_transmitted_mutation_loses_session_without_retry(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            handle, state = await raw.open_raw("a", files[0])
            child = children[0]
            original = child.respond
            written = asyncio.Event()
            def respond(message):
                if message.get("params", {}).get("arguments", {}).get("id") == "develop.set":
                    written.set()
                    return
                original(message)
            child.stdin.respond = respond
            operation = asyncio.create_task(raw.set_controls(handle, {"light.exposure": 1}, state.revision))
            await written.wait()
            operation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await operation
            assert raw.status().state == "lost"
            await until(lambda: manager._session.reaped)
            assert len(children) == 1
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["close", "timeout", "failure"])
def test_file_inspection_is_bounded_and_close_does_not_wait_for_os_io(tmp_path, monkeypatch, mode):
    entered, release = threading.Event(), threading.Event()
    original = module._source_info
    def inspect(path):
        entered.set()
        if mode == "failure":
            raise OSError("PRIVATE C:/secret.raw")
        release.wait(3)
        return original(path)
    monkeypatch.setattr(module, "_source_info", inspect)

    async def run():
        raw, _, children, files = await create(tmp_path,
            timeouts=RawTimeouts(admission=.04, command=1, import_raw=1, preview=1, validation=1, ready=1))
        operation = asyncio.create_task(raw.open_raw("a", files[0]))
        try:
            await until(entered.is_set)
            if mode == "close":
                await asyncio.wait_for(raw.close(), .5)
                assert not release.is_set()
                with pytest.raises((LightCraftError, asyncio.CancelledError)):
                    await operation
            else:
                with pytest.raises(LightCraftError, match="raw_inspection_timeout" if mode == "timeout" else "raw_worker_failed"):
                    await operation
                assert not any(c == "library.import" for c, _ in children[0].commands)
                if mode == "timeout":
                    with pytest.raises(LightCraftError, match="raw_inspection_busy"):
                        await raw.open_raw("a", files[0])
        finally:
            release.set()
            await raw.close()
    asyncio.run(run())


def test_reset_rejects_changed_raw_and_closes_new_child(tmp_path):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            await raw.open_raw("a", files[0])
            files[0].write_bytes(b"different")
            with pytest.raises(LightCraftError, match="raw_source_changed"):
                await raw.reset_session()
            assert raw.status().state == "lost"
            assert manager.status().state == "stopped" and all(c.returncode is not None for c in children)
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["close", "cancel"])
def test_reset_ready_wait_can_be_closed_or_cancelled_without_orphans(tmp_path, mode):
    async def run():
        raw, manager, children, files = await create(tmp_path)
        await raw.open_raw("a", files[0])
        original_spawn = manager._spawn
        async def spawn(*args, **kwargs):
            child = await original_spawn(*args, **kwargs)
            child.stall = "initialize"
            return child
        manager._spawn = spawn
        resetting = asyncio.create_task(raw.reset_session())
        try:
            await until(lambda: len(children) == 2)
            if mode == "close":
                await raw.close()
                with pytest.raises(LightCraftError, match="raw_closed"):
                    await resetting
            else:
                resetting.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await resetting
                assert not raw._resetting
            assert manager.status().state == "stopped"
            assert all(c.returncode is not None for c in children)
        finally:
            await raw.close()
    asyncio.run(run())


def test_validation_deadline_aborts_connection_and_releases_retained_worker(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = module._validate_png
    def validate(*args):
        entered.set()
        release.wait(3)
        return original(*args)
    monkeypatch.setattr(module, "_validate_png", validate)
    async def run():
        raw, manager, _, files = await create(tmp_path,
            timeouts=RawTimeouts(admission=.5, command=1, import_raw=1, preview=1, validation=.02, ready=1))
        try:
            handle, settings = await raw.open_raw("a", files[0])
            ticket = raw.request_preview(handle, settings.revision)
            await until(entered.is_set)
            await asyncio.sleep(.04)
            assert raw._validation is not None
            release.set()
            with pytest.raises(LightCraftError, match="lightcraft_preview_validation_timeout"):
                await ticket
            assert raw.status().state == "lost" and manager.status().state == "failed"
            assert raw._validation is None
        finally:
            release.set()
            await raw.close()
    asyncio.run(run())


def test_png_rejects_multiple_frames():
    output = io.BytesIO()
    first = Image.new("RGBA", (16, 12), "red")
    second = Image.new("RGBA", (16, 12), "blue")
    first.save(output, "PNG", save_all=True, append_images=[second])
    with pytest.raises(LightCraftError, match="lightcraft_invalid_preview"):
        _validate_png(image_result(data=output.getvalue()), 1, 1024)


def test_raw_diagnostics_never_record_paths_images_settings_or_upstream_text(tmp_path, monkeypatch):
    from backend_logging import backend_logger
    records = []
    monkeypatch.setattr(backend_logger, "add", lambda **kwargs: records.append(kwargs))
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, state = await raw.open_raw("safe-key", files[0])
            await raw.request_preview(handle, state.revision)
            children[0].raw_tool_error = True
            with pytest.raises(LightCraftError):
                await raw.request_preview(handle, state.revision)
        finally:
            await raw.close()
        encoded = json.dumps(records)
        assert str(files[0]) not in encoded
        assert all(term not in encoded for term in ("PRIVATE", "API_KEY", "secret", "base64", "light.exposure", "iVBOR"))
        assert any(r["event"] == "preview.completed" for r in records)
    asyncio.run(run())


def test_snapshot_cannot_follow_a_source_key_reused_for_different_bytes(tmp_path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            _, old = await raw.open_raw("a", files[0])
            await raw.reset_session(restore_active=False)
            files[0].write_bytes(b"new original")
            handle, current = await raw.open_raw("a", files[0])
            count = len(children[-1].commands)
            with pytest.raises(LightCraftError, match="raw_source_changed"):
                await raw.restore_settings(handle, old, current.revision)
            assert len(children[-1].commands) == count
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("path", ["relative.DNG", r"\\server\share\photo.DNG", r"\\.\NUL", "missing"])
def test_invalid_source_paths_do_not_reach_import(tmp_path, path):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            value = tmp_path / "missing.DNG" if path == "missing" else path
            with pytest.raises(LightCraftError):
                await raw.open_raw("a", value)
            assert not any(c == "library.import" for c, _ in children[0].commands)
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.parametrize("partial", [{"process": None}, {"process": True}, {"process": -1}, {"version": 2}])
def test_invalid_process_or_schema_never_silently_converts_to_v1(tmp_path, partial):
    async def run():
        raw, _, children, files = await create(tmp_path)
        try:
            handle, state = await raw.open_raw("a", files[0])
            before = len(children[0].commands)
            with pytest.raises(LightCraftError, match="raw_invalid_settings"):
                await raw.merge_settings(handle, partial, state.revision)
            assert len(children[0].commands) == before
        finally:
            await raw.close()
    asyncio.run(run())
