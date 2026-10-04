import asyncio
import json
import math
from uuid import UUID

import httpx
import pytest

from backend_logging import BackendLogger
from immich import get_immich_about, get_asset_thumbnail, get_asset_preview, get_asset_detail, check_immich_status
from stack_write import StackApplyRequest, apply_stacks

A, B, NEW = [str(UUID(int=value)) for value in (1, 2, 100)]
PRIVATE_URL = "http://PRIVATE_HOST:2283/api"
PRIVATE_KEY = "PRIVATE_API_KEY"


@pytest.fixture
def logger(monkeypatch):
    logger = BackendLogger()
    monkeypatch.setattr("immich.backend_logger", logger)
    monkeypatch.setattr("stack_write.backend_logger", logger)
    return logger


def test_off_and_debug_communication_privacy_and_correlation(logger):
    def handler(request):
        assert request.headers["x-api-key"] == PRIVATE_KEY
        return httpx.Response(200, json={"version": "v3", "unused": "PRIVATE_BODY"}, headers={"Authorization": "PRIVATE_RESPONSE"})
    for level in ["off", "debug"]:
        logger.set_level(level)
        result = asyncio.run(get_immich_about(PRIVATE_URL, PRIVATE_KEY, transport=httpx.MockTransport(handler)))
        assert result.version == "v3"
        entries = logger.get_entries()
        if level == "off":
            assert entries == []
            continue
        assert [entry["event"] for entry in entries] == ["request.start", "request.response"]
        start, response = [entry["context"] for entry in entries]
        assert start["requestId"] == response["requestId"]
        assert start["method"] == response["method"] == "GET"
        assert start["endpoint"] == response["endpoint"] == "/server/about"
        assert response["httpStatus"] == 200 and response["success"] is True
        assert math.isfinite(response["durationMs"]) and response["durationMs"] >= 0
        text = json.dumps(logger.create_report())
        for forbidden in ["PRIVATE", "headers", "body", "x-api-key", "http://", "Authorization"]:
            assert forbidden not in text


@pytest.mark.parametrize("outcome,code", [(401, "authentication_failed"), (500, "unexpected_response"),
    ("timeout", "unreachable"), ("malformed", "unexpected_response")])
def test_failure_classification_is_safe(logger, outcome, code):
    logger.set_level("debug")
    def handler(request):
        if outcome == "timeout":
            raise httpx.ReadTimeout("PRIVATE_EXCEPTION", request=request)
        if outcome == "malformed":
            return httpx.Response(200, json={"unused": "PRIVATE_BODY"})
        return httpx.Response(outcome, json={"message": "PRIVATE_BODY"})
    result = asyncio.run(get_immich_about(PRIVATE_URL, PRIVATE_KEY, transport=httpx.MockTransport(handler)))
    assert result.error_code == code
    entries = logger.get_entries()
    failed = [entry for entry in entries if entry["event"] == "request.failed"]
    assert len(failed) == 1
    context = failed[0]["context"]
    assert context["errorCode"] == code
    assert context["requestId"] == entries[0]["context"]["requestId"]
    assert math.isfinite(context["durationMs"]) and context["durationMs"] >= 0
    assert "PRIVATE" not in json.dumps(logger.create_report())


@pytest.mark.parametrize("fetch", [get_asset_thumbnail, get_asset_preview])
def test_image_contents_not_logged(logger, fetch):
    logger.set_level("debug")
    result = asyncio.run(fetch(PRIVATE_URL, PRIVATE_KEY, UUID(A), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"PRIVATE_PIXELS", headers={"content-type": "image/jpeg"}))))
    assert result.content == b"PRIVATE_PIXELS"
    assert logger.get_entries()[0]["context"]["endpoint"] == f"/assets/{A}/thumbnail"
    assert "PRIVATE" not in json.dumps(logger.create_report())


