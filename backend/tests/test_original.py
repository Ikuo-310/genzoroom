import asyncio
import unittest
from unittest.mock import patch
from uuid import UUID

import httpx

from immich import ImmichRequestError, get_asset_original
from main import app

ASSET_ID = UUID("12345678-1234-4234-9234-123456789abc")


class TrackedStream(httpx.AsyncByteStream):
    def __init__(self, fail=False):
        self.reads = 0
        self.closed = False
        self.fail = fail

    async def __aiter__(self):
        for _ in range(3):
            self.reads += 1
            yield b"x" * 65536
            if self.fail:
                raise httpx.ReadTimeout("private upstream detail")

    async def aclose(self):
        self.closed = True


def transport_for(stream, filename="PXL_RAW-01.COVER.jpg", status=200, media_type="image/jpeg"):
    def handler(request):
        assert request.headers["x-api-key"] == "secret"
        if request.url.path == f"/api/assets/{ASSET_ID}":
            return httpx.Response(200, json={"type": "IMAGE", "originalFileName": filename,
                                             "fileCreatedAt": "2026-09-29", "isFavorite": False})
        assert request.url.path == f"/api/assets/{ASSET_ID}/original"
        assert not request.url.params
        return httpx.Response(status, headers={"content-type": media_type}, stream=stream)
    return httpx.MockTransport(handler)


class OriginalTests(unittest.TestCase):
    def test_streams_without_reading_ahead_and_closes_on_partial_consumption(self):
        async def run():
            for filename in ("photo.jpeg", "PXL_RAW-01.COVER.jpg"):
                stream = TrackedStream()
                original = await get_asset_original("http://immich", "secret", ASSET_ID, transport=transport_for(stream, filename))
                self.assertEqual(stream.reads, 0)
                chunks = original.chunks()
                self.assertEqual(len(await anext(chunks)), 65536)
                self.assertEqual(stream.reads, 1)
                await chunks.aclose()
                self.assertTrue(stream.closed)
                self.assertTrue(original.client.is_closed)
        asyncio.run(run())

    def test_rejects_non_jpeg_before_downloading(self):
        async def run():
            stream = TrackedStream()
            with self.assertRaises(ImmichRequestError):
                await get_asset_original("http://immich", "secret", ASSET_ID, transport=transport_for(stream, "photo.dng"))
            self.assertEqual(stream.reads, 0)
        asyncio.run(run())

    def test_rejects_status_redirect_and_wrong_content_type_without_reading_body(self):
        async def run():
            for status, media_type, code in ((403, "image/jpeg", "authentication_failed"), (302, "image/jpeg", "unexpected_response"), (200, "image/tiff", "unexpected_response")):
                stream = TrackedStream()
                with self.assertRaises(ImmichRequestError) as caught:
                    await get_asset_original("http://immich", "secret", ASSET_ID, transport=transport_for(stream, status=status, media_type=media_type))
                self.assertEqual(caught.exception.error_code, code)
                self.assertNotIn("secret", str(caught.exception))
                self.assertEqual(stream.reads, 0)
                self.assertTrue(stream.closed)
        asyncio.run(run())

    def test_midstream_timeout_releases_connections(self):
        async def run():
            stream = TrackedStream(fail=True)
            original = await get_asset_original("http://immich", "secret", ASSET_ID, transport=transport_for(stream))
            with self.assertRaises(httpx.ReadTimeout):
                async for _ in original.chunks():
                    pass
            self.assertTrue(stream.closed)
            self.assertTrue(original.client.is_closed)
        asyncio.run(run())

    def test_endpoint_returns_only_image_and_safe_headers(self):
        async def run():
            stream = TrackedStream()
            async def get_original(*args):
                return await get_asset_original("http://immich", "secret", ASSET_ID, transport=transport_for(stream))
            with patch("main.get_asset_original", new=get_original):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    response = await client.get(f"/assets/{ASSET_ID}/original")
            self.assertEqual(response.content, b"x" * 65536 * 3)
            self.assertEqual(response.headers["content-type"], "image/jpeg")
            self.assertEqual(response.headers["x-accel-buffering"], "no")
            self.assertNotIn("secret", str(response.headers))
            self.assertTrue(stream.closed)
        asyncio.run(run())

    def test_endpoint_maps_upstream_errors(self):
        async def run():
            from unittest.mock import AsyncMock
            for code, status in (("unreachable", 503), ("authentication_failed", 502)):
                with patch("main.get_asset_original", new=AsyncMock(side_effect=ImmichRequestError(code, "Safe message"))):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                        response = await client.get(f"/assets/{ASSET_ID}/original")
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json(), {"detail": "Safe message"})
        asyncio.run(run())
