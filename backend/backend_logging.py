"""Opt-in structured diagnostics, intentionally independent of stdlib logging."""

from collections import deque
from datetime import datetime, timezone
import json
import math
import re
from threading import Lock
from typing import Literal

LogLevel = Literal["off", "error", "warn", "info", "debug"]
LogEntryLevel = Literal["error", "warn", "info", "debug"]
DEFAULT_BACKEND_LOG_LEVEL: LogLevel = "off"
BACKEND_LOG_CAPACITY = 1000
MAX_LOG_CONTEXT_BYTES = 4096
_PRIORITIES = {"off": 0, "error": 1, "warn": 2, "info": 3, "debug": 4}
_IDENTIFIER = re.compile(r"[a-zA-Z][a-zA-Z0-9_.-]{0,95}")
_PRIVATE_KEY = re.compile(
    r"apikey|cookie|authorization|token|password|secret|credential|recipe|history|clipboard|binary|pixels|payload"
)


def _utc_timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Timestamp must be timezone-aware")
    # UTC is canonical storage; display locale and future frontend merging stay independent.
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _valid_identifiers(component: object, event: object) -> bool:
    return all(type(value) is str and _IDENTIFIER.fullmatch(value) for value in (component, event))


def _copy_context(context: object) -> dict | None:
    # Only caller-selected technical metadata belongs here. No automatic collection or
    # arbitrary-text redaction: callers must keep user content, URLs and secrets out.
    remaining = 64

    def copy(value: object, depth: int):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 3:
            raise ValueError("Context too large")
        if value is None or type(value) is bool:
            return value
        if type(value) in (int, float):
            if not math.isfinite(value):
                raise ValueError("Invalid number")
            return value
        if type(value) is str and len(value) <= 256:
            return value
        if type(value) is list:
            return [copy(item, depth + 1) for item in value]
        if type(value) is dict:
            result = {}
            for key, item in value.items():
                if type(key) is not str or len(key) > 64 or _PRIVATE_KEY.search(re.sub(r"[^a-z0-9]", "", key.lower())):
                    raise ValueError("Unsafe context key")
                result[key] = copy(item, depth + 1)
            return result
        raise ValueError("Invalid context value")

    if type(context) is not dict:
        return None
    try:
        result = copy(context, 0)
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        return result if len(encoded) <= MAX_LOG_CONTEXT_BYTES else None
    except (ValueError, TypeError, OverflowError, RuntimeError):
        # Unsafe or concurrently mutated contexts must not interrupt application work.
        return None


def _entry_fields(*, level: object, component: object, event: object, message: object, context: object) -> dict:
    if type(level) is not str or level not in _PRIORITIES or level == "off" or not _valid_identifiers(component, event):
        raise ValueError("Invalid log entry")
    result = {"source": "backend", "level": level, "component": component, "event": event}
    if type(message) is str and len(message) <= 512:
        result["message"] = message
    safe_context = _copy_context(context)
    if safe_context is not None:
        result["context"] = safe_context
    return result


def create_backend_logs_report(entries: list[dict], date: datetime | None = None) -> dict:
    projected = []
    for entry in entries:
        timestamp = entry.get("timestamp")
        if entry.get("source") != "backend" or type(timestamp) is not str or not timestamp.endswith("Z"):
            raise ValueError("Invalid log entry")
        timestamp = _utc_timestamp(datetime.fromisoformat(timestamp[:-1] + "+00:00"))
        # Re-project known fields so unexpected properties cannot escape through reports.
        projected.append({"timestamp": timestamp, **_entry_fields(
            level=entry.get("level"), component=entry.get("component"), event=entry.get("event"),
            message=entry.get("message"), context=entry.get("context"),
        )})
    return {"schemaVersion": 1, "generatedAt": _utc_timestamp(date if date is not None else datetime.now(timezone.utc)),
            "source": "backend", "entries": projected}


class BackendLogger:
    def __init__(self):
        self._level: LogLevel = DEFAULT_BACKEND_LOG_LEVEL
        # One lock protects ordering, filtering and snapshots across async/threadpool callers.
        # The bounded deque keeps the newest diagnostic session without unbounded growth.
        self._lock = Lock()
        self._entries: deque[dict] = deque(maxlen=BACKEND_LOG_CAPACITY)

    def get_level(self) -> LogLevel:
        with self._lock:
            return self._level

    def set_level(self, level: LogLevel) -> LogLevel:
        if type(level) is not str or level not in _PRIORITIES:
            raise ValueError("Invalid log level")
        with self._lock:
            self._level = level
            return self._level

    def add(self, *, level: LogEntryLevel, component: str, event: str,
            message: str | None = None, context: dict | None = None) -> None:
        with self._lock:
            if type(level) is not str or level not in _PRIORITIES or level == "off" or self._level == "off":
                return
            if _PRIORITIES[level] > _PRIORITIES[self._level]:
                return
            try:
                fields = _entry_fields(level=level, component=component, event=event, message=message, context=context)
            except ValueError:
                return
            self._entries.append({"timestamp": _utc_timestamp(datetime.now(timezone.utc)), **fields})

    def get_entries(self) -> list[dict]:
        with self._lock:
            return create_backend_logs_report(list(self._entries))["entries"]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def create_report(self) -> dict:
        with self._lock:
            return create_backend_logs_report(list(self._entries))


# Never attach handlers to root/Uvicorn/httpx: they may contain private request data.
backend_logger = BackendLogger()