def test_asset_detail_observation_logs_sorted_schema_and_presence_only(logger):
    logger.set_level("debug")
    body = {
        "id": A, "type": "IMAGE", "originalFileName": "PRIVATE_FILENAME.DNG",
        "originalPath": "PRIVATE_PATH", "fileCreatedAt": "2026-09-01T12:00:00Z",
        "visibility": "archive", "deletedAt": None, "stackId": None, "thumbhash": None,
        "exifInfo": {"model": "PRIVATE_MODEL", "iso": 200, "dateTimeOriginal": "PRIVATE_DATE"},
        "unneeded": "PRIVATE_RAW_BODY",
    }
    detail = asyncio.run(get_asset_detail(PRIVATE_URL, PRIVATE_KEY, UUID(A), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=body))))
    assert detail.format == "DNG" and detail.is_raw is True
    observations = [entry for entry in logger.get_entries() if entry["component"] == "immich.asset"]
    assert len(observations) == 1 and observations[0]["event"] == "detail.observed"
    context = observations[0]["context"]
    assert context["assetId"] == A and context["type"] == "IMAGE" and context["visibility"] == "archive"
    assert context["hasExifInfo"] is True and context["exifInfoPresent"] is True
    assert context["exifInfoFieldCount"] == 3
    assert context["exifInfoKeys"] == ["dateTimeOriginal", "iso", "model"]
    assert context["topLevelKeys"] == sorted(body)
    assert context["deletedAtPresent"] is True and context["trashedAtPresent"] is False
    assert context["stackIdPresent"] is True and context["thumbhashPresent"] is True
    assert context["format"] == "DNG" and context["isRaw"] is True
    assert len(json.dumps(context, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 4096
    report = json.dumps(logger.create_report())
    for private_value in ["PRIVATE_FILENAME", "PRIVATE_PATH", "PRIVATE_MODEL", "PRIVATE_DATE", "PRIVATE_RAW_BODY", PRIVATE_KEY, "PRIVATE_HOST"]:
        assert private_value not in report


@pytest.mark.parametrize("level", ["off", "error", "warn", "info"])
def test_asset_detail_observation_is_debug_only(logger, level):
    logger.set_level(level)
    body = {"id": A, "type": "IMAGE", "originalFileName": "sample.dng", "fileCreatedAt": "2026-09-01T12:00:00Z"}
    detail = asyncio.run(get_asset_detail(PRIVATE_URL, PRIVATE_KEY, UUID(A), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=body))))
    assert detail.format == "DNG" and detail.is_raw is True
    assert not any(entry["event"] == "detail.observed" for entry in logger.get_entries())


def test_malformed_optional_asset_metadata_and_observation_failure_do_not_break_detail(logger, monkeypatch):
    logger.set_level("debug")
    body = {"id": A, "type": "IMAGE", "originalFileName": "sample.dng", "fileCreatedAt": "2026-09-01T12:00:00Z",
            "visibility": {"unexpected": True}, "exifInfo": ["malformed"], "deletedAt": object()}
    detail = asyncio.run(get_asset_detail(PRIVATE_URL, PRIVATE_KEY, UUID(A), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={key: value for key, value in body.items() if key != "deletedAt"}))))
    assert detail.format == "DNG" and detail.exif.model_dump(exclude_none=True) == {}
    observation = next(entry for entry in logger.get_entries() if entry["event"] == "detail.observed")
    assert observation["context"]["hasExifInfo"] is False and observation["context"]["visibility"] is None
    original_add = logger.add
    def failing_observation(*, level, component, event, message=None, context=None):
        if component == "immich.asset": raise RuntimeError("diagnostics unavailable")
        return original_add(level=level, component=component, event=event, message=message, context=context)
    monkeypatch.setattr(logger, "add", failing_observation)
    detail = asyncio.run(get_asset_detail(PRIVATE_URL, PRIVATE_KEY, UUID(A), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={key: value for key, value in body.items() if key != "deletedAt"}))))
    assert detail.format == "DNG"


def test_status_malformed_json_is_classified(logger):
    logger.set_level("debug")
    result = asyncio.run(check_immich_status(PRIVATE_URL, PRIVATE_KEY, transport=httpx.MockTransport(
        lambda request: httpx.Response(200, text="PRIVATE_BAD_JSON"))))
    assert result.error_code == "unexpected_response"
    assert logger.get_entries()[-1]["context"]["errorCode"] == "unexpected_response"


def run_create(logger, verify, *, level="debug", post_members=None, members=None):
    logger.set_level(level)
    calls = []
    requested = members or [A, B]
    body = {"id": NEW, "primaryAssetId": requested[0], "assets": [{"id": value} for value in (post_members or requested)],
            "unneeded": "PRIVATE_RAW_BODY", "exifInfo": {"path": "PRIVATE_PATH"}}
    def handler(request):
        assert request.headers["x-api-key"] == PRIVATE_KEY
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/api/stacks":
            return httpx.Response(200, json=[])
        if request.method == "POST":
            assert json.loads(request.content) == {"assetIds": requested}
            return httpx.Response(201, json=body)
        assert request.method == "GET" and request.url.path == f"/api/stacks/{NEW}"
        if isinstance(verify, Exception):
            raise verify
        return verify
    result = asyncio.run(apply_stacks(PRIVATE_URL, PRIVATE_KEY, StackApplyRequest(operations=[{
        "operationId": "draft:manual:17", "type": "create", "memberIds": requested, "primaryAssetId": requested[0],
    }]), transport=httpx.MockTransport(handler)))
    assert "PRIVATE" not in json.dumps(logger.create_report())
    return result.results[0], calls


