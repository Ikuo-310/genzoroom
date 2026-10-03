import asyncio
import json
import math
from uuid import UUID

import httpx
import pytest

from backend_logging import BackendLogger
from immich import get_immich_about, get_asset_thumbnail, get_asset_preview, check_immich_status
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
    entries = [entry for entry in report_entries if entry["component"] == "stack_write"]
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


@pytest.mark.parametrize("verify,code", [(httpx.ConnectError("PRIVATE_ERROR"), "unreachable"),
    (httpx.Response(403), "authentication_failed"), (httpx.Response(200, json={}), "unexpected_response")])
def test_verify_failure_does_not_reverse_successful_post(logger, verify, code):
    result, calls = run_create(logger, verify)
    assert result.status == "success" and len(calls) == 3
    entry = next(entry for entry in logger.get_entries() if entry["event"] == "verify.failed")
    assert entry["context"]["errorCode"] == code
    assert logger.get_entries()[-1]["context"]["status"] == "success"


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
