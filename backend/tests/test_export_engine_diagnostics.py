import asyncio
import copy
from io import BytesIO
import json
import threading
from unittest.mock import AsyncMock, Mock, patch
from uuid import UUID

import httpx
from PIL import Image
import pytest

import export_engine_diagnostics as engine
from backend_logging import backend_logger
from jpeg_codec import JpegCodecError
from main import app
from tests.test_jpeg_codec import jpeg
from tests.test_jpeg_renderer import recipe

ASSET = UUID("12345678-1234-4234-9234-123456789abc")
PATH = "/developer/export-engine"
BODY = {"assetId": str(ASSET), "expectedRevision": 3}


class Original:
    def __init__(self, data, fail=False):
        self.data = data
        self.fail = fail
        self.close = AsyncMock()

    async def chunks(self):
        yield self.data[:30]
        if self.fail:
            raise httpx.ReadTimeout("PRIVATE_URL secret-token")
        yield self.data[30:]


@pytest.fixture
def setup(monkeypatch):
    saved = {"revision": 3, "state": {"currentRecipe": recipe(exposure=0.5),
             "history": ["PRIVATE_HISTORY"], "sourceIdentity": {"assetId": str(ASSET)}}}
    store = Mock(return_value=saved)
    original = Original(jpeg(orientation=6))
    fetch = AsyncMock(return_value=original)
    monkeypatch.setattr("main.get_edit_state", store)
    monkeypatch.setattr("main.get_asset_original", fetch)
    writes = []
    for name in ("put_edit_state", "enqueue_export_assets", "dequeue_export_asset", "apply_stacks"):
        write = Mock(side_effect=AssertionError("diagnostics must not write"))
        monkeypatch.setattr(f"main.{name}", write)
        writes.append(write)
    return saved, store, original, fetch, writes


def request(body=BODY):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            return await client.post(PATH, json=body)
    return asyncio.run(run())


def test_reuses_engine_saved_recipe_and_worker_with_private_jpeg_response(setup):
    saved, store, original, fetch, writes = setup
    before = copy.deepcopy(saved)
    event_thread = threading.get_ident()
    decode_threads = []
    renderer = engine.JpegRenderer()

    def decode(data):
        decode_threads.append(threading.get_ident())
        return original_decode(data)

    original_decode = engine.decode_jpeg
    with patch.object(engine, "decode_jpeg", side_effect=decode) as decoded, \
            patch.object(engine.JpegRenderer, "render", wraps=renderer.render) as rendered, \
            patch.object(engine, "encode_jpeg", wraps=engine.encode_jpeg) as encoded:
        response = request()
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "private, no-store"
    metadata = json.loads(response.headers["X-GenzoRoom-Export-Engine"])
    assert metadata["sourceWidth"] == 11 and metadata["sourceHeight"] == 7
    assert metadata["outputWidth"] == 7 and metadata["outputHeight"] == 11
    assert metadata["sourceIcc"] == "absent"
    assert metadata["outputBytes"] == len(response.content)
    assert metadata["outputColorSpace"] == "sRGB"
    assert metadata["recipeVersion"] == 18 and metadata["quality"] == 95 and metadata["subsampling"] == "4:4:4"
    assert all(metadata[key] >= 0 for key in ("decodeMs", "renderMs", "encodeMs", "totalMs"))
    assert metadata["totalMs"] >= sum(metadata[key] for key in ("decodeMs", "renderMs", "encodeMs"))
    assert str(ASSET) not in str(metadata) and "PRIVATE" not in str(metadata)
    store.assert_called_once_with(ASSET)
    decoded.assert_called_once()
    rendered.assert_called_once()
    assert rendered.call_args.args[1] == before["state"]["currentRecipe"]
    encoded.assert_called_once()
    assert decode_threads[0] != event_thread
    original.close.assert_awaited_once()
    for write in writes:
        write.assert_not_called()
    assert saved == before
    with Image.open(BytesIO(response.content)) as output:
        assert output.size == (7, 11) and "icc_profile" in output.info


