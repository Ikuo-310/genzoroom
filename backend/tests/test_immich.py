from stack_test_helpers import with_empty_stacks

import asyncio
import io
import json
import logging
import os
import unittest
from uuid import UUID
from unittest.mock import AsyncMock, patch

import httpx

from immich import (
    AssetDetail,
    AssetExif,
    ImmichRequestError,
    ImmichThumbnail,
    check_immich_status,
    classify_image_format,
    get_asset_detail,
    get_asset_preview,
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
    def run_detail_with_exif(self, exif):
        body = {
            "id": str(ASSET_ID),
            "type": "IMAGE",
            "originalFileName": "photo.jpg",
            "fileCreatedAt": "2026-09-01T12:00:00.000Z",
            "exifInfo": {"make": "Example Camera Co.", "fNumber": 2.8, **exif},
        }
        # Raw JSON permits non-finite upstream values that httpx's json= encoder rejects.
        transport = httpx.MockTransport(lambda request: httpx.Response(
            200, content=json.dumps(body), headers={"content-type": "application/json"},
        ))
        return asyncio.run(get_asset_detail(IMMICH_URL, API_KEY, ASSET_ID, transport=transport))

    def run_recent(self, handler, *, url=IMMICH_URL, api_key=API_KEY, limit=100):
        return asyncio.run(
            get_recent_assets(
                url,
                api_key,
                limit=limit,
                transport=httpx.MockTransport(with_empty_stacks(handler)),
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
                    "filter": {"type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"},
                               "trashedAt": {"eq": None}},
                    "orderBy": {"field": "fileCreatedAt", "direction": "desc"},
                    "size": 100,
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
        self.assertEqual(result[0].format, "JPEG")
        self.assertFalse(result[0].is_raw)
        self.assertEqual(
            result[0].thumbnail_url,
            f"/api/assets/{ASSET_ID}/thumbnail",
        )
        self.assertNotIn(API_KEY, result[0].model_dump_json())

    def test_recent_requests_only_timeline_images(self):
        items = [{"id": str(UUID(int=index + 1)), "type": "IMAGE", "visibility": visibility,
                  "originalFileName": f"photo-{index}.jpg", "fileCreatedAt": "2026-09-01T12:00:00Z"}
                 for index, visibility in enumerate(("timeline", "archive", "hidden", "locked"))]
        def handler(request):
            search_filter = json.loads(request.content)["filter"]
            self.assertEqual(search_filter, {"type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"},
                                             "trashedAt": {"eq": None}})
            return httpx.Response(200, json={"assets": {"items": [item for item in items
                if item["visibility"] == search_filter["visibility"]["eq"]]}})
        self.assertEqual([str(photo.id) for photo in self.run_recent(handler)], [items[0]["id"]])

    def test_forwards_limit_to_immich_and_caps_returned_images(self):
        items = [
            {
                "id": str(UUID(int=index + 1)),
                "type": "IMAGE",
                "originalFileName": f"photo-{index + 1}.jpg",
                "fileCreatedAt": "2026-09-01T12:00:00.000Z",
            }
            for index in range(501)
        ]

        def handler(request):
            self.assertEqual(json.loads(request.content)["size"], 250)
            return httpx.Response(200, json={"assets": {"items": items}})

        result = self.run_recent(handler, limit=250)

        self.assertEqual(len(result), 250)
        self.assertEqual(result[0].filename, "photo-1.jpg")
        self.assertEqual(result[-1].filename, "photo-250.jpg")

    def test_recent_paginates_after_removing_children_and_quarantine_until_limit_is_filled(self):
        primary_id = str(UUID(int=900))
        child_ids = [str(UUID(int=index)) for index in range(1, 51)]
        visible_ids = [str(UUID(int=index)) for index in range(100, 150)]
        search_requests = []

        def search_item(asset_id):
            return {"id": asset_id, "type": "IMAGE", "originalFileName": f"{asset_id}.jpg",
                    "fileCreatedAt": "2026-09-01T12:00:00Z"}

        def handler(request):
            if request.url.path == "/api/stacks":
                return httpx.Response(200, json=[{
                    "id": str(UUID(int=901)), "primaryAssetId": primary_id,
                    "assets": [{"id": primary_id}, *[{"id": asset_id} for asset_id in child_ids[:25]]],
                }, {
                    "id": str(UUID(int=902)), "primaryAssetId": child_ids[25],
                    "assets": [*[{"id": asset_id} for asset_id in child_ids[25:]], {"id": child_ids[-1]}],
                }])
            body = json.loads(request.content)
            search_requests.append(body)
            if len(search_requests) == 1:
                return httpx.Response(200, json={"assets": {
                    "items": [search_item(asset_id) for asset_id in child_ids], "nextCursor": "page-2",
                }})
            return httpx.Response(200, json={"assets": {
                "items": [search_item(asset_id) for asset_id in visible_ids], "nextCursor": None,
            }})

        result = asyncio.run(get_recent_assets(
            IMMICH_URL, API_KEY, limit=50, transport=httpx.MockTransport(handler),
        ))

        self.assertEqual([str(item.id) for item in result], visible_ids)
        self.assertEqual(len(search_requests), 2)
        for request_body in search_requests:
            self.assertEqual(request_body["filter"], {
                "type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"}, "trashedAt": {"eq": None},
            })
            self.assertEqual(request_body["orderBy"], {"field": "fileCreatedAt", "direction": "desc"})
            self.assertEqual(request_body["size"], 50)
            self.assertNotIn("withStacked", request_body)
        self.assertNotIn("cursor", search_requests[0])
        self.assertEqual(search_requests[1]["cursor"], "page-2")

    def test_rejects_invalid_limits_before_requesting_immich(self):
        for limit in (49, 51, 0, 501, 1000, True):
            with self.subTest(limit=limit):
                with self.assertRaises(ValueError):
                    self.run_recent(lambda request: self.fail("Immich should not be called"), limit=limit)

    def test_recent_assets_route_validates_and_forwards_allowed_limits(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
                get_recent = AsyncMock(return_value=[])
                with patch("main.get_recent_assets", get_recent):
                    response = await client.get("/assets/recent")
                    self.assertEqual(response.status_code, 200)
                    get_recent.assert_awaited_with(None, None, limit=100)
                    for limit in range(50, 501, 50):
                        response = await client.get("/assets/recent", params={"limit": limit})
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(get_recent.await_args.kwargs["limit"], limit)
                    calls_before_invalid = get_recent.await_count
                    for limit in ("49", "51", "0", "501", "1000000", "invalid"):
                        response = await client.get("/assets/recent", params={"limit": limit})
                        self.assertEqual(response.status_code, 422)
                    self.assertEqual(get_recent.await_count, calls_before_invalid)
        asyncio.run(exercise())

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

    def test_gets_asset_detail_and_selected_exif_fields(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.path, f"/api/assets/{ASSET_ID}")
            self.assertEqual(request.headers["x-api-key"], API_KEY)
            return httpx.Response(
                200,
                json={
                    "id": str(ASSET_ID),
                    "type": "IMAGE",
                    "originalFileName": "capture.DNG",
                    "fileCreatedAt": "2026-09-01T12:00:00.000Z",
                    "exifInfo": {
                        "dateTimeOriginal": "2026-09-01T12:00:00.000Z",
                        "make": "Example Camera Co.",
                        "model": "Model One",
                        "lensModel": "Prime 35mm",
                        "focalLength": 35,
                        "fNumber": 2.8,
                        "exposureTime": "1/125",
                        "iso": 200,
                        "exposureCompensation": -0.3,
                        "exifImageWidth": 6000,
                        "exifImageHeight": 4000,
                        "latitude": 35.0,
                        "longitude": 139.0,
                    },
                },
            )

        detail = asyncio.run(get_asset_detail(
            IMMICH_URL,
            API_KEY,
            ASSET_ID,
            transport=httpx.MockTransport(handler),
        ))

        self.assertEqual(detail.filename, "capture.DNG")
        self.assertEqual(detail.preview_url, f"/api/assets/{ASSET_ID}/preview")
        self.assertEqual(detail.format, "DNG")
        self.assertTrue(detail.is_raw)
        self.assertEqual(detail.exif.focal_length, 35)
        self.assertEqual(detail.exif.width, 6000)
        self.assertEqual(detail.exif.latitude, 35.0)
        self.assertEqual(detail.exif.longitude, 139.0)
        self.assertNotIn(API_KEY, detail.model_dump_json())

    def test_asset_detail_handles_missing_exif_safely(self):
        response = {
            "id": str(ASSET_ID),
            "type": "IMAGE",
            "originalFileName": "photo.jpg",
            "fileCreatedAt": "2026-09-01T12:00:00.000Z",
        }
        detail = asyncio.run(get_asset_detail(
            IMMICH_URL,
            API_KEY,
            ASSET_ID,
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response)),
        ))

        self.assertEqual(detail.exif.model_dump(exclude_none=True), {})

    def test_ignores_nonfinite_optional_exif_integers(self):
        fields = {"iso": "iso", "exifImageWidth": "width", "exifImageHeight": "height"}
        for field, attribute in fields.items():
            for value in (float("inf"), float("-inf"), float("nan")):
                with self.subTest(field=field, value=value):
                    exif = {"iso": 200, "exifImageWidth": 6000, "exifImageHeight": 4000}
                    exif[field] = value
                    detail = self.run_detail_with_exif(exif)
                    self.assertIsNone(getattr(detail.exif, attribute))
                    self.assertNotIn(attribute, detail.exif.model_dump(exclude_none=True))
                    for other, other_attribute in fields.items():
                        if other != field:
                            self.assertEqual(getattr(detail.exif, other_attribute), exif[other])
                    self.assertEqual(detail.filename, "photo.jpg")
                    self.assertEqual(detail.preview_url, f"/api/assets/{ASSET_ID}/preview")
                    self.assertEqual(detail.exif.make, "Example Camera Co.")
                    self.assertEqual(detail.exif.f_number, 2.8)

    def test_preserves_optional_exif_integer_conversion_and_rejected_formats(self):
        cases = [
            (200, 200), (200.9, 200), (-2.9, -2), (0, 0),
            (10 ** 400, 10 ** 400), (1e308, int(1e308)),
            ("200", None), ("200.9", None), ("1e400", None),
            ("NaN", None), ("not-a-number", None), ("", None),
            (True, None), (False, None), (None, None), ([], None), ({}, None),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                detail = self.run_detail_with_exif({
                    "iso": value, "exifImageWidth": value, "exifImageHeight": value,
                })
                for attribute in ("iso", "width", "height"):
                    self.assertEqual(getattr(detail.exif, attribute), expected)
                self.assertEqual(detail.exif.make, "Example Camera Co.")

    def test_detail_endpoint_omits_invalid_exif_and_preserves_other_fields(self):
        detail = self.run_detail_with_exif({
            "iso": float("inf"), "exifImageWidth": 6000, "exifImageHeight": float("nan"),
        })

        async def request_detail():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.get(f"/assets/{ASSET_ID}")

        with patch("main.get_asset_detail", new=AsyncMock(return_value=detail)):
            response = asyncio.run(request_detail())
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["id"], str(ASSET_ID))
        self.assertEqual(body["filename"], "photo.jpg")
        self.assertEqual(body["date"], "2026-09-01T12:00:00.000Z")
        self.assertEqual(body["exif"], {"make": "Example Camera Co.", "f_number": 2.8, "width": 6000})

    def test_optional_gps_coordinates_preserve_detail_and_reject_malformed_values(self):
        cases = [(None, None, None), (35.123, 90, 35.123), (0, 90, 0.0),
                 (-90, 90, -90.0), (180, 180, 180.0), (91, 90, None),
                 (-181, 180, None), ("35.0", 90, None), (True, 90, None),
                 ({}, 90, None), (float("inf"), 90, None),
                 (float("nan"), 90, None), (10 ** 1000, 90, None)]
        for value, limit, expected in cases:
            field = "longitude" if limit == 180 else "latitude"
            with self.subTest(field=field, value=value):
                detail = self.run_detail_with_exif({field: value})
                self.assertEqual(getattr(detail.exif, field), expected)
                self.assertEqual(detail.exif.make, "Example Camera Co.")
                self.assertEqual(detail.exif.f_number, 2.8)
                if expected is None:
                    self.assertNotIn(field, detail.exif.model_dump(exclude_none=True))
        detail = self.run_detail_with_exif({})
        self.assertIsNone(detail.exif.latitude)
        self.assertIsNone(detail.exif.longitude)

    def test_gps_is_added_to_the_existing_detail_endpoint_contract(self):
        detail = self.run_detail_with_exif({"latitude": 35.123, "longitude": 139.456})

        async def request_detail():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                return await client.get(f"/assets/{ASSET_ID}")

        with patch("main.get_asset_detail", new=AsyncMock(return_value=detail)):
            response = asyncio.run(request_detail())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["exif"]["latitude"], 35.123)
        self.assertEqual(response.json()["exif"]["longitude"], 139.456)
        self.assertEqual(response.json()["filename"], detail.filename)

    def test_proxies_preview_instead_of_the_original_asset(self):
        image = b"fake-preview"

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, f"/api/assets/{ASSET_ID}/thumbnail")
            self.assertEqual(request.url.params["size"], "preview")
            self.assertEqual(request.headers["x-api-key"], API_KEY)
            return httpx.Response(200, content=image, headers={"content-type": "image/webp"})

        preview = asyncio.run(get_asset_preview(
            IMMICH_URL,
            API_KEY,
            ASSET_ID,
            transport=httpx.MockTransport(handler),
        ))

        self.assertEqual(preview.content, image)
        self.assertEqual(preview.media_type, "image/webp")
        self.assertNotIn(API_KEY, repr(preview))

    def test_asset_detail_and_preview_report_upstream_errors(self):
        for operation in (get_asset_detail, get_asset_preview):
            with self.subTest(operation=operation.__name__):
                with self.assertRaises(ImmichRequestError) as raised:
                    asyncio.run(operation(
                        IMMICH_URL,
                        API_KEY,
                        ASSET_ID,
                        transport=httpx.MockTransport(lambda request: httpx.Response(403)),
                    ))
                self.assertEqual(raised.exception.error_code, "authentication_failed")
                self.assertNotIn(API_KEY, str(raised.exception))

    def test_genzoroom_asset_detail_endpoint_omits_missing_exif(self):
        async def request_detail():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.get(f"/assets/{ASSET_ID}")

        detail = AssetDetail(
            id=ASSET_ID,
            filename="photo.jpg",
            date="2026-09-01T12:00:00.000Z",
            preview_url=f"/api/assets/{ASSET_ID}/preview",
            thumbnail_url=f"/api/assets/{ASSET_ID}/thumbnail",
            format="JPEG",
            is_raw=False,
            exif=AssetExif(),
        )
        with patch("main.get_asset_detail", new=AsyncMock(return_value=detail)):
            response = asyncio.run(request_detail())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["exif"], {})
        self.assertNotIn(API_KEY, response.text)

    def test_genzoroom_preview_endpoint_returns_proxied_image(self):
        async def request_preview():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.get(f"/assets/{ASSET_ID}/preview")

        preview = ImmichThumbnail(content=b"preview", media_type="image/jpeg")
        with patch("main.get_asset_preview", new=AsyncMock(return_value=preview)):
            response = asyncio.run(request_preview())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"preview")
        self.assertEqual(response.headers["content-type"], "image/jpeg")

    def test_reports_unreachable_asset_api(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection failed", request=request)

        with self.assertRaises(ImmichRequestError) as raised:
            self.run_recent(handler)

        self.assertEqual(raised.exception.error_code, "unreachable")


class ImageFormatTests(unittest.TestCase):
    def test_normalizes_common_non_raw_formats(self):
        cases = {
            "photo.jpg": "JPEG",
            "photo.jpeg": "JPEG",
            "photo.heic": "HEIC",
            "photo.heif": "HEIC",
            "photo.JpEg": "JPEG",
        }

        for filename, expected_format in cases.items():
            with self.subTest(filename=filename):
                image_format, is_raw = classify_image_format(filename)
                self.assertEqual(image_format, expected_format)
                self.assertFalse(is_raw)

    def test_identifies_supported_raw_formats(self):
        for extension in ("dng", "pef", "nef", "arw", "cr2", "cr3", "raf", "orf", "rw2"):
            with self.subTest(extension=extension):
                image_format, is_raw = classify_image_format(f"photo.{extension}")
                self.assertEqual(image_format, extension.upper())
                self.assertTrue(is_raw)

    def test_returns_unknown_extension_in_uppercase(self):
        image_format, is_raw = classify_image_format("photo.avif")

        self.assertEqual(image_format, "AVIF")
        self.assertFalse(is_raw)

    def test_uses_a_safe_fallback_without_an_extension(self):
        for filename in ("photo", "photo."):
            with self.subTest(filename=filename):
                self.assertEqual(classify_image_format(filename), ("UNKNOWN", False))


if __name__ == "__main__":
    unittest.main()