def stack_response(members, primary=A, stack_id=NEW):
    return httpx.Response(200, json={"id": stack_id, "primaryAssetId": primary,
        "assets": [{"id": member, "filename": "PRIVATE_PHOTO"} for member in members], "private": "PRIVATE_BODY"})


@pytest.mark.parametrize("actual,matches", [([B, A], True), ([A], False), ([A, A], False)])
def test_post_two_members_and_immediate_verify_members_are_distinguishable(logger, actual, matches):
    result, calls = run_create(logger, stack_response(actual))
    assert result.status == "success" and str(result.stackId) == NEW
    assert calls == [("GET", "/api/stacks"), ("POST", "/api/stacks"), ("GET", f"/api/stacks/{NEW}")]
    report_entries = json.loads(json.dumps(logger.create_report()))["entries"]
    entries = [entry for entry in report_entries if entry["component"] == "stack_write" and entry["event"] not in {"batch.start", "batch.result"}]
    start, response, verify, final = [entry["context"] for entry in entries]
    assert start["operationId"] == response["operationId"] == verify["operationId"] == "draft:manual:17"
    assert start["memberIds"] == response["requestedMemberIds"] == verify["expectedMemberIds"] == [A, B]
    assert start["requestedPrimaryAssetId"] == response["requestedPrimaryAssetId"] == A
    assert response["responseMemberIds"] == [A, B] and response["responsePrimaryAssetId"] == A
    assert response["stackId"] == NEW and response["validationResult"] == "matched"
    assert response["requestId"] == start["requestId"]
    assert verify["actualMemberIds"] == actual and verify["matches"] is matches
    assert any(entry["event"] == "request.response" and entry["context"]["endpoint"] == f"/stacks/{NEW}"
               for entry in logger.get_entries())
    verify_request = next(entry for entry in logger.get_entries()
                          if entry["event"] == "request.response" and entry["context"]["endpoint"] == f"/stacks/{NEW}")
    assert verify["requestId"] == verify_request["context"]["requestId"]
    assert entries[2]["level"] == ("debug" if matches else "warn")
    assert final["status"] == "success"
    batch_id = final["batchId"]
    assert all(entry["context"]["batchId"] == batch_id for entry in report_entries)
    assert report_entries[-1]["event"] == "batch.result" and report_entries[-1]["context"]["overallResult"] == "success"


def apply_batch(logger, outcomes, level="info"):
    logger.set_level(level)
    ops = [{"operationId": f"op-{index}", "type": "create", "memberIds": [str(UUID(int=2 * index + 1)), str(UUID(int=2 * index + 2))],
            "primaryAssetId": str(UUID(int=2 * index + 1))} for index in range(len(outcomes))]
    created = {}
    index = 0
    def handler(request):
        nonlocal index
        if request.method == "GET":
            if request.url.path == "/api/stacks":
                if all(outcome == "blocked" for outcome in outcomes):
                    return httpx.Response(200, json=[{"id": str(UUID(int=10000 + position)), "primaryAssetId": op["primaryAssetId"],
                        "assets": [{"id": member} for member in op["memberIds"]]} for position, op in enumerate(ops)])
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=created[request.url.path.split("/")[-1]])
        current = index; index += 1
        if outcomes[current] == "failed": return httpx.Response(403)
        if outcomes[current] == "unknown": raise httpx.ReadTimeout("PRIVATE_ERROR", request=request)
        stack_id = str(UUID(int=10000 + current))
        body = {"id": stack_id, "primaryAssetId": ops[current]["primaryAssetId"], "assets": [{"id": member} for member in ops[current]["memberIds"]]}
        created[stack_id] = body
        return httpx.Response(201, json=body)
    result = asyncio.run(apply_stacks(PRIVATE_URL, PRIVATE_KEY, StackApplyRequest(operations=ops), transport=httpx.MockTransport(handler)))
    return result.results


