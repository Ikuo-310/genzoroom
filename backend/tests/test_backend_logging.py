from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import logging

import pytest

from backend_logging import BACKEND_LOG_CAPACITY, BackendLogger, create_backend_logs_report


def add(logger, **values):
    logger.add(**{"level": "info", "component": "stack_write", "event": "operation.response", **values})


@pytest.mark.parametrize("level,count", [("off", 0), ("error", 1), ("warn", 2), ("info", 3), ("debug", 4)])
def test_default_and_filters(level, count):
    logger = BackendLogger()
    assert logger.get_level() == "off"
    add(logger, level="error")
    assert logger.get_entries() == []
    assert logger.set_level(level) == level
    assert logger.get_level() == level
    levels = ["error", "warn", "info", "debug"]
    for entry_level in levels:
        add(logger, level=entry_level)
    assert [entry["level"] for entry in logger.get_entries()] == levels[:count]


@pytest.mark.parametrize("level", ["WARNING", "invalid", "", None, [], 1])
def test_invalid_level(level):
    logger = BackendLogger()
    with pytest.raises(ValueError):
        logger.set_level(level)
    assert logger.get_level() == "off"
    logger.set_level("debug")
    add(logger, level=level)
    assert logger.get_entries() == []


def test_entry_and_report_schema_snapshots():
    logger = BackendLogger()
    logger.set_level("debug")
    context = {"operationId": "draft:manual:17", "httpStatus": 201, "nested": {"flags": [True, None]}}
    add(logger, level="warn", context=context)
    context["nested"]["flags"].append(False)
    entries = logger.get_entries()
    entry = entries[0]
    assert set(entry) == {"timestamp", "source", "level", "component", "event", "context"}
    assert entry["source"] == "backend" and entry["level"] == "warn"
    assert entry["timestamp"].endswith("Z")
    assert datetime.fromisoformat(entry["timestamp"]).utcoffset() == timedelta(0)
    entry["extra"] = "PRIVATE_EXTRA"
    entry["context"]["nested"]["flags"].append(False)
    report = create_backend_logs_report(entries, datetime(2026, 10, 4, 1, tzinfo=timezone(timedelta(hours=9))))
    assert set(report) == {"schemaVersion", "generatedAt", "source", "entries"}
    assert report["schemaVersion"] == 1 and report["source"] == "backend"
    assert report["generatedAt"] == "2026-10-03T16:00:00.000Z"
    assert report["entries"][0]["timestamp"] == entry["timestamp"]
    assert "PRIVATE_EXTRA" not in json.dumps(report)
    report["entries"][0]["context"]["nested"]["flags"].clear()
    entries.clear()
    assert logger.get_entries()[0]["context"]["nested"]["flags"] == [True, None]
    report = logger.create_report()
    report["entries"][0]["event"] = "changed"
    assert logger.get_entries()[0]["event"] == "operation.response"
    assert report["generatedAt"].endswith("Z")


@pytest.mark.parametrize("field,value", [("component", "translated component"), ("event", ""),
    ("event", "x" * 97), ("component", None), ("event", "event\n"), ("event", "翻訳")])
def test_identifier_validation(field, value):
    logger = BackendLogger()
    logger.set_level("debug")
    add(logger, **{field: value})
    assert logger.get_entries() == []


def test_message_limit_and_ring_clear():
    logger = BackendLogger()
    logger.set_level("info")
    for index in range(BACKEND_LOG_CAPACITY):
        add(logger, context={"index": index})
    assert len(logger.get_entries()) == BACKEND_LOG_CAPACITY
    add(logger, message="x" * 512, context={"index": BACKEND_LOG_CAPACITY})
    entries = logger.get_entries()
    assert len(entries) == BACKEND_LOG_CAPACITY
    assert [entry["context"]["index"] for entry in entries] == list(range(1, BACKEND_LOG_CAPACITY + 1))
    assert entries[-1]["message"] == "x" * 512
    assert logger.create_report()["buffer"] == {"capacity": 5000, "droppedEntryCount": 1}
    add(logger, message="x" * 513)
    assert "message" not in logger.get_entries()[-1]
    logger.set_level("off")
    assert len(logger.get_entries()) == BACKEND_LOG_CAPACITY
    logger.clear()
    assert logger.get_entries() == [] and logger.get_level() == "off"
    assert logger.create_report()["buffer"]["droppedEntryCount"] == 0
    logger.set_level("debug")
    add(logger)
    assert len(logger.get_entries()) == 1
    assert BackendLogger().get_level() == "off"


@pytest.mark.parametrize("key", ["apiKey", "api_key", "IMMICH_API_KEY", "Cookie", "Authorization", "accessToken",
    "refreshToken", "sessionToken", "authToken", "password", "secret", "credential", "urlCredential",
    "Recipe", "History", "Clipboard", "photoBinary", "pixels", "payload", "binaryPayload", "pixelBuffer",
    "requestHeaders", "responseHeaders", "requestBody", "responseBody", "fullUrl", "queryString"])
