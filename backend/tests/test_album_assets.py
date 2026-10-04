from stack_test_helpers import with_empty_stacks

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx

from immich import ImmichRequestError, get_album_assets
from main import app


ALBUM_ID = UUID("12345678-1234-4234-9234-123456789abc")


def asset(index: int, *, kind: str = "IMAGE") -> dict:
    return {
        "id": str(UUID(int=index + 1)), "type": kind,
        "originalFileName": f"photo-{index}.dng", "fileCreatedAt": "2026-09-01T12:00:00.000Z",
        "extra": "not forwarded",
    }


def search_response(items: list[dict], next_cursor: str | None = None) -> httpx.Response:
    return httpx.Response(200, json={"assets": {"items": items, "nextCursor": next_cursor}})


def run_search(handler):
    return asyncio.run(get_album_assets(
        "http://immich.example:2283", "secret-key", ALBUM_ID,
        transport=httpx.MockTransport(with_empty_stacks(handler)),
    ))


class AlbumAssetTests(unittest.TestCase):
    def test_structured_search_allowlists_images_including_archives_and_returns_one_page(self):
        def handler(request):
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.url.path, "/api/search/metadata")
            self.assertEqual(request.headers["x-api-key"], "secret-key")
            self.assertEqual(json.loads(request.content), {
                "filter": {"type": {"eq": "IMAGE"}, "albumIds": {"any": [str(ALBUM_ID)]},
                           "trashedAt": {"eq": None}},
                "orderBy": {"field": "fileCreatedAt", "direction": "desc"},
                "size": 1000,
            })
            return search_response([asset(0) | {"visibility": "archive"}, asset(1, kind="VIDEO")])

        result = run_search(handler)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].model_dump(mode="json"), {
            "id": str(UUID(int=1)), "filename": "photo-0.dng", "date": "2026-09-01T12:00:00.000Z",
            "thumbnail_url": f"/api/assets/{UUID(int=1)}/thumbnail", "format": "DNG", "is_raw": True,
            "stackId": None, "primaryAssetId": None, "stackAssetCount": None,
        })

    def test_follows_cursor_until_all_1558_photos_are_loaded(self):
        requests = []

        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            if len(requests) == 1:
                return search_response([asset(index) for index in range(1000)], "page-two")
            self.assertEqual(body["cursor"], "page-two")
            return search_response([asset(index) for index in range(1000, 1558)])

        result = run_search(handler)
        self.assertEqual(len(result), 1558)
        self.assertEqual(result[-1].filename, "photo-1557.dng")
        self.assertEqual(len(requests), 2)
        self.assertNotIn("cursor", requests[0])
        self.assertEqual({key: value for key, value in requests[1].items() if key != "cursor"}, requests[0])

    def test_rejects_repeated_cursor_and_invalid_pages(self):
        requests = 0

        def repeating(request):
            nonlocal requests
            requests += 1
            return search_response([asset(requests)], "same-cursor")

        with self.assertRaises(ImmichRequestError) as raised:
            run_search(repeating)
        self.assertEqual(raised.exception.error_code, "unexpected_response")
        self.assertEqual(requests, 2)

        cursor_values = iter(("first", "second", "first"))
        with self.assertRaises(ImmichRequestError) as cycle:
            run_search(lambda request: search_response([asset(0)], next(cursor_values)))
        self.assertEqual(cycle.exception.error_code, "unexpected_response")

        invalid_responses = [
            httpx.Response(200, content=b"{", headers={"content-type": "application/json"}),
            httpx.Response(200, json={"assets": {"items": "bad", "nextCursor": None}}),
            httpx.Response(200, json={"assets": {"items": [asset(0)]}}),
            httpx.Response(200, json={"assets": {"items": [asset(0)], "nextCursor": 42}}),
            httpx.Response(200, json={"assets": {"items": [asset(0)], "nextCursor": ""}}),
            httpx.Response(200, json={"assets": {"items": [], "nextCursor": "still-more"}}),
            httpx.Response(200, json={"assets": {"items": [asset(0) | {"id": "bad"}], "nextCursor": None}}),
        ]
        for response in invalid_responses:
            with self.subTest(response=response), self.assertRaises(ImmichRequestError) as invalid:
                run_search(lambda request: response)
            self.assertEqual(invalid.exception.error_code, "unexpected_response")

    def test_upstream_errors_including_mid_pagination_fail_the_whole_request(self):
        for status, code in ((401, "authentication_failed"), (403, "authentication_failed"), (500, "unexpected_response")):
            with self.subTest(status=status), self.assertRaises(ImmichRequestError) as raised:
                run_search(lambda request: httpx.Response(status))
            self.assertEqual(raised.exception.error_code, code)

        requests = 0

        def handler(request):
            nonlocal requests
            requests += 1
            return search_response([asset(0)], "next") if requests == 1 else httpx.Response(503)

        with self.assertRaises(ImmichRequestError) as raised:
            run_search(handler)
        self.assertEqual(raised.exception.error_code, "unexpected_response")
        self.assertEqual(requests, 2)

    def test_backend_route_validates_album_id_and_maps_upstream_errors(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
                search = AsyncMock(return_value=[])
                with patch("main.get_album_assets", search):
                    response = await client.get(f"/albums/{ALBUM_ID}/assets")
                    self.assertEqual(response.status_code, 200)
                    search.assert_awaited_with(None, None, ALBUM_ID)
                    response = await client.get("/albums/not-a-uuid/assets")
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(search.await_count, 1)
                with patch("main.get_album_assets", new=AsyncMock(side_effect=ImmichRequestError("authentication_failed", "Denied"))):
                    response = await client.get(f"/albums/{ALBUM_ID}/assets")
                    self.assertEqual(response.status_code, 502)
        asyncio.run(exercise())
