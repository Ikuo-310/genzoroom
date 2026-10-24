"""Internal, Windows-owned RAW editing session; no HTTP or JPEG editing integration."""

import asyncio
import base64
from dataclasses import dataclass, field, replace
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import threading
from time import monotonic
import uuid
import warnings
import zlib

from PIL import Image
from backend_logging import backend_logger

from lightcraft_mcp import LightCraftError, MCPToolError, MCPTransportError, _decode
from lightcraft_runtime import _await_task_resilient, lightcraft_log


ENGINE_COMMIT = "a2a41383c4fd62fa85a46ccd00998639221f2d3c"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_BASE64_CHARS = 4 * ((MAX_IMAGE_BYTES + 2) // 3)
MAX_METADATA_BYTES = 16 * 1024
MAX_PATCH_BYTES = 64 * 1024
MAX_SETTINGS_BYTES = 256 * 1024
MAX_RAW_FILES = 2
MAX_EDITS = 256
MAX_PREVIEW_SIDE = 1024


@dataclass(frozen=True)
class RawTimeouts:
    admission: float = 5
    command: float = 5
    import_raw: float = 60
    preview: float = 60
    validation: float = 10
    ready: float = 35


@dataclass(frozen=True)
class RawHandle:
    source_key: str
    document_token: str
    generation: int


@dataclass(frozen=True)
class DevelopSnapshot:
    handle: RawHandle
    revision: int
    _json: str = field(repr=False)
    engine_version: str = "0.10.0"
    engine_commit: str = ENGINE_COMMIT
    _fingerprint: tuple | None = field(default=None, repr=False)
    _content_hash: str | None = field(default=None, repr=False)
    wb_kelvin: bool = False

    @property
    def settings(self):
        # Snapshots own serialized values: no caller dictionary can mutate the session's truth.
        return json.loads(self._json)


@dataclass(frozen=True)
class PreviewFrame:
    handle: RawHandle
    revision: int
    selection_epoch: int
    sequence: int
    width: int
    height: int
    data: bytes = field(repr=False)
    mime_type: str = "image/png"
    kind: str = "after"
    key: str | None = None
    quality: str = "full"
    _frame_json: str | None = field(default=None, repr=False)
    _metrics_json: str | None = field(default=None, repr=False)

    @property
    def frame(self):
        return json.loads(self._frame_json) if self._frame_json is not None else None

    @property
    def metrics(self):
        return json.loads(self._metrics_json) if self._metrics_json is not None else None


@dataclass(frozen=True)
class Superseded:
    pass


SUPERSEDED = Superseded()


@dataclass(frozen=True)
class RawStatus:
    state: str
    generation: int | None
    selection_epoch: int
    resident_count: int
    edits: int
    preview_running: bool
    preview_pending: bool


@dataclass
class _Photo:
    handle: RawHandle
    path: str = field(repr=False)
    fingerprint: tuple
    content_hash: str
    photo_id: int | None
    settings_json: str = field(repr=False)
    applied_revision: int = 0
    requested_revision: int = 0
    sync: str = "synced"
    wb_kelvin: bool = False
    as_shot_wb: tuple[float, float] | None = field(default=None, repr=False)
    before_fingerprint: str | None = None
    source_size: tuple[int, int] | None = None


class PreviewTicket:
    def __init__(self, handle, epoch, revision, sequence, max_side, kind="after", key=None):
        self.handle, self.epoch, self.revision = handle, epoch, revision
        self.sequence, self.max_side = sequence, max_side
        self.kind, self.key = kind, key
        self.abandoned = False
        self.serial = 0
        self.quality = "full"
        self.view_generation = 0
        self.geometry_id = None
        self.adaptive = False
        self.reason = "replaced"
        self._future = asyncio.get_running_loop().create_future()
        self._future.add_done_callback(lambda f: None if f.cancelled() else f.exception())

    async def wait(self):
        try:
            # Cancelling a UI waiter must never cancel a transmitted engine operation.
            return await asyncio.shield(self._future)
        except asyncio.CancelledError:
            if self.kind != "before":
                self.abandoned = True
            raise

    def __await__(self):
        return self.wait().__await__()

    def _finish(self, result=SUPERSEDED, error=None):
        if not self._future.done():
            if error is not None and not self.abandoned:
                self._future.set_exception(LightCraftError(error))
            else:
                self._future.set_result(result)


def _object_json(value, limit):
    # Reject depth/size before serialization, including large caller-owned strings and arrays.
    remaining = limit

    def visit(v, depth):
        nonlocal remaining
        remaining -= 8
        if depth > 32 or remaining < 0:
            raise ValueError()
        if isinstance(v, dict):
            for k, item in v.items():
                if not isinstance(k, str):
                    raise ValueError()
                visit(k, depth + 1)
                visit(item, depth + 1)
        elif isinstance(v, list):
            for item in v:
                visit(item, depth + 1)
        elif isinstance(v, str):
            if len(v) > remaining:
                raise ValueError()
            remaining -= len(v.encode("utf-8"))
        elif type(v) is float:
            if not math.isfinite(v):
                raise ValueError()
        elif v is not None and type(v) not in (bool, int):
            raise ValueError()

    try:
        if not isinstance(value, dict):
            raise ValueError()
        visit(value, 0)
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > limit:
            raise ValueError()
        return encoded
    except (ValueError, TypeError, OverflowError, RecursionError, UnicodeError):
        raise LightCraftError("raw_invalid_settings") from None


def _settings_json(value):
    encoded = _object_json(value, MAX_SETTINGS_BYTES)
    value = json.loads(encoded)
    if type(value.get("process")) is not int or not 0 <= value["process"] <= 0xffffffff or \
            value.get("version") != 1 or type(value.get("version")) is not int or not isinstance(value.get("wb"), dict):
        raise LightCraftError("raw_invalid_settings")
    wb = value["wb"]
    wb.setdefault("scale", "legacy")
    if wb["scale"] not in ("legacy", "kelvin"):
        raise LightCraftError("raw_invalid_settings")
    return _object_json(value, MAX_SETTINGS_BYTES)


def _source_info(value):
    try:
        path = Path(value)
        if not path.is_absolute() or str(path).startswith(("\\\\", "//")) or \
                (os.name == "nt" and os.path.isreserved(str(path))):
            raise LightCraftError("raw_invalid_path")
        path = path.resolve(strict=True)
        if str(path).startswith(("\\\\", "//")):
            raise LightCraftError("raw_invalid_path")
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
            raise LightCraftError("raw_invalid_path")
        return str(path), (info.st_size, info.st_mtime_ns, info.st_dev, info.st_ino)
    except (OSError, TypeError, ValueError):
        raise LightCraftError("raw_source_unavailable") from None


def _validate_png(result, photo_id, max_side, kind="after", before_fingerprint=None, geometry=None, quality=None):
    try:
        content = result["content"]
        if len(content) != 2 or any(not isinstance(c, dict) for c in content):
            raise ValueError()
        images = [c for c in content if c.get("type") == "image"]
        texts = [c for c in content if c.get("type") == "text"]
        if len(images) != 1 or len(texts) != 1 or "structuredContent" in result:
            raise ValueError()
        image, text = images[0], texts[0].get("text")
        data = image.get("data")
        if image.get("mimeType") != "image/png" or not isinstance(data, str) or \
                not data or len(data) > MAX_BASE64_CHARS or not isinstance(text, str) or \
                len(text) > MAX_METADATA_BYTES or len(text.encode("utf-8")) > MAX_METADATA_BYTES:
            raise ValueError()
        metadata = _decode(text.encode("utf-8"))
        allowed = {"id", "width", "height"}
        if kind == "before":
            allowed |= {"kind", "beforeFingerprint", "effectiveBeforeFingerprint", "geometry"}
        elif isinstance(metadata, dict) and "kind" in metadata:
            allowed.add("kind")
        if quality is not None:
            allowed |= {"kind", "previewContract", "quality", "mode", "frame", "stageCache"}
        if not isinstance(metadata, dict) or set(metadata) != allowed or \
                type(metadata["id"]) is not int or metadata["id"] != photo_id:
            raise ValueError()
        if metadata.get("kind", "after") != kind:
            raise ValueError()
        if kind == "before" and (metadata["beforeFingerprint"] != before_fingerprint
                or not isinstance(metadata["effectiveBeforeFingerprint"], str)
                or not re.fullmatch(r"[0-9a-f]{16}", metadata["effectiveBeforeFingerprint"])
                or _object_json(metadata["geometry"], MAX_METADATA_BYTES) != _object_json(geometry, MAX_METADATA_BYTES)):
            raise ValueError()
        w, h = metadata["width"], metadata["height"]
        if quality is not None:
            frame, cache = metadata["frame"], metadata["stageCache"]
            if type(metadata["previewContract"]) is not int or metadata["previewContract"] != 1 or \
                    metadata["quality"] != quality or metadata["mode"] != "whole" or \
                    not isinstance(frame, dict) or set(frame) != {"geometryId", "nativeWidth", "nativeHeight", "aspect", "fullWidth", "fullHeight", "window"} or \
                    not isinstance(frame["geometryId"], str) or not re.fullmatch(r"[a-f0-9]{64}", frame["geometryId"]) or \
                    any(type(frame[k]) is not int or not 0 < frame[k] <= 2**31 - 1 for k in ("nativeWidth", "nativeHeight", "fullWidth", "fullHeight")) or \
                    type(frame["aspect"]) not in (int, float) or not math.isfinite(frame["aspect"]) or frame["aspect"] <= 0 or \
                    (frame["fullWidth"], frame["fullHeight"]) != (w, h) or frame["window"] is not None or \
                    not isinstance(cache, dict) or set(cache) != {"mode", "applied", "reason", "cpuBytes", "gpuBytes", "retainedBytes", "budgetBytes"} or \
                    cache["mode"] not in ("off", "on") or type(cache["applied"]) is not bool or cache["reason"] not in ("none", "budget") or \
                    any(type(cache[k]) is not int or not 0 <= cache[k] <= 2**53 - 1 for k in ("cpuBytes", "gpuBytes", "retainedBytes", "budgetBytes")) or \
                    cache["retainedBytes"] > cache["budgetBytes"] or \
                    cache["mode"] == "off" and (cache["applied"] or cache["retainedBytes"] or cache["reason"] != "none") or \
                    cache["mode"] == "on" and (cache["budgetBytes"] == 0 or cache["applied"] != (cache["reason"] == "none")):
                raise ValueError()
        if type(w) is not int or type(h) is not int or min(w, h) <= 0 or \
                max(w, h) > max_side or w * h > MAX_PREVIEW_SIDE * MAX_PREVIEW_SIDE:
            raise ValueError()
        raw = base64.b64decode(data, validate=True)
        if len(raw) > MAX_IMAGE_BYTES or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError()
        offset, ended = 8, False
        while offset < len(raw):
            if len(raw) - offset < 12:
                raise ValueError()
            size = struct.unpack_from(">I", raw, offset)[0]
            end = offset + 12 + size
            if end > len(raw):
                raise ValueError()
            kind = raw[offset + 4:offset + 8]
            if zlib.crc32(raw[offset + 4:end - 4]) != struct.unpack_from(">I", raw, end - 4)[0]:
                raise ValueError()
            if kind == b"IEND":
                ended = size == 0 and end == len(raw)
                break
            offset = end
        if not ended:
            raise ValueError()
        # Verify headers before load: no decompression bomb may allocate its declared pixels.
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as opened:
                if opened.format != "PNG" or opened.size != (w, h) or opened.n_frames != 1:
                    raise ValueError()
                opened.verify()
            with Image.open(io.BytesIO(raw)) as opened:
                opened.load()
        return (raw, w, h, metadata) if quality is not None else (raw, w, h)
    except Exception:
        # Never retain a Pillow/upstream exception (or its image/path-bearing traceback).
        raise LightCraftError("lightcraft_invalid_preview") from None


def _thread_job(function, *args):
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    def deliver(result):
        if not future.done():
            future.set_result(result)

    def run():
        try:
            outcome = (function(*args), None)
        except LightCraftError as error:
            outcome = (None, error.code)
        except Exception:
            outcome = (None, "raw_worker_failed")
        try:
            loop.call_soon_threadsafe(deliver, outcome)
        except RuntimeError:
            pass

    thread = threading.Thread(target=run, name="lightcraft-raw-worker", daemon=True)
    thread.start()
    return thread, future


async def _finish_future(future):
    cancelled = False
    current = asyncio.current_task()
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            cancelled = True
            current.uncancel()
    return cancelled


class LightCraftRawSession:
    def __init__(self, manager, *, timeouts=None, stage_cache=None, stage_cache_budget_bytes=None, diagnostics=False):
        self.manager = manager
        self._timeouts = timeouts or RawTimeouts()
        self._lock = asyncio.Lock()
        self._control_reservations = 0
        self._control_idle = asyncio.Event()
        self._control_idle.set()
        self._lifecycle = asyncio.Lock()
        self._stop = asyncio.Event()
        self._photos = {}
        self._resident = set()
        self._active = None
        self._desired_token = None
        self._generation = None
        self._budget_set = False
        self._lost = False
        self._desynchronized = False
        self._phase = None
        self._epoch = self._sequence = self._revision = self._edits = 0
        self._operations = set()
        self._worker = self._pending = self._running = None
        self._before_pending = self._before_cache = None
        self._before_sequence = 0
        self._validation = None
        self._file_thread = None
        self._resetting = False
        self._reset_task = self._close_task = None
        self._closed = False
        self._diagnostics = diagnostics
        self._stage_mode = os.environ.get("GENZOROOM_RAW_STAGE_CACHE", "off") if stage_cache is None else stage_cache
        budget = os.environ.get("GENZOROOM_RAW_STAGE_CACHE_BUDGET_BYTES", "") if stage_cache is None else str(stage_cache_budget_bytes or "")
        if self._stage_mode not in ("off", "on") or self._stage_mode == "on" and (len(budget) > 10 or not budget.isascii() or not budget.isdigit() or not 0 < int(budget) <= 1024**3):
            raise LightCraftError("raw_invalid_preview_request")
        self._stage_budget = int(budget) if self._stage_mode == "on" else None
        self._preview_trials = 0

    def reserve_control(self):
        # HTTP retains this fence through readback and durable receipt verification.
        self._control_reservations += 1
        self._control_idle.clear()

    def release_control(self):
        self._control_reservations -= 1
        if not self._control_reservations:
            self._control_idle.set()

    def cancel_preview(self, handle, kind, serial):
        self._photo(handle, active=True)
        for name in ("_pending", "_before_pending", "_running"):
            ticket = getattr(self, name)
            if ticket and ticket.handle == handle and ticket.kind == kind and ticket.serial == serial:
                ticket.abandoned, ticket.reason = True, "cancelled"
                if name != "_running":
                    setattr(self, name, None)
                    ticket._finish()

    def _observe(self):
        status = self.manager.status()
        if self._generation is not None and (status.generation != self._generation or status.state != "ready"):
            self._lost = True
            self._discard_pending("raw_session_lost")
        return status

    def status(self):
        self._observe()
        photo = self._photos.get(self._active)
        state = ("stopped" if self._closed else "closing" if self._stop.is_set() else
                 "lost" if self._lost else "desynchronized" if self._desynchronized else
                 self._phase or (photo.sync if photo else "empty"))
        return RawStatus(state, self._generation, self._epoch, len(self._resident), self._edits,
                         self._running is not None, self._pending is not None or self._before_pending is not None)

    def _available(self, *, allow_desync=False):
        if self._stop.is_set():
            raise LightCraftError("raw_closed")
        if self._resetting:
            raise LightCraftError("raw_resetting")
        status = self._observe()
        if self._lost:
            raise LightCraftError("raw_session_lost")
        if status.state != "ready":
            raise LightCraftError("lightcraft_not_ready")
        if self._desynchronized and not allow_desync:
            raise LightCraftError("raw_session_desynchronized")
        if self._generation is None:
            self._generation = status.generation

    def _photo(self, handle, *, active=False, allow_desync=False):
        self._available(allow_desync=allow_desync)
        photo = self._photos.get(handle.source_key) if isinstance(handle, RawHandle) else None
        if photo is None or photo.handle != handle or handle.generation != self._generation or photo.photo_id is None:
            raise LightCraftError("raw_stale_handle")
        if active and (self._active != handle.source_key or self._desired_token != handle.document_token):
            raise LightCraftError("raw_not_active")
        if photo.sync != "synced" and not allow_desync:
            raise LightCraftError("raw_desynchronized")
        return photo

    def _snapshot(self, photo):
        return DevelopSnapshot(photo.handle, photo.applied_revision, photo.settings_json,
                               _fingerprint=photo.fingerprint, _content_hash=photo.content_hash,
                               wb_kelvin=photo.wb_kelvin)

    def _discard_pending(self, error=None):
        if self._pending is not None:
            self._pending._finish(error=error)
            self._pending = None
        if error and self._before_pending is not None:
            self._before_pending._finish(error=error)
            self._before_pending = None

    def _invalidate(self, *, selection=False):
        self._sequence += 1
        if selection:
            self._epoch += 1
            self._before_cache = None
            if self._before_pending is not None:
                self._before_pending._finish()
                self._before_pending = None
        self._discard_pending()

    def _remaining(self, deadline):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError()
        return remaining

    async def _command(self, command, params, deadline):
        status = self.manager.status()
        if self._stop.is_set():
            raise LightCraftError("raw_closed")
        if status.state != "ready" or status.generation != self._generation:
            self._lost = True
            raise MCPTransportError("lightcraft_session_lost")
        limit = self._timeouts.import_raw if command == "library.import" else self._timeouts.command
        return await self.manager._raw_command(self._generation, command, params,
                                               timeout=min(limit, self._remaining(deadline)))

    async def _read_settings(self, photo, deadline):
        value = await self._command("develop.get", {"id": photo.photo_id}, deadline)
        try:
            return _settings_json(value)
        except LightCraftError:
            self.manager._abort_raw(self._generation, "lightcraft_invalid_settings_response")
            raise MCPTransportError("lightcraft_invalid_settings_response") from None

    def _commit(self, photo, settings, revision=None):
        if revision is None:
            self._revision += 1
            revision = self._revision
        photo.settings_json = settings
        photo.applied_revision = revision
        if photo.requested_revision <= revision:
            photo.requested_revision = revision
        photo.sync = "synced"
        lightcraft_log("raw.settingsConfirmed", level="debug", generation=self._generation,
                       revision=revision, edits=self._edits)
        return self._snapshot(photo)

    async def _file_info(self, path):
        if self._file_thread is not None and self._file_thread.is_alive():
            raise LightCraftError("raw_inspection_busy")
        self._file_thread, result = _thread_job(_source_info, path)
        stop = asyncio.create_task(self._stop.wait())
        try:
            async with asyncio.timeout(self._timeouts.admission):
                done, _ = await asyncio.wait((result, stop), return_when=asyncio.FIRST_COMPLETED)
                if stop in done:
                    raise LightCraftError("raw_closed")
                value, error = result.result()
                if error:
                    raise LightCraftError(error)
                return value
        except TimeoutError:
            raise LightCraftError("raw_inspection_timeout") from None
        finally:
            stop.cancel()
            await asyncio.gather(stop, return_exceptions=True)

    async def _submit(self, action, timeout):
        self._available(allow_desync=True)
        if sum(not t.done() for t in self._operations) >= 2:
            raise LightCraftError("raw_busy")

        async def run():
            acquired = False
            try:
                deadline = asyncio.get_running_loop().time() + timeout
                async with asyncio.timeout(min(self._timeouts.admission, timeout)):
                    await self._lock.acquire()
                acquired = True
                self._available(allow_desync=True)
                async with asyncio.timeout(self._remaining(deadline)):
                    return await action(deadline)
            except TimeoutError:
                raise LightCraftError("raw_operation_timeout" if acquired else "raw_busy_timeout") from None
            except MCPTransportError as error:
                if error.code != "lightcraft_busy_timeout":
                    self._lost = True
                    self._discard_pending("raw_session_lost")
                raise
            except LightCraftError as error:
                self._observe()
                lightcraft_log("raw.operationFailed", level="error", generation=self._generation,
                               errorCode=error.code)
                raise
            finally:
                if acquired:
                    self._phase = None
                    self._lock.release()

        task = asyncio.create_task(run(), name="lightcraft-raw-operation")
        self._operations.add(task)
        try:
            return await task
        finally:
            self._operations.discard(task)

    async def _import(self, key, path, fingerprint, previous, deadline):
        if not self._budget_set:
            budget = await self._command("app.memoryBudget", {"mb": 1024}, deadline)
            if not isinstance(budget, dict) or type(budget.get("budget")) is not int or budget["budget"] != 1024**3:
                raise LightCraftError("raw_memory_budget_mismatch")
            self._budget_set = True
        try:
            result = await self._command("library.import", {"paths": [path], "mode": "add"}, deadline)
        except BaseException:
            self._desynchronized = True
            raise
        if not isinstance(result, dict) or not isinstance(result.get("imported"), list) or \
                not isinstance(result.get("failed"), list) or not isinstance(result.get("duplicates"), list):
            self._desynchronized = True
            raise LightCraftError("raw_invalid_import_response")
        ids = result["imported"]
        if result["failed"] or result.get("restored") or len(ids) > 1 or ids and result["duplicates"]:
            self._desynchronized = bool(ids) or bool(result.get("restored"))
            raise LightCraftError("raw_import_failed")
        if not ids and len(result["duplicates"]) == 1:
            duplicate = result["duplicates"][0]
            ids = [duplicate.get("existing")] if isinstance(duplicate, dict) else []
        if len(ids) != 1 or type(ids[0]) is not int or not 0 < ids[0] <= 0xffffffffffffffff:
            self._desynchronized = True
            raise LightCraftError("raw_invalid_import_response")
        photo_id = ids[0]
        if photo_id in self._resident:
            raise LightCraftError("raw_duplicate_source")
        self._resident.add(photo_id)
        try:
            info = await self._command("photo.inspect", {"id": photo_id}, deadline)
            if not isinstance(info, dict) or type(info.get("id")) is not int or info["id"] != photo_id or \
                    info.get("kind") != "raw" or info.get("preview_only") is not None or \
                    any(type(info.get(k)) is not int or info[k] <= 0 for k in ("width", "height")) or \
                    not isinstance(info.get("content_hash"), str) or not re.fullmatch(r"[0-9a-fA-F]{16,128}", info["content_hash"]):
                raise LightCraftError("raw_unsupported_source")
            if previous is not None and (previous.fingerprint != fingerprint or previous.content_hash != info["content_hash"]):
                raise LightCraftError("raw_source_changed")
            handle = RawHandle(key, uuid.uuid4().hex, self._generation)
            photo = _Photo(handle, path, fingerprint, info["content_hash"], photo_id, "")
            photo.source_size = (info["width"], info["height"])
            await self._command("library.select", {"ids": [photo_id], "active": photo_id, "mode": "replace"}, deadline)
            # Import defaults are native Session state, never a copy of the persisted After recipe.
            try:
                supported = await self.manager._raw_before_supported(self._generation)
                before = await self._command("beforeAfter.setBefore", {"source": "import"}, deadline)
                if supported and isinstance(before, dict) and isinstance(before.get("beforeFingerprint"), str) \
                        and re.fullmatch(r"[0-9a-f]{16}", before["beforeFingerprint"]):
                    photo.before_fingerprint = before["beforeFingerprint"]
            except LightCraftError as error:
                if isinstance(error, MCPTransportError):
                    raise
                lightcraft_log("before.unavailable", level="warn", generation=self._generation, errorCode=error.code)
            settings = await self._read_settings(photo, deadline)
            # Only expose Kelvin editing when the engine supplies a measured as-shot white.
            white = info.get("as_shot_wb")
            photo.wb_kelvin = (isinstance(white, list) and len(white) == 2
                               and all(type(v) in (int, float) and math.isfinite(v) for v in white)
                               and 2000 <= white[0] <= 50000 and -150 <= white[1] <= 150
                               and json.loads(settings).get("wb", {}).get("scale") == "kelvin")
            if photo.wb_kelvin:
                photo.as_shot_wb = tuple(white)
            if previous is not None:
                settings = await self._restore(photo, previous.settings_json, deadline)
            self._commit(photo, settings)
            self._photos[key] = photo
            return photo
        except BaseException:
            # Import may already have mutated the catalog; require reset rather than leak slots.
            self._desynchronized = True
            raise

    async def open_raw(self, source_key, absolute_path):
        self._available()
        if not isinstance(source_key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", source_key):
            raise LightCraftError("raw_invalid_source_key")

        # Admission failures must not disturb the current selection or invalidate a usable handle.
        path, fingerprint = await self._file_info(absolute_path)
        previous = self._photos.get(source_key)
        if previous is not None and (path != previous.path or fingerprint != previous.fingerprint):
            raise LightCraftError("raw_source_changed")
        if previous is None and len(self._photos) >= MAX_RAW_FILES:
            raise LightCraftError("raw_session_capacity")

        self._invalidate(selection=True)
        epoch = self._epoch
        previous_active = self._photos.get(self._active)
        previous_token = self._desired_token
        self._desired_token = None

        async def action(deadline):
            self._phase = "loading"
            if epoch != self._epoch:
                raise LightCraftError("raw_selection_superseded")
            previous = self._photos.get(source_key)
            if previous is not None and (path != previous.path or fingerprint != previous.fingerprint):
                raise LightCraftError("raw_source_changed")
            if previous is None and len(self._photos) >= MAX_RAW_FILES:
                raise LightCraftError("raw_session_capacity")
            if previous is not None and previous.photo_id is not None:
                photo = previous
                await self._command("library.select", {"ids": [photo.photo_id], "active": photo.photo_id, "mode": "replace"}, deadline)
                photo.handle = RawHandle(source_key, uuid.uuid4().hex, self._generation)
                self._commit(photo, await self._read_settings(photo, deadline))
            else:
                if len(self._resident) >= MAX_RAW_FILES:
                    raise LightCraftError("raw_session_capacity")
                photo = await self._import(source_key, path, fingerprint, previous, deadline)
            self._active = source_key
            if epoch == self._epoch:
                self._desired_token = photo.handle.document_token
            return photo.handle, self._snapshot(photo)

        try:
            return await self._submit(action, self._timeouts.import_raw)
        except BaseException:
            # A rejected latest request may restore intent, but its epoch stays advanced so old frames stay stale.
            if epoch == self._epoch and previous_active is not None and \
                    self._photos.get(previous_active.handle.source_key) is previous_active and \
                    previous_active.handle.generation == self._generation and \
                    previous_active.sync == "synced" and not self._lost and not self._desynchronized:
                self._active = previous_active.handle.source_key
                self._desired_token = previous_token or previous_active.handle.document_token
            raise

    async def select(self, handle):
        self._photo(handle)
        self._invalidate(selection=True)
        epoch = self._epoch
        self._desired_token = handle.document_token

        async def action(deadline):
            photo = self._photo(handle)
            if epoch != self._epoch:
                raise LightCraftError("raw_selection_superseded")
            await self._command("library.select", {"ids": [photo.photo_id], "active": photo.photo_id, "mode": "replace"}, deadline)
            self._active = handle.source_key
            settings = await self._read_settings(photo, deadline)
            if settings != photo.settings_json:
                self._commit(photo, settings)
            return self._snapshot(photo)

        return await self._submit(action, self._timeouts.command)

    def confirmed_settings(self, handle, expected_revision, *, allow_desync=False):
        """Observe the last confirmed snapshot without issuing an engine command."""
        photo = self._photo(handle, active=True, allow_desync=allow_desync)
        if type(expected_revision) is not int or expected_revision != photo.applied_revision:
            raise LightCraftError("raw_revision_conflict")
        return self._snapshot(photo)

    async def get_settings(self, handle):
        self._photo(handle, allow_desync=True)

        async def action(deadline):
            photo = self._photo(handle, allow_desync=True)
            settings = await self._read_settings(photo, deadline)
            if settings != photo.settings_json or photo.sync != "synced":
                self._invalidate()
                self._commit(photo, settings)
                photo.requested_revision = photo.applied_revision
            return self._snapshot(photo)

        return await self._submit(action, self._timeouts.command)

    async def _restore(self, photo, encoded, deadline, *, count_attempts=False):
        if count_attempts:
            self._edits += 1
        await self._command("develop.reset", {"ids": [photo.photo_id]}, deadline)
        if count_attempts:
            self._edits += 1
        await self._command("develop.merge", {"settings": json.loads(encoded)}, deadline)
        actual = await self._read_settings(photo, deadline)
        if actual != encoded:
            raise LightCraftError("raw_restore_mismatch")
        return actual

    async def _mutate(self, handle, command, params, expected_revision, restored=None, verify=None,
                      *, commands=None, check=None):
        photo = self._photo(handle, active=True)
        cost = len(commands) if commands is not None else 1
        if type(expected_revision) is not int or expected_revision != photo.applied_revision:
            raise LightCraftError("raw_revision_conflict")
        if self._edits + cost > MAX_EDITS:
            raise LightCraftError("raw_session_edit_limit")
        if sum(not t.done() for t in self._operations) >= 2:
            raise LightCraftError("raw_busy")
        self._revision += 1
        reserved = self._revision
        photo.requested_revision = reserved
        self._invalidate()

        async def action(deadline):
            sent = False
            try:
                current = self._photo(handle, active=True)
                if expected_revision != current.applied_revision:
                    raise LightCraftError("raw_revision_conflict")
                if self._edits + cost > MAX_EDITS:
                    raise LightCraftError("raw_session_edit_limit")
                if verify is not None:
                    verify()
                self._phase = "applying"
                await self._command("library.select", {"ids": [photo.photo_id], "active": photo.photo_id, "mode": "replace"}, deadline)
                sent = True
                # Count attempts too: a failed readback must not permit unbounded native History.
                if commands is not None:
                    for native_command, native_params in commands:
                        self._edits += 1
                        await self._command(native_command, native_params, deadline)
                    actual = await self._read_settings(photo, deadline)
                    check(json.loads(actual))
                elif restored is not None:
                    self._edits += 1
                    actual = await self._restore(photo, restored, deadline)
                else:
                    self._edits += 1
                    await self._command(command, params, deadline)
                    actual = await self._read_settings(photo, deadline)
                if verify is not None:
                    verify()
                return self._commit(photo, actual, reserved)
            except BaseException:
                if sent and commands is not None and self._edits + 2 <= MAX_EDITS:
                    try:
                        # A compound Reset is never a partially accepted edit. Only an exact
                        # rollback keeps the original revision available for immutable retry.
                        await self._restore(photo, photo.settings_json, deadline, count_attempts=True)
                        sent = False
                        lightcraft_log("raw.operation.rolledBack", level="warn", generation=self._generation,
                                       mutationAttempts=self._edits)
                    except BaseException:
                        lightcraft_log("raw.operation.rollbackFailed", level="error", generation=self._generation,
                                       mutationAttempts=self._edits)
                if sent:
                    photo.sync = "desynchronized"
                raise

        try:
            return await self._submit(action, self._timeouts.command)
        finally:
            if photo.requested_revision == reserved:
                photo.requested_revision = photo.applied_revision

    async def set_controls(self, handle, values, expected_revision):
        values = json.loads(_object_json(values, MAX_PATCH_BYTES))
        if not values or any(not isinstance(k, str) or type(v) not in (float, int) for k, v in values.items()):
            raise LightCraftError("raw_invalid_controls")
        return await self._mutate(handle, "develop.set", {"values": values}, expected_revision)

    async def apply_history_operation(self, handle, kind, metadata, expected_revision):
        from raw_controls import CONTROLS, validate_history_operation
        validate_history_operation(kind, metadata)
        photo = self._photo(handle, active=True)
        before = photo.settings_json
        original = json.loads(before)
        disabled = original.get("disabled_sections", [])
        needs_wb = (kind == "allReset" or kind == "sectionReset" and metadata["section"] == "color"
                    or kind == "controlReset" and metadata["control"].startswith("wb."))
        if needs_wb and photo.as_shot_wb is None:
            raise LightCraftError("raw_wb_unavailable")
        if kind == "sectionToggle":
            commands = [("develop.sectionEnabled", metadata)]
        elif kind == "controlReset":
            commands = [("develop.wb", {"mode": "asShot"})] if needs_wb else [("develop.resetControl", metadata)]
        else:
            commands = [("develop.reset", {"ids": [photo.photo_id]})] if kind == "allReset" else [("develop.resetSection", metadata)]
            if needs_wb:
                commands.append(("develop.wb", {"mode": "asShot"}))
            if kind == "allReset":
                # An import look may carry bypass flags; preserve even an originally empty list.
                commands.append(("develop.merge", {"settings": {"disabled_sections": disabled}}))

        def check(actual):
            for control in CONTROLS:
                group, key = control.split(".")
                values = actual.get(group)
                if type(values) is not dict or type(values.get(key)) not in (int, float):
                    raise LightCraftError("raw_operation_readback_mismatch")
            expected_disabled = ([section for section in disabled if section != metadata["section"]]
                                 + ([] if metadata["enabled"] else [metadata["section"]])) if kind == "sectionToggle" else disabled
            if actual.get("disabled_sections", []) != expected_disabled:
                raise LightCraftError("raw_operation_readback_mismatch")
            if needs_wb:
                wb = actual.get("wb", {})
                temp, tint = photo.as_shot_wb
                if any(wb.get(key) != value for key, value in
                       (("mode", "asShot"), ("temp", temp), ("tint", tint), ("scale", "kelvin"))):
                    raise LightCraftError("raw_as_shot_mismatch")
            if kind in ("sectionToggle", "controlReset"):
                expected = json.loads(before)
                if kind == "sectionToggle":
                    expected["disabled_sections"] = expected_disabled
                elif needs_wb:
                    expected["wb"].update(mode="asShot", temp=temp, tint=tint, scale="kelvin")
                else:
                    group, key = metadata["control"].split(".")
                    expected[group][key] = CONTROLS[metadata["control"]][3]
                # Native defaults can encode 0 as 0.0; compare full values, not numeric JSON spelling.
                if actual != expected:
                    raise LightCraftError("raw_operation_readback_mismatch")
            elif kind == "sectionReset":
                section = metadata["section"]
                reset_groups = {"light", "hdr"} if section == "light" else {"color", "wb"}
                if ({key: value for key, value in actual.items() if key not in reset_groups}
                        != {key: value for key, value in original.items() if key not in reset_groups}):
                    raise LightCraftError("raw_operation_readback_mismatch")
                for control, spec in CONTROLS.items():
                    if control.startswith(f"{section}."):
                        group, key = control.split(".")
                        if actual.get(group, {}).get(key) != spec[3]:
                            raise LightCraftError("raw_operation_readback_mismatch")

        return await self._mutate(handle, None, None, expected_revision, commands=commands, check=check)

    async def merge_settings(self, handle, partial, expected_revision):
        partial = json.loads(_object_json(partial, MAX_PATCH_BYTES))
        if "process" in partial and (type(partial["process"]) is not int or not 0 <= partial["process"] <= 0xffffffff):
            raise LightCraftError("raw_invalid_settings")
        if "version" in partial and (type(partial["version"]) is not int or partial["version"] != 1):
            raise LightCraftError("raw_invalid_settings")
        wb = partial.get("wb")
        if isinstance(wb, dict) and ("temp" in wb or "tint" in wb) and wb.get("scale") not in ("legacy", "kelvin"):
            raise LightCraftError("raw_wb_scale_required")
        return await self._mutate(handle, "develop.merge", {"settings": partial}, expected_revision)

    async def restore_settings(self, handle, engine_snapshot, expected_revision):
        if not isinstance(handle, RawHandle) or not isinstance(engine_snapshot, DevelopSnapshot) or engine_snapshot.engine_version != "0.10.0" or \
                engine_snapshot.engine_commit != ENGINE_COMMIT or engine_snapshot.handle.source_key != handle.source_key:
            raise LightCraftError("raw_invalid_snapshot")
        photo = self._photo(handle, active=True)
        if engine_snapshot._fingerprint != photo.fingerprint or engine_snapshot._content_hash != photo.content_hash:
            raise LightCraftError("raw_source_changed")
        encoded = _settings_json(engine_snapshot.settings)
        return await self._mutate(handle, "develop.merge", {}, expected_revision, restored=encoded)

    def recipe_identity(self, handle):
        # Windows selects its DB profile after importing this module; do not bind persistence earlier.
        from raw_recipe_store import InvalidRawRecipe, normalize_identity
        photo = self._photo(handle, active=True)
        try:
            return normalize_identity({"assetId": handle.source_key, "sourceContentHash": photo.content_hash,
                "engineName": "lightcraft", "engineVersion": self.manager.status().version,
                "engineCommit": ENGINE_COMMIT, "settingsSchemaVersion": json.loads(photo.settings_json)["version"]})
        except InvalidRawRecipe:
            raise LightCraftError("raw_recipe_invalid") from None

    async def restore_persisted_settings(self, handle, recipe, expected_revision):
        """Restore a validated DB recipe to a new import; never relax private snapshot identity."""
        from raw_recipe_store import InvalidRawRecipe, IDENTITY_FIELDS, validate_raw_recipe
        try:
            recipe = validate_raw_recipe(recipe)
        except InvalidRawRecipe:
            raise LightCraftError("raw_recipe_invalid") from None
        identity = {key: recipe[key] for key in IDENTITY_FIELDS}
        epoch = self._epoch

        def verify():
            if epoch != self._epoch:
                raise LightCraftError("raw_stale_handle")
            current = self.recipe_identity(handle)
            if any(identity[key] != current[key] for key in ("assetId", "sourceContentHash")):
                raise LightCraftError("raw_recipe_source_mismatch")
            if current["engineVersion"] != "0.10.0" or current["settingsSchemaVersion"] != 1 or \
                    any(identity[key] != current[key] for key in IDENTITY_FIELDS[2:]):
                raise LightCraftError("raw_recipe_engine_incompatible")

        verify()
        # Preserve the native adapter's explicit legacy-scale normalization, not JPEG WB conversion.
        encoded = _settings_json(recipe["settings"])
        try:
            return await self._mutate(handle, "develop.merge", {}, expected_revision,
                                      restored=encoded, verify=verify)
        except MCPTransportError:
            raise LightCraftError("raw_recipe_restore_unknown") from None
        except LightCraftError as error:
            if error.code in {"raw_stale_handle", "raw_not_active", "raw_revision_conflict",
                              "raw_recipe_source_mismatch", "raw_recipe_engine_incompatible",
                              "raw_session_lost", "raw_closed", "raw_resetting"}:
                raise
            code = ("raw_recipe_restore_mismatch" if error.code == "raw_restore_mismatch" else
                    "raw_recipe_restore_unknown" if error.code == "raw_operation_timeout" else
                    "raw_recipe_restore_failed")
            raise LightCraftError(code) from None

    @staticmethod
    def _before_geometry(photo):
        settings = json.loads(photo.settings_json)
        return {name: settings.get(name) for name in ("crop", "orientation")}

    def before_key(self, handle, max_side=MAX_PREVIEW_SIDE):
        photo = self._photo(handle, active=True)
        if photo.before_fingerprint is None:
            return None
        # The native import fingerprint and current geometry describe the effective Before;
        # After exposure/WB/lens edits must not invalidate this read-only comparison image.
        value = {"source": [photo.content_hash, list(photo.fingerprint)], "document": [handle.source_key,
                 handle.document_token, handle.generation], "engine": ["0.10.0", ENGINE_COMMIT, "before-v1"],
                 "import": photo.before_fingerprint, "process": json.loads(photo.settings_json).get("process"),
                 "geometry": self._before_geometry(photo), "maxSide": max_side}
        return hashlib.sha256(_object_json(value, MAX_SETTINGS_BYTES).encode()).hexdigest()

    def request_preview(self, handle, expected_revision, max_side=MAX_PREVIEW_SIDE, *, kind="after",
                        quality=None, serial=0, view_generation=0, geometry_id=None):
        photo = self._photo(handle, active=True)
        if quality not in (None, "draft", "full"):
            raise LightCraftError("raw_invalid_request")
        if kind not in ("before", "after") or type(max_side) is not int or not 16 <= max_side <= MAX_PREVIEW_SIDE:
            raise LightCraftError("raw_invalid_preview_size")
        if type(expected_revision) is not int or photo.applied_revision != expected_revision or \
                photo.requested_revision != photo.applied_revision:
            raise LightCraftError("raw_revision_conflict")
        if kind == "before":
            key = self.before_key(handle, max_side)
            if quality is not None and key is not None:
                key = hashlib.sha256(f"{key}:{quality}".encode()).hexdigest()
            if key is None:
                raise LightCraftError("raw_before_unsupported")
            for pending in (self._before_pending, self._running):
                if quality is None and serial == 0 and pending and pending.kind == "before" and pending.key == key and self._ticket_current(pending):
                    return pending
            self._before_sequence += 1
            ticket = PreviewTicket(handle, self._epoch, expected_revision, self._before_sequence, max_side, kind, key)
            if quality is None and serial == 0 and self._before_cache is not None and self._before_cache.key == key:
                ticket._finish(replace(self._before_cache, revision=expected_revision, sequence=ticket.sequence))
                return ticket
            if self._before_pending:
                self._before_pending._finish()
            self._before_pending = ticket
        else:
            self._sequence += 1
            self._discard_pending()
            ticket = PreviewTicket(handle, self._epoch, expected_revision, self._sequence, max_side)
            self._pending = ticket
        ticket.quality, ticket.adaptive = quality or "full", quality is not None
        ticket.serial, ticket.view_generation, ticket.geometry_id = serial, view_generation, geometry_id
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._previews(), name="lightcraft-preview-worker")
        return ticket

    def _ticket_current(self, ticket):
        try:
            photo = self._photo(ticket.handle, active=True)
            if ticket.kind == "before":
                key = self.before_key(ticket.handle, ticket.max_side)
                if ticket.adaptive and key is not None:
                    key = hashlib.sha256(f"{key}:{ticket.quality}".encode()).hexdigest()
                return not ticket.abandoned and ticket.epoch == self._epoch and ticket.key == key
            return not ticket.abandoned and ticket.epoch == self._epoch and ticket.sequence == self._sequence and \
                ticket.revision == photo.applied_revision == photo.requested_revision
        except LightCraftError:
            return False

    async def _image(self, result, photo_id, max_side, kind="after", before_fingerprint=None, geometry=None, quality=None):
        args = (quality,) if quality is not None else ()
        _, future = _thread_job(_validate_png, result, photo_id, max_side, kind, before_fingerprint, geometry, *args)
        self._validation = future
        cancelled = False
        try:
            try:
                async with asyncio.timeout(self._timeouts.validation):
                    value, error = await asyncio.shield(future)
            except TimeoutError:
                raise LightCraftError("lightcraft_preview_validation_timeout") from None
            if error:
                raise LightCraftError(error)
            return value
        finally:
            # A logical timeout/cancel cannot stop Pillow. Retain and join this bounded worker
            # before admitting another image, including across reset and loop-wide cancellation.
            cancelled = await _finish_future(future)
            self._validation = None
            if cancelled:
                raise asyncio.CancelledError()

    async def _previews(self):
        try:
            while (self._pending is not None or self._before_pending is not None) and not self._stop.is_set() and not self._resetting:
                await self._control_idle.wait()
                controls = tuple(task for task in self._operations if not task.done())
                if controls:
                    await asyncio.wait(controls, return_when=asyncio.FIRST_COMPLETED)
                    continue
                # After has its own latest-wins slot and priority; Before never supersedes it.
                if self._pending is not None:
                    ticket, self._pending = self._pending, None
                else:
                    ticket, self._before_pending = self._before_pending, None
                self._running = ticket
                try:
                    if not self._ticket_current(ticket):
                        ticket._finish()
                        continue
                    async with asyncio.timeout(self._timeouts.admission):
                        await self._lock.acquire()
                    try:
                        if self._control_reservations or any(not task.done() for task in self._operations):
                            if ticket.kind == "before" and self._before_pending is None:
                                self._before_pending = ticket
                            elif ticket.kind == "after" and self._pending is None:
                                self._pending = ticket
                            else:
                                ticket._finish()
                            continue
                        if not self._ticket_current(ticket):
                            ticket._finish()
                            continue
                        if ticket.kind == "before" and self._pending is not None:
                            if self._before_pending is None:
                                self._before_pending = ticket
                            else:
                                ticket._finish()
                            continue
                        photo = self._photo(ticket.handle, active=True)
                        args = {"before": True} if ticket.kind == "before" else {}
                        if ticket.adaptive:
                            args.update(quality=ticket.quality, stage_cache=self._stage_mode,
                                        stage_cache_budget_bytes=self._stage_budget)
                        native_started = monotonic()
                        try:
                            result = await self.manager._raw_preview(self._generation, photo.photo_id, ticket.max_side,
                                                                     timeout=self._timeouts.preview, **args)
                        except MCPToolError:
                            # A helper can reject metadata after accept() has learned native defaults.
                            await self._preview_readback(photo, ticket)
                            raise
                        await self._preview_readback(photo, ticket)
                        geometry = self._before_geometry(photo)
                    finally:
                        self._lock.release()
                    # The worker still owns the result/validation, while native controls can proceed.
                    native_ms = (monotonic() - native_started) * 1000
                    validation_started = monotonic()
                    image = await self._image(result, photo.photo_id, ticket.max_side, ticket.kind,
                                              photo.before_fingerprint, geometry,
                                              *([ticket.quality] if ticket.adaptive else []))
                    validation_ms = (monotonic() - validation_started) * 1000
                    del result
                    data, w, h = image[:3]
                    metadata = image[3] if ticket.adaptive else None
                    if metadata and (metadata["stageCache"]["mode"] != self._stage_mode or
                            self._stage_mode == "on" and metadata["stageCache"]["budgetBytes"] != self._stage_budget):
                        raise LightCraftError("lightcraft_invalid_preview")
                    self._preview_trials += 1
                    digest = None
                    try:
                        if (self._diagnostics or backend_logger.get_level() == "debug") and ticket.quality == "full":
                            digest = hashlib.sha256(data).hexdigest()
                    except Exception:
                        pass
                    lightcraft_log("preview.measured", level="debug", generation=self._generation,
                        revision=ticket.revision, sequence=ticket.sequence, quality=ticket.quality, kind=ticket.kind,
                        trialIndex=self._preview_trials, configuredBackend=self.manager._gpu_backend,
                        pngSha256=digest,
                        nativeMs=native_ms, validationMs=validation_ms,
                        width=w, height=h, payloadBytes=len(data), stageCache=metadata["stageCache"] if metadata else None)
                    if self._ticket_current(ticket):
                        frame = PreviewFrame(ticket.handle, ticket.revision, ticket.epoch,
                                             ticket.sequence, w, h, data, kind=ticket.kind, key=ticket.key,
                                             quality=ticket.quality, _frame_json=json.dumps(metadata["frame"]) if metadata else None,
                                             _metrics_json=json.dumps({"nativeMs": native_ms,
                                                 "validationMs": validation_ms,
                                                 "pngSha256": digest, "stageCache": metadata["stageCache"]})
                                                 if self._diagnostics and metadata else None)
                        if ticket.kind == "before":
                            self._before_cache = frame
                        ticket._finish(frame)
                        lightcraft_log("preview.completed", level="debug", generation=self._generation,
                            revision=ticket.revision, sequence=ticket.sequence, quality=ticket.quality,
                            kind=ticket.kind, width=w, height=h, payloadBytes=len(data))
                    else:
                        ticket._finish()
                    del data, image
                except asyncio.CancelledError:
                    if not self._stop.is_set() and not self._resetting:
                        self._lost = True
                        self.manager._abort_raw(ticket.handle.generation, "lightcraft_request_cancelled")
                        self._discard_pending("raw_session_lost")
                    ticket._finish(error="raw_closed" if self._stop.is_set() else "raw_session_lost")
                    raise
                except TimeoutError:
                    ticket._finish(error="raw_busy_timeout")
                except LightCraftError as error:
                    if (isinstance(error, MCPTransportError) and error.code != "lightcraft_busy_timeout") or \
                            (ticket.kind == "after" and error.code in ("lightcraft_invalid_preview", "lightcraft_preview_validation_timeout")):
                        self.manager._abort_raw(ticket.handle.generation, error.code)
                        self._lost = True
                        self._discard_pending("raw_session_lost")
                    ticket._finish(error=error.code)
                except Exception:
                    if ticket.kind == "after":
                        self.manager._abort_raw(ticket.handle.generation, "lightcraft_preview_failed")
                        self._lost = True
                        self._discard_pending("raw_session_lost")
                    ticket._finish(error="lightcraft_preview_failed")
                finally:
                    self._running = None
        finally:
            if self._stop.is_set() or self._resetting:
                self._discard_pending("raw_closed" if self._stop.is_set() else "raw_session_lost")

    async def _preview_readback(self, photo, ticket):
        deadline = asyncio.get_running_loop().time() + self._timeouts.command
        try:
            settings = await self._read_settings(photo, deadline)
        except LightCraftError:
            photo.sync = "desynchronized"
            raise
        if settings != photo.settings_json:
            self._commit(photo, settings)
            ticket.abandoned, ticket.reason = True, "revision"

    async def _join_operations(self):
        tasks = [t for t in self._operations if not t.done()]
        if self._worker is not None and not self._worker.done():
            tasks.append(self._worker)
        for task in tasks:
            task.cancel()
        for task in tasks:
            await _await_task_resilient(task)

    async def reset_session(self, restore_active=True):
        if self._stop.is_set():
            raise LightCraftError("raw_closed")
        if self._resetting:
            raise LightCraftError("raw_resetting")
        self._resetting = True
        self._invalidate(selection=True)
        self._reset_task = asyncio.create_task(self._reset(restore_active), name="lightcraft-raw-reset")
        try:
            return await asyncio.shield(self._reset_task)
        except asyncio.CancelledError:
            self._reset_task.cancel()
            await _await_task_resilient(self._reset_task)
            # Cancellation before the task's first instruction never enters its finally block.
            self._resetting = False
            raise

    async def _reset(self, restore_active):
        async with self._lifecycle:
            active = self._active
            self._lost = True
            try:
                await self.manager.close()
                await self._join_operations()
                if self._stop.is_set():
                    raise LightCraftError("raw_closed")
                await self.manager.start()
                generation = self.manager.status().generation
                async with asyncio.timeout(self._timeouts.ready):
                    while True:
                        status = self.manager.status()
                        if self._stop.is_set():
                            raise LightCraftError("raw_closed")
                        if status.generation != generation or status.state in ("failed", "disabled", "stopped"):
                            raise LightCraftError("raw_reset_failed")
                        if status.state == "ready":
                            break
                        await asyncio.sleep(.01)
                self._generation = generation
                self._lost = self._desynchronized = self._budget_set = False
                self._resident.clear()
                self._edits = 0
                self._active = self._desired_token = None
                for photo in self._photos.values():
                    photo.photo_id = None
                if not restore_active:
                    # This explicit operation is also the PoC's bounded way to release snapshots.
                    self._photos.clear()
                if restore_active and active is not None:
                    previous = self._photos[active]
                    deadline = asyncio.get_running_loop().time() + self._timeouts.import_raw
                    async with self._lock, asyncio.timeout(self._timeouts.import_raw):
                        path, fingerprint = await self._file_info(previous.path)
                        photo = await self._import(active, path, fingerprint, previous, deadline)
                        self._active = active
                        self._desired_token = photo.handle.document_token
                        return photo.handle
                return None
            except BaseException:
                self._lost = True
                async def failed_reset():
                    try:
                        await self.manager.close()
                    finally:
                        await self._join_operations()
                cleanup = asyncio.create_task(failed_reset())
                await _await_task_resilient(cleanup)
                raise
            finally:
                self._resetting = False

    async def close(self):
        self._stop.set()
        self._invalidate(selection=True)
        if self._close_task is None or self._close_task.done() and not self._closed:
            self._close_task = asyncio.create_task(self._close(), name="lightcraft-raw-close")
        cancelled = await _await_task_resilient(self._close_task)
        if cancelled:
            raise asyncio.CancelledError()

    async def _close(self):
        async with self._lifecycle:
            try:
                await self.manager.close()
            finally:
                joined = asyncio.create_task(self._join_operations(), name="lightcraft-raw-join")
                await _await_task_resilient(joined)
                self._photos.clear()
                self._resident.clear()
                self._active = self._desired_token = None
            self._closed = True