def test_private_context_keys_also_rejected_during_report_projection(key):
    logger = BackendLogger()
    logger.set_level("debug")
    add(logger, context={"count": 1, "nested": {key: "PRIVATE_FIXTURE"}})
    entry = logger.get_entries()[0]
    assert entry["context"] == {"count": 1, "nested": {}}
    entry["context"] = {key: "PRIVATE_FIXTURE"}
    assert "PRIVATE_FIXTURE" not in json.dumps(create_backend_logs_report([entry]))


def test_safe_metadata_survives_pruning_and_report():
    safe = {"assetId": "asset-1", "stackId": "stack-1", "memberIds": ["asset-1", "asset-2"], "operationId": "draft:17",
        "requestId": "request-1", "generationId": 2, "saveId": "save-1", "tokenCount": 3, "recipeVersion": 1,
        "historyCursor": 0, "historyLength": 2, "payloadBytes": 512, "pixelCount": 64, "durationMs": 12.3,
        "errorCode": "unreachable", "exceptionType": "ReadTimeout", "endpoint": "/stacks", "httpStatus": 201,
        "state": "completed", "phase": "apply", "attempt": 1, "aborted": False, "stale": True, "processingVersion": 1}
    logger = BackendLogger()
    logger.set_level("debug")
    add(logger, message="Request completed", context={**safe, "authorization": "PRIVATE", "nested": {"status": "ok", "api_key": "PRIVATE"}})
    expected = {**safe, "nested": {"status": "ok"}}
    assert logger.get_entries()[0]["context"] == expected
    report = logger.create_report()
    assert report["entries"][0]["message"] == "Request completed"
    assert report["entries"][0]["context"] == expected
    assert "PRIVATE" not in json.dumps(report)


def test_utf16_string_and_message_limits_match_frontend():
    logger = BackendLogger()
    logger.set_level("debug")
    add(logger, message="😀" * 256, context={"value": "😀" * 128})
    assert logger.get_entries()[0]["message"] == "😀" * 256
    assert logger.get_entries()[0]["context"] == {"value": "😀" * 128}
    add(logger, message="😀" * 257, context={"value": "😀" * 129})
    assert "message" not in logger.get_entries()[1] and "context" not in logger.get_entries()[1]


def test_unsafe_contexts_are_omitted_without_losing_entry():
    cyclic = {}
    cyclic["self"] = cyclic
    class Arbitrary:
        pass
    contexts = [{"data": b"bytes"}, {"data": bytearray(2)}, {"data": Arbitrary()},
        {"number": float("nan")}, {"number": float("inf")}, {"number": -float("inf")},
        {"text": "x" * 257}, {"nested": {"a": {"b": {"c": 1}}}},
        {str(index): index for index in range(64)}, {"x" * 65: 1}, {1: "value"},
        {str(index): "x" * 256 for index in range(30)},
        {str(index): "あ" * 256 for index in range(6)}, cyclic, {"n": 10 ** 1000}, [], None]
    logger = BackendLogger()
    logger.set_level("debug")
    for context in contexts:
        add(logger, context=context)
    entries = logger.get_entries()
    assert len(entries) == len(contexts)
    assert all("context" not in entry for entry in entries)


@pytest.mark.parametrize("field,value", [("source", "frontend"), ("timestamp", "2026-10-04T01:00:00+09:00"),
    ("timestamp", "invalidZ"), ("level", "off"), ("event", "invalid event")])
def test_report_revalidates_entry(field, value):
    logger = BackendLogger()
    logger.set_level("info")
    add(logger)
    entry = logger.get_entries()[0]
    entry[field] = value
    with pytest.raises(ValueError):
        create_backend_logs_report([entry])


def test_concurrent_add_read_level_and_clear_are_safe():
    logger = BackendLogger()
    logger.set_level("debug")
    def write(worker):
        for index in range(150):
            add(logger, context={"worker": worker, "index": index})
            if index % 25 == 0:
                logger.get_entries()
                logger.create_report()
                logger.set_level("debug")
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(write, range(8)))
    entries = logger.get_entries()
    assert len(entries) == 8 * 150
    assert len({(entry["context"]["worker"], entry["context"]["index"]) for entry in entries}) == 8 * 150
    assert [entry["timestamp"] for entry in entries] == sorted(entry["timestamp"] for entry in entries)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(lambda _: (logger.clear(), add(logger), logger.create_report()), range(20)))
    logger.clear()
    assert logger.get_entries() == []


def test_stdlib_logging_is_not_captured():
    root = logging.getLogger()
    original_handlers, original_level = root.handlers[:], root.level
    logger = BackendLogger()
    logger.set_level("debug")
    logging.getLogger("httpx").warning("PRIVATE_STDLIB_FIXTURE")
    assert logger.get_entries() == []
    assert root.handlers == original_handlers and root.level == original_level