@pytest.mark.parametrize("outcomes,overall,severity", [(["success", "success"], "success", "info"),
    (["success", "failed"], "partial_failure", "warn"), (["failed", "unknown"], "failure", "error"),
    (["blocked", "blocked"], "failure", "error")])
def test_terminal_operation_and_batch_severities(logger, outcomes, overall, severity):
    results = apply_batch(logger, outcomes)
    assert [result.status for result in results] == outcomes
    entries = json.loads(json.dumps(logger.create_report()))["entries"]
    operations = [entry for entry in entries if entry["event"] == "operation.result"]
    assert [entry["level"] for entry in operations] == [{"success": "info", "failed": "error", "unknown": "error", "blocked": "warn"}[value] for value in outcomes]
    summary = entries[-1]
    assert summary["event"] == "batch.result" and summary["level"] == severity
    assert summary["context"]["overallResult"] == overall
    assert summary["context"]["operationCount"] == 2
    for status in ["success", "failed", "unknown", "blocked"]:
        assert summary["context"][f"{status}Count"] == outcomes.count(status)
    assert all(entry["context"]["batchId"] == summary["context"]["batchId"] for entry in operations)


@pytest.mark.parametrize("outcomes", [["failed"], ["unknown"], ["blocked"]])
def test_error_only_retains_terminal_failure_evidence(logger, outcomes):
    apply_batch(logger, outcomes, "error")
    entries = logger.create_report()["entries"]
    assert entries and all(entry["level"] == "error" for entry in entries)
    assert entries[-1]["event"] == "batch.result" and entries[-1]["context"]["overallResult"] == "failure"
    if outcomes != ["blocked"]:
        assert entries[0]["event"] == "operation.result"


def test_large_batch_reports_dropped_evidence_and_retains_final_outcome(logger):
    results = apply_batch(logger, ["success"] * 500, "debug")
    assert all(result.status == "success" for result in results)
    report = logger.create_report()
    assert 1000 < len(report["entries"]) < 5000
    assert report["buffer"] == {"capacity": 5000, "droppedEntryCount": 0}
    assert report["entries"][-1]["event"] == "batch.result"
    assert report["entries"][-1]["context"]["successCount"] == 500
    assert len([entry for entry in report["entries"] if entry["event"] == "operation.result"]) == 500


@pytest.mark.parametrize("verify,code", [(httpx.ConnectError("PRIVATE_ERROR"), "unreachable"),
    (httpx.Response(403), "authentication_failed"), (httpx.Response(200, json={}), "unexpected_response")])
def test_verify_failure_does_not_reverse_successful_post(logger, verify, code):
    result, calls = run_create(logger, verify)
    assert result.status == "success" and len(calls) == 3
    entry = next(entry for entry in logger.get_entries() if entry["event"] == "verify.failed")
    assert entry["context"]["errorCode"] == code
    assert logger.get_entries()[-1]["context"]["overallResult"] == "success"


@pytest.mark.parametrize("level", ["off", "error", "warn", "info"])
def test_verify_is_skipped_without_debug_and_write_result_is_unchanged(logger, level):
    result, calls = run_create(logger, stack_response([A]), level=level)
    assert result.status == "success" and len(calls) == 2
    assert calls == [("GET", "/api/stacks"), ("POST", "/api/stacks")]
    assert not any(entry["event"] in {"create.verify", "verify.failed"} for entry in logger.get_entries())


def test_post_validation_failure_does_not_verify(logger):
    result, calls = run_create(logger, stack_response([A, B]), post_members=[A])
    assert result.status == "unknown" and result.errorCode == "unexpected_response" and len(calls) == 2
    response = next(entry for entry in logger.get_entries() if entry["event"] == "operation.response")
    assert response["context"]["responseMemberIds"] == [A]
    assert response["context"]["validationResult"] == "mismatch"
    assert not any(entry["event"] == "create.verify" for entry in logger.get_entries())


def test_large_membership_logs_remain_complete_with_bounded_chunks(logger):
    members = [str(UUID(int=index + 1)) for index in range(1000)]
    result, _ = run_create(logger, stack_response(members), members=members)
    assert result.status == "success"
    for event, field in [("operation.start", "memberIds"), ("operation.response", "responseMemberIds"), ("create.verify", "actualMemberIds")]:
        entries = [entry for entry in logger.get_entries() if entry["event"] == event]
        assert len(entries) == 125
        assert all("context" in entry for entry in entries)
        assert [member for entry in entries for member in entry["context"][field]] == members
        assert [entry["context"]["chunkIndex"] for entry in entries] == list(range(125))
