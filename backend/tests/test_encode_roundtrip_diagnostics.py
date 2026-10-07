import asyncio
import json
import threading
from io import BytesIO
from unittest.mock import patch

import httpx
from PIL import Image

import export_engine_diagnostics as engine
from main import app
from tests.test_export_engine_diagnostics import ASSET, BODY, setup as diagnostic_setup
from tests.test_jpeg_codec import jpeg
from tests.test_jpeg_renderer import recipe
from jpeg_codec import decode_jpeg
from jpeg_renderer import JpegRenderer


def request(body=BODY):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            return await client.post("/developer/export-engine/roundtrip", json=body)
    return asyncio.run(run())


def test_roundtrip_returns_one_saved_recipe_run_as_jpeg_then_rgb(diagnostic_setup):
    saved, store, original, _, writes = diagnostic_setup
    before = dict(saved["state"]["currentRecipe"])
    event_thread = threading.get_ident()
    decode_threads = []
    real_decode = engine.decode_jpeg

    def decode(source):
        decode_threads.append(threading.get_ident())
        return real_decode(source)

    with patch.object(engine, "decode_jpeg", side_effect=decode), \
            patch.object(engine.JpegRenderer, "render", wraps=JpegRenderer().render) as render, \
            patch.object(engine, "encode_jpeg", wraps=engine.encode_jpeg) as encode:
        response = request()

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["cache-control"] == "private, no-store"
    metadata = json.loads(response.headers["X-GenzoRoom-Encode-Roundtrip"])
    assert metadata["outputWidth"] == 7 and metadata["outputHeight"] == 11
    assert metadata["outputColorSpace"] == "sRGB" and metadata["recipeVersion"] == 18
    assert metadata["quality"] == 95 and metadata["subsampling"] == "4:4:4"
    assert metadata["pixelFormat"] == "rgb8" and metadata["rgbBytes"] == 7 * 11 * 3
    assert metadata["outputBytes"] + metadata["rgbBytes"] == len(response.content)
    assert all(metadata[key] >= 0 for key in ("renderMs", "encodeMs", "totalMs"))
    with Image.open(BytesIO(response.content[:metadata["outputBytes"]])) as output:
        assert output.size == (7, 11) and "icc_profile" in output.info
    expected = JpegRenderer().render(real_decode(jpeg(orientation=6)), before).pixels
    assert response.content[metadata["outputBytes"]:] == expected
    store.assert_called_once_with(ASSET)
    render.assert_called_once_with(render.call_args.args[0], before)
    encode.assert_called_once()
    assert decode_threads and decode_threads[0] != event_thread
    original.close.assert_awaited_once()
    for write in writes:
        write.assert_not_called()


def test_roundtrip_rejects_stale_saved_recipe_before_original_fetch(diagnostic_setup):
    saved, _, _, fetch, _ = diagnostic_setup
    saved["revision"] = 4
    response = request()
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "saved_recipe_changed"}}
    fetch.assert_not_awaited()


def test_roundtrip_validation_does_not_reflect_recipe_body(diagnostic_setup):
    response = request({**BODY, "recipe": {"secret": "PRIVATE_RECIPE"}})
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "invalid_diagnostic_request"}}
