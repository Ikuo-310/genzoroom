import asyncio
import json
import threading
from unittest.mock import patch

import httpx
import pytest

import export_engine_diagnostics as engine
from main import app
from tests.test_export_engine_diagnostics import ASSET, setup
from tests.test_jpeg_codec import jpeg, srgb_profile

PATH = "/developer/export-engine/decode"
BODY = {"assetId": str(ASSET)}


def request(body=BODY):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            return await client.post(PATH, json=body)
    return asyncio.run(run())


@pytest.mark.parametrize("profile,icc", [(None, "absent"), (srgb_profile(), "embedded")])
def test_raw_rgb_decoder_reuse_metadata_thread_and_no_recipe_or_writes(setup, profile, icc):
    _, store, original, fetch, writes = setup
    original.data = jpeg(orientation=6, profile=profile)
    expected = engine.decode_jpeg(original.data)
    threads = []
    actual_decode = engine.decode_jpeg

    def decode(source):
        threads.append(threading.get_ident())
        return actual_decode(source)

    with patch.object(engine, "decode_jpeg", side_effect=decode) as decoder, \
            patch.object(engine, "encode_jpeg") as encoder, patch.object(engine.JpegRenderer, "render") as renderer:
        response = request()
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["cache-control"] == "private, no-store"
    metadata = json.loads(response.headers["X-GenzoRoom-Decode"])
    assert metadata["width"] == 7 and metadata["height"] == 11
    assert metadata["sourceWidth"] == 11 and metadata["sourceHeight"] == 7
    assert metadata["pixelFormat"] == "rgb8" and metadata["sourceIcc"] == icc
    assert metadata["orientationNormalized"] is True and metadata["backendDecodeMs"] >= 0
    assert len(response.content) == metadata["width"] * metadata["height"] * 3
    assert response.content == expected.pixels
    assert str(ASSET) not in str(metadata) and "PRIVATE" not in str(metadata)
    decoder.assert_called_once(); encoder.assert_not_called(); renderer.assert_not_called(); store.assert_not_called()
    assert threads[0] != threading.get_ident()
    fetch.assert_awaited_once(); original.close.assert_awaited_once()
    for write in writes:
        write.assert_not_called()


@pytest.mark.parametrize("body", [{"assetId": "PRIVATE_ASSET"}, {}, {**BODY, "recipe": {"PRIVATE": "secret"}},
                                  {**BODY, "expectedRevision": 3}])
def test_invalid_asset_and_extra_input_are_safe(setup, body):
    response = request(body)
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "invalid_diagnostic_request"}}
    assert response.headers["cache-control"] == "private, no-store"
    setup[3].assert_not_awaited()


@pytest.mark.parametrize("kind", ["fetch", "stream", "close", "decode", "icc"])
def test_safe_fetch_and_decode_errors_with_cleanup(setup, kind):
    from immich import ImmichRequestError
    from jpeg_codec import JpegCodecError
    _, _, original, fetch, _ = setup
    if kind == "fetch":
        fetch.side_effect = ImmichRequestError("unreachable", "PRIVATE_URL token")
    elif kind == "stream":
        original.fail = True
    elif kind == "close":
        original.close.side_effect = RuntimeError("PRIVATE_PATH")
    target = patch.object(engine, "decode_jpeg", side_effect=JpegCodecError("invalid_icc_profile") if kind == "icc" else RuntimeError("PRIVATE_EXCEPTION"))
    with target:
        response = request()
    code = "original_fetch_failed" if kind in ("fetch", "stream", "close") else "backend_decode_failed"
    assert response.status_code == (502 if code == "original_fetch_failed" else 422)
    assert response.json() == {"detail": {"code": code}}
    assert response.headers["cache-control"] == "private, no-store"
    if kind != "fetch":
        original.close.assert_awaited_once()
