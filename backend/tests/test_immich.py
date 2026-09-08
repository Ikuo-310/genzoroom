import asyncio
import io
import json
import logging
import os
import unittest
from uuid import UUID
from unittest.mock import patch

import httpx

from immich import (
    ImmichRequestError,
    check_immich_status,
    get_asset_thumbnail,
    get_recent_assets,
)
from main import app

API_KEY = "test-secret-api-key"
IMMICH_URL = "http://immich.example:2283"
ASSET_ID = UUID("12345678-1234-4234-9234-123456789abc")


def run_check(handler, *, url=IMMICH_URL, api_key=API_KEY):
    transport = httpx.MockTransport(handler)
    return asyncio.run(check_immich_status(url, api_key, transport=transport))


class ImmichStatusTests(unittest.TestCase):
    def test_reports_both_environment_variables_as_missing(self):
        result = asyncio.run(check_immich_status(None, None))

        self.assertFalse(result.configured)
        self.assertFalse(result.connected)
        self.assertEqual(result.error_code, "configuration_missing")

    def test_distinguishes_each_missing_environment_variable(self):
        missing_url = asyncio.run(check_immich_status(None, API_KEY))
        missing_key = asyncio.run(check_immich_status(IMMICH_URL, None))

        self.assertEqual(missing_url.error_code, "immich_url_missing")
        self.assertEqual(missing_key.error_code, "immich_api_key_missing")

    def test_connects_with_the_official_endpoint_and_api_key_header(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/api/users/me")
            self.assertEqual(request.headers["x-api-key"], API_KEY)
            return httpx.Response(200, json={"id": "user-id"})

        result = run_check(handler)

        self.assertTrue(result.configured)
        self.assertTrue(result.connected)
        self.assertIsNone(result.error)

    def test_accepts_an_immich_url_that_already_ends_in_api(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/api/users/me")
            return httpx.Response(200, json={"id": "user-id"})

        result = run_check(handler, url=f"{IMMICH_URL}/api/")

        self.assertTrue(result.connected)

    def test_reports_authentication_failure(self):
        for status_code in (401, 403):
            with self.subTest(status_code=status_code):
                result = run_check(lambda request: httpx.Response(status_code))

                self.assertEqual(result.error_code, "authentication_failed")
                self.assertFalse(result.connected)

    def test_status_endpoint_reports_unconfigured_environment(self):
        async def request_status():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://testserver",
            ) as client:
                return await client.get("/immich/status")

        with patch.dict(os.environ, {"IMMICH_URL": "", "IMMICH_API_KEY": ""}):
            response = asyncio.run(request_status())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "configured": False,
                "connected": False,
                "error": "IMMICH_URL and IMMICH_API_KEY are not configured.",
                "error_code": "configuration_missing",
            },
        )

    def test_reports_unreachable_server(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection failed", request=request)

        result = run_check(handler)

        self.assertEqual(result.error_code, "unreachable")
        self.assertFalse(result.connected)

    def test_reports_unexpected_status_or_json(self):
        bad_status = run_check(lambda request: httpx.Response(500))
        bad_json = run_check(lambda request: httpx.Response(200, text="not json"))
        missing_id = run_check(lambda request: httpx.Response(200, json={}))

        self.assertEqual(bad_status.error_code, "unexpected_response")
        self.assertEqual(bad_json.error_code, "unexpected_response")
        self.assertEqual(missing_id.error_code, "unexpected_response")

    def test_api_key_is_not_exposed_in_result_or_logs(self):
        log_output = io.StringIO()
        handler = logging.StreamHandler(log_output)
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        try:
            result = run_check(lambda request: httpx.Response(403))
        finally:
            root_logger.removeHandler(handler)

        rendered_result = result.model_dump_json(exclude_none=True)
        self.assertNotIn(API_KEY, rendered_result)
        self.assertNotIn(API_KEY, log_output.getvalue())


class ImmichAssetTests(unittest.TestCase):
    def run_recent(self, handler, *, url=IMMICH_URL, api_key=API_KEY):
        return asyncio.run(
            get_recent_assets(
                url,
                api_key,
                transport=httpx.MockTransport(handler),
            )
        )

    def test_gets_recent_images_with_minimal_frontend_fields(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.url.path, "/api/search/metadata")
            self.assertEqual(request.headers["x-api-key"], API_KEY)
            self.assertEqual(
                json.loads(request.content),
                {
                    "filter": {"type": {"eq": "IMAGE"}},
                    "orderBy": {"field": "fileCreatedAt", "direction": "desc"},
                    "size": 10,
                },
            )
            return httpx.Response(
                200,
                json={
                    "assets": {
                        "items": [
                            {
                                "id": str(ASSET_ID),
                                "type": "IMAGE",
                                "originalFileName": "photo.jpg",
                                "fileCreatedAt": "2026-09-01T12:00:00.000Z",
                            },
                            {
                                "id": "video-is-not-parsed",
                                "type": "VIDEO",
                            },
                        ]
                    }
                },
            )

        result = self.run_recent(handler)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].filename, "photo.jpg")
        self.assertEqual(
            result[0].thumbnail_url,
            f"/api/assets/{ASSET_ID}/thumbnail",
        )
        self.assertNotIn(API_KEY, result[0].model_dump_json())

    def test_gets_an_empty_asset_list(self):
        result = self.run_recent(
            lambda request: httpx.Response(200, json={"assets": {"items": []}})
        )

        self.assertEqual(result, [])

    def test_reports_asset_api_errors_without_exposing_the_key(self):
        for status_code, error_code in ((403, "authentication_failed"), (500, "unexpected_response")):
            with self.subTest(status_code=status_code):
                with self.assertRaises(ImmichRequestError) as raised:
                    self.run_recent(lambda request: httpx.Response(status_code))

                self.assertEqual(raised.exception.error_code, error_code)
                self.assertNotIn(API_KEY, str(raised.exception))

    def test_proxies_thumbnail_bytes_and_content_type(self):
        image = b"fake-thumbnail"

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.path, f"/api/assets/{ASSET_ID}/thumbnail")
            self.assertEqual(request.url.params["size"], "thumbnail")
            self.assertEqual(request.headers["x-api-key"], API_KEY)
            return httpx.Response(200, content=image, headers={"content-type": "image/jpeg"})

        thumbnail = asyncio.run(
            get_asset_thumbnail(
                IMMICH_URL,
                API_KEY,
                ASSET_ID,
                transport=httpx.MockTransport(handler),
            )
        )

        self.assertEqual(thumbnail.content, image)
        self.assertEqual(thumbnail.media_type, "image/jpeg")
        self.assertNotIn(API_KEY, repr(thumbnail))

    def test_reports_unreachable_asset_api(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection failed", request=request)

        with self.assertRaises(ImmichRequestError) as raised:
            self.run_recent(handler)

        self.assertEqual(raised.exception.error_code, "unreachable")


if __name__ == "__main__":
    unittest.main()