@pytest.mark.parametrize("body", [{**BODY, "recipe": {"PRIVATE": "secret"}}, {**BODY, "assetId": "PRIVATE_BAD_ID"},
                                  {"assetId": str(ASSET)}, {**BODY, "expectedRevision": True}])
def test_rejects_injected_recipe_and_invalid_request_without_reflecting_input(setup, body):
    response = request(body)
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "invalid_diagnostic_request"}}
    assert response.headers["cache-control"] == "private, no-store"
    setup[1].assert_not_called()
    setup[3].assert_not_awaited()


@pytest.mark.parametrize("kind,code,status", [("missing", "saved_recipe_unavailable", 404),
    ("legacy", "unsupported_recipe_version", 422), ("revision", "saved_recipe_changed", 409),
    ("invalid", "saved_recipe_unavailable", 422)])
def test_missing_unsupported_or_changed_saved_recipe_prevents_fetch(setup, kind, code, status):
    saved, store, _, fetch, _ = setup
    if kind == "missing":
        store.return_value = {"state": None}
    elif kind == "legacy":
        saved["state"]["currentRecipe"]["version"] = 17
    elif kind == "revision":
        saved["revision"] = 4
    else:
        saved["state"]["currentRecipe"]["adjustments"]["exposure"] = float("nan")
    response = request()
    assert response.status_code == status and response.json() == {"detail": {"code": code}}
    fetch.assert_not_awaited()


def test_recipe_is_detached_before_network_fetch(setup):
    saved, _, original, fetch, _ = setup
    before = copy.deepcopy(saved["state"]["currentRecipe"])

    async def changed(*args):
        saved["state"]["currentRecipe"]["adjustments"]["exposure"] = 4
        return original

    fetch.side_effect = changed
    with patch.object(engine.JpegRenderer, "render", wraps=engine.JpegRenderer().render) as render:
        assert request().status_code == 200
        assert render.call_args.args[1] == before


@pytest.mark.parametrize("phase,exception,code", [
    ("decode_jpeg", ValueError("PRIVATE_PATH"), "decode_failed"),
    ("decode_jpeg", JpegCodecError("invalid_icc_profile"), "invalid_icc"),
    ("render", RuntimeError("PRIVATE_RECIPE"), "render_failed"),
    ("encode_jpeg", OSError("PRIVATE_FILE"), "encode_failed"),
])
def test_safe_engine_failure_codes_and_logs(setup, phase, exception, code):
    backend_logger.clear(); backend_logger.set_level("debug")
    try:
        target = "export_engine_diagnostics.JpegRenderer.render" if phase == "render" else f"export_engine_diagnostics.{phase}"
        with patch(target, side_effect=exception):
            response = request()
        assert response.status_code == 422
        assert response.json() == {"detail": {"code": code}}
        assert response.headers["cache-control"] == "private, no-store"
        entries = backend_logger.get_entries()
        assert entries[-1]["level"] == "error" and entries[-1]["context"]["errorCode"] == code
        assert "PRIVATE" not in json.dumps(entries) and str(ASSET) not in json.dumps(entries)
    finally:
        backend_logger.set_level("off"); backend_logger.clear()


@pytest.mark.parametrize("midstream", [False, True])
def test_original_errors_map_safely_and_close_stream(setup, midstream):
    from immich import ImmichRequestError
    _, _, original, fetch, _ = setup
    if midstream:
        original.fail = True
    else:
        fetch.side_effect = ImmichRequestError("unreachable", "PRIVATE_URL secret")
    response = request()
    assert response.status_code == 502 and response.json() == {"detail": {"code": "original_fetch_failed"}}
    if midstream:
        original.close.assert_awaited_once()


def test_store_unavailable_maps_safely(setup):
    from edit_store import StoreUnavailable
    setup[1].side_effect = StoreUnavailable()
    response = request()
    assert response.status_code == 503 and response.json() == {"detail": {"code": "saved_recipe_unavailable"}}


def test_logging_failure_does_not_change_safe_error(setup):
    setup[2].data = b"malformed"
    with patch.object(backend_logger, "add", side_effect=RuntimeError("logging failed")):
        assert request().json() == {"detail": {"code": "decode_failed"}}
