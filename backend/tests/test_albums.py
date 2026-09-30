import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx

from immich import ImmichRequestError, get_albums
from main import app


ALBUM_ID = UUID("12345678-1234-4234-9234-123456789abc")
COVER_ID = UUID("87654321-4321-4321-9234-cba987654321")


def run_albums(handler):
    return asyncio.run(get_albums("http://immich.example:2283", "secret-key", transport=httpx.MockTransport(handler)))


class AlbumTests(unittest.TestCase):
    def test_gets_albums_with_only_home_fields(self):
        def handler(request):
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.path, "/api/albums")
            self.assertEqual(request.headers["x-api-key"], "secret-key")
            return httpx.Response(200, json=[{
                "id": str(ALBUM_ID), "albumName": "旅行 2026", "albumThumbnailAssetId": str(COVER_ID),
                "assetCount": 2, "startDate": "2026-04-01T12:00:00.000Z", "endDate": "2026-05-01T12:00:00.000Z",
                "albumUsers": [{"secret": "unused"}], "description": "not sent", "shared": True,
            }, {
                "id": str(COVER_ID), "albumName": "Empty", "albumThumbnailAssetId": None,
                "assetCount": 0,
            }])

        result = run_albums(handler)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].model_dump(mode="json"), {
            "id": str(ALBUM_ID), "albumName": "旅行 2026", "albumThumbnailAssetId": str(COVER_ID),
            "assetCount": 2, "startDate": "2026-04-01T12:00:00.000Z", "endDate": "2026-05-01T12:00:00.000Z",
        })
        self.assertEqual(result[1].assetCount, 0)
        self.assertIsNone(result[1].albumThumbnailAssetId)
        self.assertIsNone(result[1].startDate)
        self.assertIsNone(result[1].endDate)

    def test_rejects_upstream_errors_and_bad_responses(self):
        for status, code in ((401, "authentication_failed"), (403, "authentication_failed"), (500, "unexpected_response")):
            with self.subTest(status=status), self.assertRaises(ImmichRequestError) as raised:
                run_albums(lambda request: httpx.Response(status))
            self.assertEqual(raised.exception.error_code, code)

        valid = {"id": str(ALBUM_ID), "albumName": "Album", "albumThumbnailAssetId": None, "assetCount": 0}
        for body in ({}, ["bad"], [{**valid, "assetCount": True}], [{**valid, "albumThumbnailAssetId": 123}],
                     [{**valid, "startDate": []}], [{**valid, "id": "bad"}], [{**valid, "endDate": "not-a-date"}]):
            with self.subTest(body=body), self.assertRaises(ImmichRequestError) as raised:
                run_albums(lambda request: httpx.Response(200, json=body))
            self.assertEqual(raised.exception.error_code, "unexpected_response")

    def test_backend_route_uses_allowlisted_response_and_existing_error_mapping(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
                with patch("main.get_albums", new=AsyncMock(return_value=[])):
                    response = await client.get("/albums")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), [])
                with patch("main.get_albums", new=AsyncMock(side_effect=ImmichRequestError("authentication_failed", "Denied"))):
                    response = await client.get("/albums")
                    self.assertEqual(response.status_code, 502)
        asyncio.run(exercise())
