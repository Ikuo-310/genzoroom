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
from lightcraft_artifact import ENGINE_VERSION, ENGINE_COMMIT


# A 2048² RGBA preview needs 16 MiB before PNG scanline/compression overhead.
MAX_IMAGE_BYTES = 17 * 1024 * 1024
MAX_BASE64_CHARS = 4 * ((MAX_IMAGE_BYTES + 2) // 3)
MAX_METADATA_BYTES = 16 * 1024
MAX_PATCH_BYTES = 64 * 1024
MAX_SETTINGS_BYTES = 256 * 1024
MAX_RAW_FILES = 2
MAX_EDITS = 256
MAX_PREVIEW_SIDE = 2048
# Leave one Native command slot for opening and one for closing/canceling an interaction.
MAX_CURVE_INTERACTION_UPDATES = 128
MAX_CURVE_INTERACTION_SECONDS = 120
# Legacy bootstrap and document Before identity must not change with the advertised ceiling.
DEFAULT_PREVIEW_SIDE = 1024


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
    engine_version: str = ENGINE_VERSION
    engine_commit: str = ENGINE_COMMIT
    _fingerprint: tuple | None = field(default=None, repr=False)
    _content_hash: str | None = field(default=None, repr=False)
    wb_kelvin: bool = False
    wb_auto: bool = False
    lens_profile_info_json: str = field(default_factory=lambda: _lens_profile_info_json(None), repr=False)

    @property
    def settings(self):
        # Snapshots own serialized values: no caller dictionary can mutate the session's truth.
        return json.loads(self._json)

    @property
    def lens_profile_info(self):
        return json.loads(self.lens_profile_info_json)


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
    _crop_json: str | None = field(default=None, repr=False)
    interaction_id: str | None = None
    interaction_sequence: int | None = None

    @property
    def crop_display(self):
        return json.loads(self._crop_json) if self._crop_json is not None else None

    @property
    def frame(self):
        return json.loads(self._frame_json) if self._frame_json is not None else None

    @property
    def metrics(self):
        return json.loads(self._metrics_json) if self._metrics_json is not None else None


@dataclass(frozen=True)
class Superseded:
    pass


@dataclass(frozen=True)
class RegionResult:
    handle: RawHandle
    data: bytes = field(repr=False)
    _metadata: str = field(repr=False)

    @property
    def metadata(self):
        return json.loads(self._metadata)


@dataclass(frozen=True)
class CurveInteractionUpdate:
    interaction_id: str
    sequence: int
    applied: bool
    _settings_json: str | None = field(default=None, repr=False)
    preview_ticket: object | None = field(default=None, repr=False)

    @property
    def settings(self):
        return json.loads(self._settings_json) if self._settings_json is not None else None


@dataclass(frozen=True)
class CurveInteractionResult:
    handle: RawHandle
    interaction_id: str
    baseline_revision: int
    channel: str
    _settings_json: str = field(repr=False)

    @property
    def settings(self):
        return json.loads(self._settings_json)


@dataclass
class _CurveUpdateRequest:
    sequence: int
    points: list
    future: asyncio.Future
    max_side: int = DEFAULT_PREVIEW_SIDE
    view_generation: int = 0
    geometry_id: str | None = None


@dataclass
class _CurveInteraction:
    handle: RawHandle
    interaction_id: str
    baseline_revision: int
    channel: str
    mode: str
    baseline_settings_json: str
    working_settings_json: str
    started_at: float
    update_limit: int
    state: str = "opening"
    latest_sequence: int = 0
    applied_sequence: int = 0
    working_points: list | None = None
    update_attempts: int = 0
    pending: _CurveUpdateRequest | None = None
    preview_tickets: dict = field(default_factory=dict, repr=False)
    update_task: asyncio.Task | None = None
    final_points: list | None = None
    final_result: CurveInteractionResult | None = None
    committed_snapshot: DevelopSnapshot | None = None


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
    wb_auto: bool = False
    as_shot_wb: tuple[float, float] | None = field(default=None, repr=False)
    before_fingerprint: str | None = None
    source_size: tuple[int, int] | None = None
    lens_profile_info_json: str = field(default_factory=lambda: _lens_profile_info_json(None), repr=False)


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
        self.region_operation = None
        self.region_target = None
        self.region_document_token = None
        self.interaction_id = None
        self.interaction_sequence = None
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
    from raw_controls import (with_legacy_grading_defaults, with_legacy_optics_defaults,
                              with_legacy_curve_defaults, validate_curve_settings)
    # Missing native serde-default crop fields are normalized only in the engine view.
    from raw_geometry import DEFAULT_CROP
    value.setdefault('crop', json.loads(json.dumps(DEFAULT_CROP)))
    value.setdefault('orientation', 'Normal')
    # Older Recipes predate Optics; normalize only the engine view so their stored receipts remain valid.
    value = with_legacy_grading_defaults(value)
    value = with_legacy_optics_defaults(value)
    value = with_legacy_curve_defaults(value)
    validate_curve_settings(value)
    return _object_json(value, MAX_SETTINGS_BYTES)


def _lens_profile_info_json(value):
    unknown = {"cameraMake": None, "cameraModel": None, "lensMake": None, "lensModel": None, "lensId": None,
               "profileAvailable": None, "profileSource": "unknown", "profileName": None,
               "profileHasDistortion": False, "profileHasVignetting": False}
    if not isinstance(value, dict):
        return json.dumps(unknown, separators=(",", ":"))
    text_fields = ("cameraMake", "cameraModel", "lensMake", "lensModel", "lensId", "profileName")
    source = value.get("profileSource")
    available = value.get("profileAvailable")
    components = (value.get("profileHasDistortion"), value.get("profileHasVignetting"))
    def valid_text(item):
        if item is None:
            return True
        if not isinstance(item, str):
            return False
        try:
            return len(item.encode("utf-8")) <= 512
        except UnicodeError:
            return False
    valid = (all(valid_text(value.get(key)) for key in text_fields)
             and source in ("file", "database", "none", "unknown")
             and (available is None or type(available) is bool)
             and all(type(component) is bool for component in components)
             and ((source in ("file", "database") and available is True)
                  or (source == "none" and available is False) or (source == "unknown" and available is None)))
    if not valid:
        lightcraft_log("raw.lensProfileInfo.invalid", level="warn", errorCode="invalid_native_shape")
        return json.dumps(unknown, separators=(",", ":"))
    return json.dumps({key: value.get(key) for key in text_fields} | {
        "profileAvailable": available, "profileSource": source, "profileHasDistortion": components[0],
        "profileHasVignetting": components[1]}, ensure_ascii=False, separators=(",", ":"))


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
        if quality is not None and isinstance(metadata, dict) and "execution" in metadata:
            allowed.add("execution")
            execution = metadata["execution"]
            if not isinstance(execution, dict) or set(execution) != {"outcome", "backend", "reason"} or not (
                execution == {"outcome": "gpu_success", "backend": "gpu", "reason": "none"}
                or execution == {"outcome": "cpu_fallback", "backend": "cpu", "reason": "gpu_failed"}
                or execution.get("outcome") == "cpu_not_tried" and execution.get("backend") == "cpu"
                and execution.get("reason") in ("cpu_requested", "shutdown", "gpu_disabled", "unsupported", "gpu_unavailable")
            ):
                raise ValueError()
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


def _validate_crop_png(result, photo_id, max_side, quality, expected):
    try:
        text = next(c for c in result['content'] if c.get('type') == 'text')
        if not isinstance(text['text'], str) or len(text['text'].encode('utf-8')) > MAX_METADATA_BYTES:
            raise ValueError()
        meta = _decode(text['text'].encode('utf-8'))
        extras = {'cropEditContract', 'requestId', 'settingsFingerprint', 'canonicalGeometry', 'bitmapSpace'}
        if (type(meta['cropEditContract']) is not int or meta['cropEditContract'] != 1 or meta['mode'] != 'crop-edit'
                or meta['requestId'] != expected['requestId'] or meta['settingsFingerprint'] != expected['settingsFingerprint']
                or meta['canonicalGeometry'] != expected['canonicalGeometry']
                or meta['bitmapSpace'] != 'oriented-warped-unstraightened-flipped' or 'previewContract' in meta):
            raise ValueError()
        from raw_geometry import geometry_state
        geometry_state(meta['canonicalGeometry'], required=True)
        normalized = {k:v for k,v in meta.items() if k not in extras} | {'previewContract':1,'mode':'whole'}
        replacement = {'type':'text','text':json.dumps(normalized)}
        validated = _validate_png({**result,'content':[replacement if c is text else c for c in result['content']]},
                                 photo_id, max_side, quality=quality)
        return (*validated[:3], meta)
    except Exception:
        raise LightCraftError('lightcraft_invalid_preview') from None


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
        self._curve_state_lock = asyncio.Lock()
        self._curve_interaction = None
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

    def cancel_region(self, handle, request_id):
        self._photo(handle, active=True)
        for name in ("_pending", "_running"):
            ticket = getattr(self, name)
            if ticket and ticket.handle == handle and ticket.region_target is not None \
                    and ticket.region_target["requestId"] == request_id:
                # Detach delivery, but retain native/readback/validation ownership until settled.
                ticket.abandoned, ticket.reason = True, "cancelled"
                if name != "_running":
                    setattr(self, name, None)
                    ticket._finish()

    def _observe(self):
        status = self.manager.status()
        if self._generation is not None and (status.generation != self._generation or status.state != "ready"):
            self._lost = True
            self._discard_pending("raw_session_lost")
            interaction = self._curve_interaction
            if interaction is not None and interaction.state not in ("cancelled", "confirmed"):
                interaction.state = "failed"
                self._fail_curve_pending(interaction, "raw_session_lost")
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
        if status.version != ENGINE_VERSION or not ENGINE_COMMIT:
            raise LightCraftError("raw_recipe_engine_incompatible")
        artifact = self.manager.artifact_info()
        if artifact is None or artifact['version'] != ENGINE_VERSION or artifact['upstreamCommit'] != ENGINE_COMMIT:
            # A version string cannot authorize stamping a saved Recipe with a source commit.
            raise LightCraftError('raw_unverified_artifact')
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

    def _ensure_curve_interaction_owner(self, interaction_id=None):
        interaction = self._curve_interaction
        if interaction is None:
            return None
        if interaction.state in ("cancelled", "confirmed"):
            if interaction_id is None:
                return None
            if interaction_id != interaction.interaction_id:
                raise LightCraftError("raw_curve_interaction_stale")
            return interaction
        if interaction_id != interaction.interaction_id:
            raise LightCraftError("raw_curve_interaction_pending")
        if interaction.state in ("failed", "unknown"):
            raise LightCraftError("raw_session_desynchronized")
        return interaction

    def _snapshot(self, photo):
        return DevelopSnapshot(photo.handle, photo.applied_revision, photo.settings_json,
                               _fingerprint=photo.fingerprint, _content_hash=photo.content_hash,
                               wb_kelvin=photo.wb_kelvin, wb_auto=photo.wb_auto,
                               lens_profile_info_json=photo.lens_profile_info_json)

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

    async def _read_settings(self, photo, deadline, *, validate=None):
        value = await self._command("develop.get", {"id": photo.photo_id}, deadline)
        if validate is not None:
            validate(value)
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

    async def _submit(self, action, timeout, *, interaction_id=None):
        self._available(allow_desync=True)
        self._ensure_curve_interaction_owner(interaction_id)
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
                self._ensure_curve_interaction_owner(interaction_id)
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

    async def _refresh_lens_profile_info(self, photo, deadline):
        try:
            refreshed = await self._command("library.refreshLensProfiles", {"ids": [photo.photo_id], "all": True}, deadline)
            if not isinstance(refreshed, dict) or type(refreshed.get("checked")) is not int or \
                    type(refreshed.get("database")) is not bool or not isinstance(refreshed.get("found"), list) or \
                    any(type(value) is not int or value <= 0 for value in refreshed["found"]):
                raise LightCraftError("raw_invalid_lens_database_response")
        except LightCraftError as error:
            if isinstance(error, MCPTransportError):
                raise
            lightcraft_log("raw.lensProfileInfo.refreshUnavailable", level="warn", generation=self._generation,
                           errorCode=error.code)
        try:
            lens_info = await self._command("photo.lensProfileInfo", {"id": photo.photo_id}, deadline)
            photo.lens_profile_info_json = _lens_profile_info_json(lens_info)
        except LightCraftError as error:
            if isinstance(error, MCPTransportError):
                raise
            lightcraft_log("raw.lensProfileInfo.unavailable", level="warn", generation=self._generation,
                           errorCode=error.code)

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
            if previous is not None:
                await self._refresh_lens_profile_info(photo, deadline)
            else:
                try:
                    lens_info = await self._command("photo.lensProfileInfo", {"id": photo_id}, deadline)
                    photo.lens_profile_info_json = _lens_profile_info_json(lens_info)
                except LightCraftError as error:
                    if isinstance(error, MCPTransportError):
                        raise
                    lightcraft_log("raw.lensProfileInfo.unavailable", level="warn", generation=self._generation,
                                   errorCode=error.code)
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
            photo.wb_auto = await self.manager._raw_wb_supported(self._generation)
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
        self._ensure_curve_interaction_owner()
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
                await self._refresh_lens_profile_info(photo, deadline)
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
        self._ensure_curve_interaction_owner()
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
        self._ensure_curve_interaction_owner()
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

    async def lens_database_status(self):
        async def action(deadline):
            return await self._command("lens.databaseStatus", {}, deadline)
        return await self._submit(action, self._timeouts.command)

    async def download_lens_database(self):
        async def action(deadline):
            return await self._command("lens.downloadDatabase", {}, deadline)
        return await self._submit(action, self._timeouts.command)

    async def begin_curve_interaction(self, handle, channel, expected_revision, mode="points"):
        from raw_controls import CURVE_CHANNELS, curve_readback
        if type(channel) is not str or channel not in CURVE_CHANNELS or mode not in ("points", "targeted"):
            raise LightCraftError("raw_invalid_request")
        photo = self._photo(handle, active=True)
        if type(expected_revision) is not int or expected_revision != photo.applied_revision or \
                photo.requested_revision != photo.applied_revision:
            raise LightCraftError("raw_revision_conflict")
        if self._control_reservations or any(not task.done() for task in self._operations):
            raise LightCraftError("raw_busy")
        update_limit = min(MAX_CURVE_INTERACTION_UPDATES, MAX_EDITS - self._edits - 2)
        if update_limit < 1:
            raise LightCraftError("raw_session_edit_limit")

        async with self._curve_state_lock:
            previous = self._curve_interaction
            if previous is not None and previous.state not in ("cancelled", "confirmed"):
                raise LightCraftError("raw_curve_interaction_pending")
            interaction = _CurveInteraction(handle, uuid.uuid4().hex, expected_revision, channel, mode,
                                            photo.settings_json, photo.settings_json,
                                            asyncio.get_running_loop().time(), update_limit)
            self._curve_interaction = interaction
            self._invalidate()

        async def action(deadline):
            current = self._photo(handle, active=True)
            if current.applied_revision != expected_revision or current.requested_revision != expected_revision:
                raise LightCraftError("raw_revision_conflict")
            native = await self._read_settings(current, deadline)
            if native != interaction.baseline_settings_json:
                current.sync = "desynchronized"
                raise LightCraftError("raw_revision_conflict")
            try:
                curve_readback(json.loads(native))
            except LightCraftError:
                current.sync = "desynchronized"
                raise
            interaction.baseline_settings_json = native
            self._edits += 1
            await self._command("develop.beginInteraction", {"label": f"{channel.title()} Curve" if mode == "points" else f"{channel.title()} Targeted Curve"}, deadline)
            interaction.state = "open"
            return interaction.interaction_id

        try:
            await self._submit(action, self._timeouts.command, interaction_id=interaction.interaction_id)
            lightcraft_log("raw.curveInteraction.started", level="info", generation=self._generation,
                           revision=interaction.baseline_revision, interactionId=interaction.interaction_id,
                           channel=channel, updateLimit=interaction.update_limit)
            return interaction.interaction_id
        except MCPTransportError:
            interaction.state = "unknown"
            raise
        except BaseException as error:
            unknown = isinstance(error, LightCraftError) and error.code == "raw_operation_timeout"
            if unknown:
                interaction.state = "unknown"
                self._desynchronized = True
            elif self._lost or self._desynchronized or photo.sync != "synced":
                interaction.state = "failed"
            else:
                interaction.state = "cancelled"
            raise

    async def update_curve_interaction(self, handle, interaction_id, expected_revision, points, *,
                                       max_side=DEFAULT_PREVIEW_SIDE, view_generation=0, geometry_id=None):
        from raw_controls import validate_curve_input
        interaction = self._ensure_curve_interaction_owner(interaction_id)
        if interaction is None or interaction.handle != handle:
            raise LightCraftError("raw_curve_interaction_stale")
        if interaction.mode != "points":
            raise LightCraftError("raw_curve_interaction_stale")
        points = json.loads(_object_json({"points": points}, MAX_PATCH_BYTES))["points"]
        validate_curve_input(interaction.channel, points)
        photo = self._photo(handle, active=True)
        if interaction is None or interaction.handle != handle or interaction.state != "open":
            raise LightCraftError("raw_curve_interaction_stale")
        if type(expected_revision) is not int or expected_revision != interaction.baseline_revision or \
                photo.applied_revision != interaction.baseline_revision or photo.requested_revision != photo.applied_revision:
            raise LightCraftError("raw_revision_conflict")
        if asyncio.get_running_loop().time() - interaction.started_at > MAX_CURVE_INTERACTION_SECONDS:
            raise LightCraftError("raw_curve_interaction_expired")
        if interaction.update_attempts >= interaction.update_limit:
            raise LightCraftError("raw_session_edit_limit")

        loop = asyncio.get_running_loop()
        future = loop.create_future()
        future.add_done_callback(lambda result: None if result.cancelled() else result.exception())
        async with self._curve_state_lock:
            if self._curve_interaction is not interaction or interaction.state != "open":
                raise LightCraftError("raw_curve_interaction_stale")
            interaction.latest_sequence += 1
            request = _CurveUpdateRequest(interaction.latest_sequence, json.loads(
                json.dumps(points, separators=(",", ":"), allow_nan=False)), future,
                max_side, view_generation, geometry_id)
            if interaction.pending is not None and not interaction.pending.future.done():
                interaction.pending.future.set_result(SUPERSEDED)
            interaction.pending = request
            running = self._running
            if running is not None and running.interaction_id == interaction_id:
                running.abandoned, running.reason = True, "curve_updated"
            if interaction.update_task is None or interaction.update_task.done():
                interaction.update_task = asyncio.create_task(self._drain_curve_updates(interaction),
                                                              name="lightcraft-curve-updates")
        return await asyncio.shield(future)

    async def update_targeted_curve_interaction(self, handle, interaction_id, expected_revision, target, steps, *,
                                                max_side=DEFAULT_PREVIEW_SIDE, view_generation=0, geometry_id=None):
        """Apply ordered relative steps; every call is serialized and never coalesced."""
        from raw_controls import curve_readback
        interaction = self._ensure_curve_interaction_owner(interaction_id)
        if interaction is None or interaction.handle != handle or interaction.mode != "targeted" or interaction.state != "open":
            raise LightCraftError("raw_curve_interaction_stale")
        if type(target) is not dict or set(target) != {"x", "y"} or any(type(target[k]) not in (int, float) or not math.isfinite(target[k]) or not 0 <= target[k] <= 1 for k in target):
            raise LightCraftError("raw_invalid_request")
        if type(steps) is not list or not steps or len(steps) > 128 or any(type(step) is not int or step == 0 or abs(step) > 255 for step in steps):
            raise LightCraftError("raw_invalid_request")
        if type(expected_revision) is not int or expected_revision != interaction.baseline_revision:
            raise LightCraftError("raw_revision_conflict")
        # A per-interaction lock preserves pointer order across concurrent HTTP requests.
        lock = getattr(interaction, "target_lock", None)
        if lock is None:
            lock = interaction.target_lock = asyncio.Lock()
        async with lock:
            if interaction.update_attempts + len(steps) > interaction.update_limit or self._edits + len(steps) + 1 >= MAX_EDITS:
                raise LightCraftError("raw_session_edit_limit")
            seq = interaction.latest_sequence + 1
            sent = False
            async def action(deadline):
                nonlocal sent
                photo = self._photo(handle, active=True)
                if photo.applied_revision != interaction.baseline_revision or photo.requested_revision != interaction.baseline_revision:
                    raise LightCraftError("raw_revision_conflict")
                for delta in steps:
                    self._edits += 1
                    interaction.update_attempts += 1
                    await self._command("develop.targeted", {"target":"curve", "channel":interaction.channel,
                        "x":float(target["x"]), "y":float(target["y"]), "delta":delta}, deadline)
                    sent = True
                return await self._read_settings(photo, deadline, validate=lambda settings: curve_readback(settings))
            try:
                encoded = await self._submit(action, self._timeouts.command, interaction_id=interaction_id)
            except BaseException as error:
                unknown = isinstance(error, LightCraftError) and error.code == "raw_operation_timeout"
                if sent or unknown or isinstance(error, MCPTransportError) or self._lost:
                    interaction.state = "failed"; self._desynchronized = True
                raise
            interaction.latest_sequence = interaction.applied_sequence = seq
            interaction.working_settings_json = encoded
            points = curve_readback(json.loads(encoded))[interaction.channel]
            interaction.working_points = [[p["x"], p["y"]] for p in points]
            ticket = self.request_curve_interaction_preview(handle, interaction_id, seq, max_side, view_generation, geometry_id)
            interaction.preview_tickets[seq] = ticket
            # The renderer supersedes older frames; retain only the recent waiter tickets per open gesture.
            for old_sequence in sorted(interaction.preview_tickets)[:-2]:
                interaction.preview_tickets.pop(old_sequence, None)
            return CurveInteractionUpdate(interaction_id, seq, True, encoded, ticket)

    async def _drain_curve_updates(self, interaction):
        from raw_controls import curve_readback
        while True:
            async with self._curve_state_lock:
                request = interaction.pending
                interaction.pending = None
                if request is None:
                    interaction.update_task = None
                    return
                if self._curve_interaction is not interaction or interaction.state not in ("open", "finalizing"):
                    if not request.future.done():
                        request.future.set_result(SUPERSEDED)
                    continue

            async def action(deadline):
                nonlocal sent
                if self._curve_interaction is not interaction or interaction.state not in ("open", "finalizing") or \
                        request.sequence != interaction.latest_sequence:
                    return None
                photo = self._photo(interaction.handle, active=True)
                if photo.applied_revision != interaction.baseline_revision or \
                        photo.requested_revision != interaction.baseline_revision:
                    raise LightCraftError("raw_revision_conflict")
                if interaction.update_attempts >= interaction.update_limit or self._edits + 1 >= MAX_EDITS:
                    raise LightCraftError("raw_session_edit_limit")
                interaction.update_attempts += 1
                self._edits += 1
                await self._command("develop.curve", {"channel": interaction.channel,
                                                        "points": request.points}, deadline)
                sent = True
                encoded = await self._read_settings(photo, deadline,
                    validate=lambda settings: curve_readback(settings))
                return encoded

            sent = False
            try:
                encoded = await self._submit(action, self._timeouts.command, interaction_id=interaction.interaction_id)
            except BaseException as error:
                unknown = isinstance(error, LightCraftError) and error.code == "raw_operation_timeout"
                if sent or unknown or isinstance(error, MCPTransportError) or self._lost:
                    interaction.state = "failed"
                    self._desynchronized = True
                    self._fail_curve_pending(interaction, "raw_session_lost")
                if not request.future.done():
                    request.future.set_exception(error)
                if interaction.state in ("failed", "unknown"):
                    return
                continue

            async with self._curve_state_lock:
                current = self._curve_interaction is interaction and interaction.state in ("open", "finalizing")
                latest = request.sequence == interaction.latest_sequence and interaction.pending is None
                if encoded is not None and current:
                    interaction.working_settings_json = encoded
                    interaction.applied_sequence = request.sequence
                    interaction.working_points = request.points
                if not request.future.done():
                    if encoded is None or not current or not latest:
                        request.future.set_result(SUPERSEDED)
                    elif interaction.state == "finalizing":
                        request.future.set_result(CurveInteractionUpdate(interaction.interaction_id,
                            request.sequence, True, encoded))
                    elif interaction.state != "open":
                        request.future.set_result(SUPERSEDED)
                    else:
                        ticket = self.request_curve_interaction_preview(interaction.handle,
                            interaction.interaction_id, request.sequence, request.max_side,
                            request.view_generation, request.geometry_id)
                        request.future.set_result(CurveInteractionUpdate(interaction.interaction_id,
                            request.sequence, True, encoded, ticket))

    def _fail_curve_pending(self, interaction, code):
        pending = interaction.pending
        interaction.pending = None
        if pending is not None and not pending.future.done():
            pending.future.set_exception(LightCraftError(code))

    def request_curve_interaction_preview(self, handle, interaction_id, sequence, max_side=DEFAULT_PREVIEW_SIDE,
                                          view_generation=0, geometry_id=None):
        interaction = self._ensure_curve_interaction_owner(interaction_id)
        if interaction is None or interaction.handle != handle:
            raise LightCraftError("raw_curve_interaction_stale")
        if interaction.state != "open" or sequence != interaction.latest_sequence or \
                sequence != interaction.applied_sequence or interaction.pending is not None:
            raise LightCraftError("raw_curve_interaction_stale")
        return self.request_preview(handle, interaction.baseline_revision, max_side, kind="after", quality="draft",
                                    view_generation=view_generation, geometry_id=geometry_id,
                                    interaction_id=interaction_id, interaction_sequence=sequence)

    async def end_curve_interaction(self, handle, interaction_id, expected_revision, points):
        from raw_controls import curve_readback, validate_curve_input
        interaction = self._ensure_curve_interaction_owner(interaction_id)
        if interaction is None or interaction.handle != handle:
            raise LightCraftError("raw_curve_interaction_stale")
        if interaction.mode == "points":
            points = json.loads(_object_json({"points": points}, MAX_PATCH_BYTES))["points"]
            validate_curve_input(interaction.channel, points)
        else:
            points = None
        if type(expected_revision) is not int or expected_revision != interaction.baseline_revision:
            raise LightCraftError("raw_revision_conflict")
        if interaction.state == "finalized":
            if points != interaction.final_points:
                raise LightCraftError("raw_curve_interaction_conflict")
            return interaction.final_result
        if interaction.state == "confirmed":
            if points != interaction.final_points:
                raise LightCraftError("raw_curve_interaction_conflict")
            return interaction.final_result
        if interaction.state == "ending":
            raise LightCraftError("raw_busy")
        if interaction.state == "open" and interaction.mode == "points":
            async with self._curve_state_lock:
                interaction.state = "finalizing"
                interaction.final_points = points
                # Reuse the last verified Native update when Pointer Up did not change its payload.
                already_applied = interaction.pending is None and interaction.latest_sequence == interaction.applied_sequence \
                    and interaction.working_points == points
                worker = interaction.update_task if already_applied else None
                if not already_applied:
                    loop = asyncio.get_running_loop()
                    future = loop.create_future()
                    future.add_done_callback(lambda result: None if result.cancelled() else result.exception())
                    interaction.latest_sequence += 1
                    request = _CurveUpdateRequest(interaction.latest_sequence,
                        json.loads(json.dumps(points, separators=(",", ":"), allow_nan=False)), future)
                    if interaction.pending is not None and not interaction.pending.future.done():
                        interaction.pending.future.set_result(SUPERSEDED)
                    interaction.pending = request
                    running = self._running
                    if running is not None and running.interaction_id == interaction_id:
                        running.abandoned, running.reason = True, "curve_finalizing"
                    if interaction.update_task is None or interaction.update_task.done():
                        interaction.update_task = asyncio.create_task(self._drain_curve_updates(interaction),
                                                                      name="lightcraft-curve-updates")
            if already_applied:
                if worker is not None and not worker.done():
                    await asyncio.shield(worker)
            else:
                try:
                    applied = await asyncio.shield(future)
                    if applied is SUPERSEDED:
                        raise LightCraftError("raw_curve_interaction_stale")
                except BaseException:
                    if interaction.state == "finalizing" and not self._lost:
                        interaction.state = "open"
                        interaction.final_points = None
                    raise
        elif interaction.state == "open" and interaction.mode == "targeted":
            interaction.state = "finalizing"
            interaction.final_points = None
        elif interaction.state != "finalizing":
            raise LightCraftError("raw_curve_interaction_stale")

        interaction.state = "ending"
        ended = False
        async def action(deadline):
            nonlocal ended
            photo = self._photo(handle, active=True)
            if photo.applied_revision != interaction.baseline_revision or \
                    photo.requested_revision != interaction.baseline_revision:
                raise LightCraftError("raw_revision_conflict")
            self._edits += 1
            await self._command("develop.endInteraction", {}, deadline)
            ended = True
            encoded = await self._read_settings(photo, deadline, validate=curve_readback)
            return encoded

        try:
            encoded = await self._submit(action, self._timeouts.command, interaction_id=interaction_id)
        except MCPTransportError:
            interaction.state = "unknown"
            self._desynchronized = True
            raise
        except LightCraftError as error:
            # A definite command rejection leaves Native's Interaction open for retry or cancel.
            unknown = error.code == "raw_operation_timeout"
            if unknown:
                interaction.state = "unknown"
                self._desynchronized = True
            elif not ended and not self._lost:
                interaction.state = "finalizing"
                raise
            else:
                interaction.state = "failed"
                self._desynchronized = True
            raise
        result = CurveInteractionResult(handle, interaction_id, interaction.baseline_revision,
                                        interaction.channel, encoded)
        interaction.final_result = result
        interaction.state = "finalized"
        self._invalidate()
        lightcraft_log("raw.curveInteraction.ended", level="info", generation=self._generation,
                       revision=interaction.baseline_revision, interactionId=interaction_id,
                       channel=interaction.channel, updates=interaction.update_attempts)
        return result

    async def cancel_curve_interaction(self, handle, interaction_id, expected_revision):
        interaction = self._ensure_curve_interaction_owner(interaction_id)
        if interaction is None or interaction.handle != handle:
            raise LightCraftError("raw_curve_interaction_stale")
        if type(expected_revision) is not int or expected_revision != interaction.baseline_revision:
            raise LightCraftError("raw_revision_conflict")
        if interaction.state == "cancelled":
            return self._snapshot(self._photo(handle, active=True))
        if interaction.state in ("finalized", "confirmed"):
            raise LightCraftError("raw_curve_interaction_finalized")
        if interaction.state not in ("open", "finalizing"):
            raise LightCraftError("raw_curve_interaction_stale")
        async with self._curve_state_lock:
            interaction.state = "canceling"
            if interaction.pending is not None and not interaction.pending.future.done():
                interaction.pending.future.set_result(SUPERSEDED)
            interaction.pending = None
            running = self._running
            if running is not None and running.interaction_id == interaction_id:
                running.abandoned, running.reason = True, "curve_canceling"
            worker = interaction.update_task
        if worker is not None and not worker.done():
            await asyncio.shield(worker)

        cancelled = False
        async def action(deadline):
            nonlocal cancelled
            photo = self._photo(handle, active=True)
            self._edits += 1
            await self._command("develop.cancelInteraction", {}, deadline)
            cancelled = True
            return await self._read_settings(photo, deadline)

        try:
            encoded = await self._submit(action, self._timeouts.command, interaction_id=interaction_id)
        except MCPTransportError:
            interaction.state = "unknown"
            self._desynchronized = True
            raise
        except LightCraftError as error:
            if cancelled or self._lost or error.code == "raw_operation_timeout":
                interaction.state = "failed"
                self._desynchronized = True
            else:
                interaction.state = "open"
            raise
        if encoded != interaction.baseline_settings_json:
            interaction.state = "failed"
            self._desynchronized = True
            self._invalidate()
            lightcraft_log("raw.curveInteraction.cancelMismatch", level="error", generation=self._generation,
                           revision=interaction.baseline_revision, interactionId=interaction_id)
            raise LightCraftError("raw_curve_interaction_cancel_mismatch")
        interaction.state = "cancelled"
        self._invalidate()
        lightcraft_log("raw.curveInteraction.cancelled", level="info", generation=self._generation,
                       revision=interaction.baseline_revision, interactionId=interaction_id,
                       channel=interaction.channel, updates=interaction.update_attempts)
        return self._snapshot(self._photo(handle, active=True))

    def confirm_curve_interaction(self, handle, interaction_id, baseline_revision):
        """Promote an ended Native snapshot only after the caller has durably saved its History step."""
        interaction = self._curve_interaction
        photo = self._photo(handle, active=True)
        if interaction is None or interaction.interaction_id != interaction_id or interaction.handle != handle or \
                interaction.baseline_revision != baseline_revision:
            raise LightCraftError("raw_curve_interaction_stale")
        if interaction.state == "confirmed":
            if interaction.committed_snapshot is None:
                raise LightCraftError("raw_curve_interaction_stale")
            return interaction.committed_snapshot
        if interaction.state != "finalized" or photo.applied_revision != baseline_revision or \
                photo.requested_revision != baseline_revision or interaction.final_result is None:
            raise LightCraftError("raw_revision_conflict")
        snapshot = self._commit(photo, interaction.final_result._settings_json)
        interaction.committed_snapshot = snapshot
        interaction.state = "confirmed"
        self._invalidate()
        return snapshot

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
                      *, commands=None, check=None, prepare=None, readback_check=None):
        self._ensure_curve_interaction_owner()
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
            nonlocal params
            sent = False
            try:
                current = self._photo(handle, active=True)
                if expected_revision != current.applied_revision:
                    raise LightCraftError("raw_revision_conflict")
                if self._edits + cost > MAX_EDITS:
                    raise LightCraftError("raw_session_edit_limit")
                if verify is not None:
                    verify()
                if prepare is not None:
                    params = await prepare(photo, deadline)
                    current = self._photo(handle, active=True)
                    if current.applied_revision != expected_revision or current.requested_revision != reserved:
                        raise LightCraftError('raw_revision_conflict')
                    if verify is not None:
                        verify()
                    if params is None:
                        return self._snapshot(current)
                self._phase = "applying"
                await self._command("library.select", {"ids": [photo.photo_id], "active": photo.photo_id, "mode": "replace"}, deadline)
                if prepare is not None or verify is not None:
                    self._photo(handle, active=True)
                    if photo.applied_revision != expected_revision or photo.requested_revision != reserved:
                        raise LightCraftError('raw_revision_conflict')
                    if verify is not None:
                        verify()
                sent = True
                # Count attempts too: a failed readback must not permit unbounded native History.
                if commands is not None:
                    for native_command, native_params in commands:
                        self._edits += 1
                        await self._command(native_command, native_params, deadline)
                    actual = await self._read_settings(photo, deadline)
                elif restored is not None:
                    self._edits += 1
                    actual = await self._restore(photo, restored, deadline)
                else:
                    self._edits += 1
                    await self._command(command, params, deadline)
                    actual = await self._read_settings(photo, deadline, validate=readback_check)
                if check is not None:
                    check(json.loads(actual))
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
        if not values or any(not isinstance(k, str) or type(v) not in (float, int, bool) for k, v in values.items()):
            raise LightCraftError("raw_invalid_controls")
        if any(type(value) is bool for value in values.values()):
            if any(not key.startswith("optics.") for key in values):
                raise LightCraftError("raw_invalid_controls")
            from raw_controls import CONTROL_PATHS
            partial = {}
            for key, value in values.items():
                field = CONTROL_PATHS[key][-1]
                section = partial.setdefault("optics", {})
                section[field] = value
            # The native numeric control command cannot write Optics' boolean settings.
            return await self._mutate(handle, "develop.merge", {"settings": partial}, expected_revision)
        return await self._mutate(handle, "develop.set", {"values": values}, expected_revision)

    async def apply_geometry(self, handle, operation, expected_revision):
        from raw_geometry import native_command, geometry_state
        photo = self._photo(handle, active=True)
        command, params = native_command(operation, photo.photo_id)
        before = json.loads(photo.settings_json)

        def check(actual):
            geometry_state(actual, required=True)
            # Geometry commands must not silently alter unrelated development settings.
            if ({k: v for k, v in actual.items() if k not in ('crop', 'orientation')}
                    != {k: v for k, v in before.items() if k not in ('crop', 'orientation')}):
                raise LightCraftError('raw_geometry_readback_mismatch')
            if operation['type'] == 'reset':
                from raw_geometry import DEFAULT_CROP
                if actual['crop'] != DEFAULT_CROP or actual['orientation'] != before.get('orientation', 'Normal'):
                    raise LightCraftError('raw_geometry_readback_mismatch')

        return await self._mutate(handle, command, params, expected_revision, check=check,
                                  readback_check=lambda value: geometry_state(value, required=True))

    async def estimate_white_balance(self, handle, expected_revision, *, prepared, verify, frame=None):
        from raw_white_balance import result_fingerprint, validate_candidate
        photo = self._photo(handle, active=True)
        original = photo.settings_json
        epoch = self._epoch
        expected = None

        def owner():
            verify()
            current = self._photo(handle, active=True)
            if self._epoch != epoch or current.applied_revision != expected_revision or current.settings_json != original:
                raise LightCraftError('raw_revision_conflict')

        async def estimate(current, deadline):
            nonlocal expected
            owner()
            if not current.wb_auto or not current.wb_kelvin or 'color' in json.loads(original).get('disabled_sections', []):
                raise LightCraftError('raw_wb_unavailable')
            lightcraft_log('raw.wb.started', level='info', generation=self._generation, revision=expected_revision)
            native = await self.manager._raw_native_settings(self._generation, current.photo_id, timeout=self._remaining(deadline))
            owner()
            try:
                fingerprint = result_fingerprint(native)
                if json.loads(_settings_json(native['structuredContent'])) != json.loads(original):
                    current.sync = 'desynchronized'
                    raise ValueError()
            except (KeyError, TypeError, ValueError, StopIteration, LightCraftError):
                raise LightCraftError('raw_wb_settings_mismatch') from None
            identity = {'id': str(current.photo_id), 'wb_contract': 1, 'operation': 'auto',
                        'settingsFingerprint': fingerprint, 'requestId': uuid.uuid4().hex}
            if frame is not None:
                identity.update(operation='pick', frame=dict(frame))
            result = await self.manager._raw_estimate_wb(self._generation, identity, timeout=self._remaining(deadline))
            owner()
            try:
                candidate = validate_candidate(result, identity)
                # A read-only estimate cannot authorize applying to a different native snapshot.
                latest = await self.manager._raw_native_settings(self._generation, current.photo_id, timeout=self._remaining(deadline))
                owner()
                if result_fingerprint(latest) != fingerprint:
                    current.sync = 'desynchronized'
                    raise LightCraftError('raw_wb_settings_mismatch')
            except (KeyError, TypeError, ValueError, StopIteration):
                raise LightCraftError('raw_wb_invalid_response') from None
            expected = json.loads(original)
            expected['wb'].update(candidate)
            prepared(expected)
            lightcraft_log('raw.wb.estimated', level='debug', generation=self._generation,
                           revision=expected_revision, requestId=identity['requestId'])
            return None if expected == json.loads(original) else {'settings': {'wb': candidate}, 'label': 'White Balance'}

        def check(actual):
            if actual != expected:
                raise LightCraftError('raw_operation_readback_mismatch')

        snapshot = await self._mutate(handle, 'develop.merge', None, expected_revision,
                                      prepare=estimate, verify=owner, check=check)
        lightcraft_log('raw.wb.completed', level='info', generation=self._generation, revision=snapshot.revision,
                       result='unchanged' if snapshot.settings == json.loads(original) else 'applied')
        return snapshot

    async def apply_wb_candidate(self, handle, baseline, expected, expected_revision, *, verify):
        photo = self._photo(handle, active=True)
        if json.loads(photo.settings_json) != baseline:
            raise LightCraftError('raw_history_readback_mismatch')

        def check(actual):
            if actual != expected:
                raise LightCraftError('raw_operation_readback_mismatch')

        # Retry only after readback proved the original state; reuse the frozen candidate, never estimate again.
        return await self._mutate(handle, 'develop.merge', {'settings': {'wb': expected['wb']}, 'label': 'White Balance'},
                                  expected_revision, verify=verify, check=check)

    async def apply_history_operation(self, handle, kind, metadata, expected_revision, *, curve_points=None):
        from raw_controls import (CONTROLS, CONTROL_PATHS, control_location, DETAIL_RESET_DEFAULTS,
                                  HISTORY_FLAG_CONTROLS, validate_history_operation, validate_curve_input)
        if kind == "curveReset":
            validate_history_operation(kind, metadata)
            channel = metadata["channel"]
            photo = self._photo(handle, active=True)
            expected = json.loads(photo.settings_json)
            channels = ("master", "red", "green", "blue") if channel == "point" else (channel,)
            if all(expected["curve"][target] == [] for target in channels):
                return self.confirmed_settings(handle, expected_revision)
            # Native owns reset semantics; the command targets only point curves.
            return await self._mutate(handle, "curve.reset", {"channel": channel}, expected_revision)
        if kind == "curve":
            if type(metadata) is not dict or set(metadata) != {"channel"}:
                raise LightCraftError("raw_invalid_request")
            points = validate_curve_input(metadata["channel"], curve_points)
            channel = metadata["channel"]
            photo = self._photo(handle, active=True)
            return await self._mutate(handle, "develop.curve", {"channel": channel, "points": points},
                                     expected_revision)
        if curve_points is not None:
            raise LightCraftError("raw_invalid_request")
        validate_history_operation(kind, metadata)
        if kind in ('wbAuto', 'wbPick'):
            # WB must pass the separate read-only estimate/candidate fence before any mutation.
            raise LightCraftError('raw_invalid_request')
        photo = self._photo(handle, active=True)
        before = photo.settings_json
        original = json.loads(before)
        disabled = original.get("disabled_sections", [])
        needs_wb = (kind == "allReset" or kind == "sectionReset" and metadata["section"] == "color"
                    or kind == "controlReset" and metadata["control"].startswith("wb."))
        if needs_wb and photo.as_shot_wb is None:
            raise LightCraftError("raw_wb_unavailable")
        if kind == "vignetteStyle":
            if original.get("vignette", {}).get("style") == metadata["style"]:
                return self.confirmed_settings(handle, expected_revision)
            commands = [("develop.merge", {"settings": {"vignette": {"style": metadata["style"]}}})]
        elif kind in ("opticsFlag", "opticsFlagReset"):
            control = metadata["control"]
            field = CONTROL_PATHS[control][1]
            value = metadata.get("enabled", False)
            commands = [("develop.merge", {"settings": {"optics": {field: value}}})]
        elif kind == "sectionToggle":
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

        if kind == "sectionReset" and metadata["section"] == "grading":
            # Native resetSection also resets the unexposed global wheel. Merge only our controls
            # in one mutation so category Reset keeps the existing edit-limit/retry boundary.
            patch = {"grading": {band: {} for band in ("shadows", "midtones", "highlights")}}
            for control, spec in CONTROLS.items():
                if control.startswith("grading."):
                    parent, key = control_location(patch, control)
                    parent[key] = spec[3]
            commands = [("develop.merge", {"settings": patch})]

        def check(actual):
            for control in CONTROLS:
                values, key = control_location(actual, control)
                if type(values) is not dict or type(values.get(key)) not in (int, float):
                    raise LightCraftError("raw_operation_readback_mismatch")
            for control in HISTORY_FLAG_CONTROLS:
                values, key = control_location(actual, control)
                if type(values) is not dict or type(values.get(key)) is not bool:
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
            if kind == "allReset":
                expected_optics = {CONTROL_PATHS[control][1]: spec[3] for control, spec in CONTROLS.items()
                                   if control.startswith("optics.")}
                expected_optics.update(remove_ca=False, lens_profile=False)
                if actual.get("optics") != expected_optics:
                    raise LightCraftError("raw_operation_readback_mismatch")
            if kind in ("sectionToggle", "controlReset", "opticsFlag", "opticsFlagReset", "vignetteStyle"):
                expected = json.loads(before)
                if kind == "vignetteStyle":
                    expected["vignette"]["style"] = metadata["style"]
                elif kind == "sectionToggle":
                    expected["disabled_sections"] = expected_disabled
                elif kind in ("opticsFlag", "opticsFlagReset"):
                    parent, key = control_location(expected, metadata["control"])
                    parent[key] = metadata.get("enabled", False)
                elif needs_wb:
                    expected["wb"].update(mode="asShot", temp=temp, tint=tint, scale="kelvin")
                else:
                    parent, key = control_location(expected, metadata["control"])
                    parent[key] = CONTROLS[metadata["control"]][3]
                # Native defaults can encode 0 as 0.0; compare full values, not numeric JSON spelling.
                if actual != expected:
                    raise LightCraftError("raw_operation_readback_mismatch")
            elif kind == "sectionReset":
                section = metadata["section"]
                if section == "grading":
                    expected = json.loads(before)
                    # Keep unexposed global grading values intact when resetting the three bands.
                    for control, spec in CONTROLS.items():
                        if control.startswith("grading."):
                            parent, key = control_location(expected, control)
                            parent[key] = spec[3]
                    if actual != expected:
                        raise LightCraftError("raw_operation_readback_mismatch")
                    return
                if section in ("effects", "vignette"):
                    expected = json.loads(before)
                    # Each subsection resets only its numeric controls; style, seed and the eye survive.
                    keys = [CONTROL_PATHS[c][1] for c in CONTROLS if c.startswith(f"{section}.")]
                    expected[section].update({CONTROL_PATHS[c][1]: spec[3] for c, spec in CONTROLS.items()
                                              if c.startswith(f"{section}.")})
                    if (any(type(actual[section].get(key)) not in (int, float) for key in keys) or actual != expected):
                        raise LightCraftError("raw_operation_readback_mismatch")
                    return
                if section == "detail":
                    expected = json.loads(before)
                    if type(expected.get("detail")) is not dict or type(expected.get("enhance")) is not dict:
                        raise LightCraftError("raw_operation_readback_mismatch")
                    expected["detail"].update(DETAIL_RESET_DEFAULTS)
                    # Native resets AI amount and removes its optional override, but preserves
                    # raw_details, super_resolution and all unrelated settings.
                    expected["enhance"]["denoise"] = 0
                    expected["enhance"].pop("denoise_on", None)
                    detail, enhance = actual.get("detail"), actual.get("enhance")
                    if (type(detail) is not dict or type(enhance) is not dict
                            or any(type(detail.get(key)) not in (int, float) for key in DETAIL_RESET_DEFAULTS)
                            or type(enhance.get("denoise")) not in (int, float)
                            or any(type(enhance.get(key)) is not bool for key in ("raw_details", "super_resolution"))
                            or actual != expected):
                        raise LightCraftError("raw_operation_readback_mismatch")
                    return
                if section == "optics":
                    expected = json.loads(before)
                    expected["optics"] = {CONTROL_PATHS[control][1]: spec[3] for control, spec in CONTROLS.items()
                        if control.startswith("optics.")}
                    expected["optics"].update({"remove_ca": False, "lens_profile": False})
                    if actual != expected:
                        raise LightCraftError("raw_operation_readback_mismatch")
                    return
                reset_groups = {"light", "hdr"} if section == "light" else {"color", "wb"}
                if ({key: value for key, value in actual.items() if key not in reset_groups}
                        != {key: value for key, value in original.items() if key not in reset_groups}):
                    raise LightCraftError("raw_operation_readback_mismatch")
                for control, spec in CONTROLS.items():
                    if control.startswith(f"{section}."):
                        group, key = CONTROL_PATHS[control]
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
        if not isinstance(handle, RawHandle) or not isinstance(engine_snapshot, DevelopSnapshot) or engine_snapshot.engine_version != ENGINE_VERSION or \
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
            if identity["engineName"] != "lightcraft" or identity["settingsSchemaVersion"] != 1 or \
                    current["engineName"] != "lightcraft" or current["settingsSchemaVersion"] != 1:
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

    def before_key(self, handle, max_side=DEFAULT_PREVIEW_SIDE):
        photo = self._photo(handle, active=True)
        if photo.before_fingerprint is None:
            return None
        # The native import fingerprint and current geometry describe the effective Before;
        # After exposure/WB/lens edits must not invalidate this read-only comparison image.
        value = {"source": [photo.content_hash, list(photo.fingerprint)], "document": [handle.source_key,
                 handle.document_token, handle.generation], "engine": [ENGINE_VERSION, ENGINE_COMMIT, "before-v1"],
                 "import": photo.before_fingerprint, "process": json.loads(photo.settings_json).get("process"),
                 "geometry": self._before_geometry(photo), "maxSide": max_side}
        return hashlib.sha256(_object_json(value, MAX_SETTINGS_BYTES).encode()).hexdigest()

    def request_preview(self, handle, expected_revision, max_side=DEFAULT_PREVIEW_SIDE, *, kind="after",
                        quality=None, serial=0, view_generation=0, geometry_id=None, mode="whole",
                        interaction_id=None, interaction_sequence=None):
        photo = self._photo(handle, active=True)
        interaction = self._ensure_curve_interaction_owner(interaction_id)
        if interaction_id is None and self._curve_interaction is not None and \
                self._curve_interaction.state not in ("cancelled", "confirmed"):
            raise LightCraftError("raw_curve_interaction_pending")
        if interaction_id is not None and (interaction is None or interaction.handle != handle or kind != "after"
                or quality != "draft" or interaction.state != "open"
                or type(interaction_sequence) is not int
                or interaction_sequence != interaction.latest_sequence
                or interaction_sequence != interaction.applied_sequence or interaction.pending is not None
                or photo.applied_revision != interaction.baseline_revision
                or photo.requested_revision != photo.applied_revision):
            raise LightCraftError("raw_curve_interaction_stale")
        if mode not in ('whole', 'crop-edit') or mode == 'crop-edit' and (kind != 'after' or quality is None):
            raise LightCraftError('raw_invalid_preview_request')
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
            ticket.interaction_id = interaction_id
            ticket.interaction_sequence = interaction_sequence
            self._pending = ticket
        ticket.mode = mode
        ticket.quality, ticket.adaptive = quality or "full", quality is not None
        ticket.serial, ticket.view_generation, ticket.geometry_id = serial, view_generation, geometry_id
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._previews(), name="lightcraft-preview-worker")
        return ticket

    def region_identity(self, handle, kind='after', *, document_token=None):
        photo = self._photo(handle, active=True)
        # Native Hash128 is 32 hex digits; C0 owns an opaque 64-hex source identity.
        source_id = hashlib.sha256(b'genzoroom-region-source-v1\0' + photo.content_hash.lower().encode('ascii')).hexdigest()
        identity = {'assetId':handle.source_key, 'sourceId':source_id, 'generation':handle.generation,
                    'documentToken':handle.document_token if document_token is None else document_token, 'kind':kind}
        if kind == 'before':
            identity['beforeKey'] = self.before_key(handle)
        else:
            identity['revision'] = photo.applied_revision
        return identity

    def request_region(self, handle, target, *, operation='render', document_token=None):
        """Use the existing owner/worker; the HTTP owner attests its public token explicitly."""
        from raw_region import validate_target
        validate_target(target, operation)
        self._ensure_curve_interaction_owner()
        photo = self._photo(handle, active=True)
        # A future HTTP owner may attest its public document token; RawHandle still owns native lifetime.
        if target['identity'] != self.region_identity(handle, target['identity']['kind'], document_token=document_token) \
                or target['documentRevision'] != photo.applied_revision or photo.requested_revision != photo.applied_revision:
            raise LightCraftError('raw_revision_conflict')
        snapshot = json.loads(_object_json(target, 4096))
        self._sequence += 1
        self._discard_pending()
        if self._before_pending is not None:
            self._before_pending._finish()
            self._before_pending = None
        # Queue ownership is After-like latest-wins, independently of the target's image kind.
        ticket = PreviewTicket(handle, self._epoch, photo.applied_revision, self._sequence, MAX_PREVIEW_SIDE)
        ticket.region_operation, ticket.region_target = operation, snapshot
        ticket.region_document_token = document_token
        ticket.quality = snapshot['quality']
        ticket.view_generation = snapshot['viewGeneration']
        self._pending = ticket
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._previews(), name='lightcraft-preview-worker')
        return ticket

    def _ticket_current(self, ticket):
        try:
            photo = self._photo(ticket.handle, active=True)
            if ticket.interaction_id is not None:
                interaction = self._ensure_curve_interaction_owner(ticket.interaction_id)
                return interaction is not None and interaction.handle == ticket.handle and \
                    interaction.state == "open" and ticket.interaction_sequence == interaction.latest_sequence == \
                    interaction.applied_sequence and interaction.pending is None and not ticket.abandoned and \
                    ticket.epoch == self._epoch and ticket.sequence == self._sequence and \
                    ticket.revision == photo.applied_revision == photo.requested_revision == interaction.baseline_revision
            if ticket.region_operation is not None:
                return not ticket.abandoned and ticket.epoch == self._epoch and ticket.sequence == self._sequence \
                    and ticket.revision == photo.applied_revision == photo.requested_revision \
                    and ticket.region_target['identity'] == self.region_identity(ticket.handle, ticket.region_target['identity']['kind'],
                                                                                document_token=ticket.region_document_token)
            if ticket.kind == "before":
                key = self.before_key(ticket.handle, ticket.max_side)
                if ticket.adaptive and key is not None:
                    key = hashlib.sha256(f"{key}:{ticket.quality}".encode()).hexdigest()
                return not ticket.abandoned and ticket.epoch == self._epoch and ticket.key == key
            return not ticket.abandoned and ticket.epoch == self._epoch and ticket.sequence == self._sequence and \
                ticket.revision == photo.applied_revision == photo.requested_revision
        except LightCraftError:
            return False

    async def _image(self, result, photo_id, max_side, kind="after", before_fingerprint=None, geometry=None, quality=None, *, _validation_job=None):
        args = (quality,) if quality is not None else ()
        function, parameters = _validation_job or (_validate_png, (result, photo_id, max_side, kind, before_fingerprint, geometry, *args))
        _, future = _thread_job(function, *parameters)
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
                        crop_expected = None
                        if getattr(ticket, 'mode', 'whole') == 'crop-edit':
                            from raw_white_balance import result_fingerprint
                            native = await self.manager._raw_native_settings(self._generation, photo.photo_id, timeout=self._timeouts.preview)
                            if _settings_json(native['structuredContent']) != photo.settings_json:
                                raise LightCraftError('raw_revision_conflict')
                            fingerprint = result_fingerprint(native)
                            request_id = uuid.uuid4().hex
                            args['crop_edit'] = {'settings_fingerprint':fingerprint, 'request_id':request_id}
                            crop_expected = {'requestId':request_id,'settingsFingerprint':fingerprint,
                                             'canonicalGeometry':self._before_geometry(photo)}
                        native_started = monotonic()
                        try:
                            if ticket.region_operation is not None:
                                result = await self.manager._raw_region(self._generation, photo.photo_id,
                                    ticket.region_operation, ticket.region_target, timeout=self._timeouts.preview,
                                    stage_cache=self._stage_mode, stage_cache_budget_bytes=self._stage_budget)
                            else:
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
                    if ticket.region_operation is not None:
                        from raw_region import validate_result
                        fingerprint = photo.before_fingerprint if ticket.region_target['identity']['kind'] == 'before' else None
                        data, metadata = await self._image(result, photo.photo_id, ticket.max_side,
                            _validation_job=(validate_result, (result,ticket.region_target,ticket.region_operation,photo.photo_id,fingerprint)))
                        del result
                        diagnostics = metadata['diagnostics']
                        if ticket.region_operation == 'render' and (diagnostics['stageCache']['mode'] != self._stage_mode
                                or self._stage_mode == 'on' and diagnostics['stageCache']['budgetBytes'] != self._stage_budget):
                            raise LightCraftError('raw_invalid_region_response')
                        t = ticket.region_target
                        lightcraft_log('region.completed', level='debug', operation=ticket.region_operation, generation=self._generation,
                            revision=ticket.revision, quality=t['quality'], kind=t['identity']['kind'], geometryId=t['geometryId'],
                            fullWidth=metadata['response']['fullWidth'], fullHeight=metadata['response']['fullHeight'],
                            window=t.get('window'), validRegion=t.get('validRegion'), requestId=t['requestId'],
                            nativeMs=native_ms, validationMs=(monotonic()-validation_started)*1000,
                            renderMs=diagnostics['nativeMs'], workWindow=diagnostics.get('workWindow'),
                            sourceLevel=diagnostics['sourceLevel'], sourceHostBytes=diagnostics['sourceHostBytes'],
                            sourceCacheBytes=diagnostics['sourceCacheBytes'], payloadBytes=len(data),
                            execution=diagnostics.get('execution'),stageCache=diagnostics.get('stageCache'))
                        if diagnostics.get('execution',{}).get('outcome') == 'cpu_fallback':
                            lightcraft_log('region.gpuFallback', level='warn', generation=self._generation,
                                revision=ticket.revision, requestId=t['requestId'], execution=diagnostics['execution'])
                        if self._ticket_current(ticket):
                            ticket._finish(RegionResult(ticket.handle, data, json.dumps(metadata)))
                        else:
                            ticket._finish()
                        del data, metadata
                        continue
                    if crop_expected is not None:
                        image = await self._image(result, photo.photo_id, ticket.max_side,
                            _validation_job=(_validate_crop_png, (result,photo.photo_id,ticket.max_side,ticket.quality,crop_expected)))
                    else:
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
                        trialIndex=self._preview_trials, configuredBackend=self.manager._gpu_backend, maxSide=ticket.max_side,
                        execution=metadata.get("execution") if metadata else None,
                        pngSha256=digest,
                        nativeMs=native_ms, validationMs=validation_ms,
                        width=w, height=h, payloadBytes=len(data), stageCache=metadata["stageCache"] if metadata else None)
                    if metadata and metadata.get("execution", {}).get("outcome") == "cpu_fallback":
                        lightcraft_log("preview.gpuFallback", level="warn", generation=self._generation,
                            revision=ticket.revision, sequence=ticket.sequence, configuredBackend=self.manager._gpu_backend,
                            execution=metadata["execution"])
                    if self._ticket_current(ticket):
                        frame = PreviewFrame(ticket.handle, ticket.revision, ticket.epoch,
                                             ticket.sequence, w, h, data, kind=ticket.kind, key=ticket.key,
                                             quality=ticket.quality,
                                             _crop_json=json.dumps({k:metadata[k] for k in ('canonicalGeometry','bitmapSpace')}) if crop_expected else None,
                                             _frame_json=json.dumps(metadata["frame"]) if metadata else None,
                                             _metrics_json=json.dumps({"nativeMs": native_ms,
                                                 "validationMs": validation_ms,
                                                 "pngSha256": digest, "stageCache": metadata["stageCache"],
                                                 **({"execution": metadata["execution"]} if "execution" in metadata else {})})
                                                 if self._diagnostics and metadata else None,
                                             interaction_id=ticket.interaction_id,
                                             interaction_sequence=ticket.interaction_sequence)
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
                    if ticket.region_operation is not None:
                        fatal = isinstance(error,MCPTransportError) and error.code != 'lightcraft_busy_timeout'
                        target = ticket.region_target
                        native_reply = not isinstance(error, MCPTransportError)
                        stage = 'native_tool' if isinstance(error, MCPToolError) else 'native_validation'
                        if error.code == 'raw_region_geometry_mismatch':
                            reason = (error.diagnostic_reason or 'native_tool_rejected') if isinstance(error, MCPToolError) \
                                else 'response_validation_failed'
                            context = dict(stage=stage, reason=reason, operation=ticket.region_operation,
                                revision=ticket.revision, quality=target['quality'], kind=target['identity']['kind'],
                                viewGeneration=target['viewGeneration'], requestId=target['requestId'],
                                nativeResponseReceived=native_reply, publicGeometryMappingMatch=True, errorCode=error.code)
                            mismatch_fields = {
                                'geometry_id_mismatch': ['geometryId'],
                                'native_full_width_mismatch': ['fullWidth'],
                                'native_full_height_mismatch': ['fullHeight'],
                                'full_width_mismatch': ['fullWidth'], 'full_height_mismatch': ['fullHeight'],
                                'render_contract_mismatch': ['quality', 'window'],
                                'render_width_mismatch': ['width'], 'render_height_mismatch': ['height'],
                            }.get(reason)
                            if mismatch_fields:
                                context['mismatchFields'] = mismatch_fields
                            if reason == 'geometry_id_mismatch':
                                context.update(geometryMatches=False, mismatchSide='native_plan_response')
                            elif reason in ('native_full_width_mismatch', 'native_full_height_mismatch',
                                    'full_width_mismatch', 'full_height_mismatch', 'render_width_mismatch', 'render_height_mismatch'):
                                context['mismatchSide'] = 'native_plan_or_render_response'
                            if 'desiredLongEdge' in target:
                                context['desiredLongEdge'] = target['desiredLongEdge']
                            lightcraft_log('region.geometryMismatch', level='warn', **context)
                        lightcraft_log('region.failed' if fatal else 'region.rejected', level='error' if fatal else 'warn', generation=self._generation,
                            operation=ticket.region_operation, revision=ticket.revision, errorCode=error.code)
                    if (isinstance(error, MCPTransportError) and error.code != "lightcraft_busy_timeout") or \
                            (ticket.kind == "after" and ticket.interaction_id is None and
                             error.code in ("lightcraft_invalid_preview", "lightcraft_preview_validation_timeout")):
                        self.manager._abort_raw(ticket.handle.generation, error.code)
                        self._lost = True
                        self._discard_pending("raw_session_lost")
                    ticket._finish(error=error.code)
                except Exception:
                    if ticket.kind == "after" and ticket.interaction_id is None:
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
            if ticket.interaction_id is None:
                photo.sync = "desynchronized"
            raise
        if ticket.interaction_id is not None:
            # This readback describes temporary Native working state at the durable baseline revision.
            from raw_controls import curve_readback
            interaction = self._ensure_curve_interaction_owner(ticket.interaction_id)
            if interaction is not None and interaction.state == "open" and \
                    ticket.interaction_sequence == interaction.latest_sequence == interaction.applied_sequence:
                try:
                    curve_readback(json.loads(settings))
                except LightCraftError:
                    interaction.state = "failed"
                    self._desynchronized = True
                    raise
                interaction.working_settings_json = settings
            else:
                ticket.abandoned, ticket.reason = True, "curve_sequence"
            return
        if settings != photo.settings_json:
            self._commit(photo, settings)
            ticket.abandoned, ticket.reason = True, "revision"

    async def _join_operations(self):
        tasks = [t for t in self._operations if not t.done()]
        if self._worker is not None and not self._worker.done():
            tasks.append(self._worker)
        interaction = self._curve_interaction
        if interaction is not None:
            self._fail_curve_pending(interaction, "raw_session_lost")
            if interaction.update_task is not None and not interaction.update_task.done():
                tasks.append(interaction.update_task)
        for task in tasks:
            task.cancel()
        for task in tasks:
            await _await_task_resilient(task)
        self._curve_interaction = None

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
