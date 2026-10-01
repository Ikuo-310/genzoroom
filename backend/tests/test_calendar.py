import asyncio
import json
import unittest
from datetime import date
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx

from immich import ImmichRequestError, get_calendar_day_assets, get_calendar_heatmap, get_calendar_min_year
from main import app


DAY = date(2026, 9, 30)


def asset(index, kind="IMAGE"):
    return {"id": str(UUID(int=index + 1)), "type": kind, "originalFileName": f"photo-{index}.dng",
            "fileCreatedAt": "2026-09-30T12:00:00.000Z"}


def page(items, next_cursor=None):
    return httpx.Response(200, json={"assets": {"items": items, "nextCursor": next_cursor}})


def bucket(ids=(), images=(), timestamps=(), offsets=()):
    return httpx.Response(200, json={"id": list(ids), "isImage": list(images),
        "fileCreatedAt": list(timestamps), "localOffsetHours": list(offsets)})


class CalendarTests(unittest.TestCase):
    def test_month_boundaries_include_last_day_and_roll_over_december(self):
        for year, month, last in ((2026, 7, 31), (2026, 12, 31), (2024, 2, 29), (9999, 12, 31)):
            def handler(request):
                if request.url.path == "/api/timeline/bucket":
                    return bucket()
                self.assertEqual(request.url.params["from"], f"{year:04}-{month:02}-01")
                self.assertEqual(request.url.params["to"], f"{year:04}-{month:02}-{last}")
                return httpx.Response(200, json={"series": [{"date": f"{year:04}-{month:02}-{last}", "count": 1}]})
            result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", year, month,
                transport=httpx.MockTransport(handler)))
            self.assertTrue(result.days[-1].hasAssets)
            self.assertEqual(result.days[-1].date, f"{year:04}-{month:02}-{last}")
            self.assertEqual(len(result.days), last)

    def test_month_uses_one_timeline_bucket_and_local_offsets_for_first_jpeg(self):
        calls = []
        ids = [str(UUID(int=index)) for index in range(1, 6)]
        def handler(request):
            calls.append(request)
            if request.url.path == "/api/users/me/calendar-heatmap":
                return httpx.Response(200, json={"series": [{"date": "2026-07-15", "count": 3},
                    {"date": "2026-07-16", "count": 1}, {"date": "2026-07-17", "count": 1}]})
            if request.url.path == "/api/search/metadata":
                self.assertEqual(json.loads(request.content)["filter"], {
                    "type": {"eq": "IMAGE"}, "or": [{"id": {"eq": ids[index]}} for index in (1, 2, 3)]})
                return page([asset(index) | {"originalFileName": f"image-{index}.jpg"} for index in (3, 2, 1)])
            self.assertEqual(request.url.path, "/api/timeline/bucket")
            self.assertEqual(request.headers["x-api-key"], "secret")
            self.assertEqual(dict(request.url.params), {
                "timeBucket": "2026-07-01T00:00:00.000Z", "orderBy": "takenAt", "order": "desc",
                "visibility": "timeline", "isTrashed": "false", "withStacked": "true"})
            self.assertNotIn("withPartners", request.url.params)
            return bucket(ids, [False, True, True, True, False],
                ["2026-07-15T01:00:00", "2026-07-14T23:00:00Z", "2026-07-15T00:00:00Z",
                 "2026-07-17T00:00:00Z", "2026-07-17T00:00:00Z"], [0, 5.5, 0, -3.5, 0])
        with self.assertLogs("immich", level="INFO") as logs:
            result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 7,
                transport=httpx.MockTransport(handler)))
        diagnostic = next(line for line in logs.output if "Calendar thumbnail lookup:" in line)
        for field in (
            "year=2026", "month=7", "bucket_assets=5", "image_assets=3",
            "month_candidates=3", "candidate_days=2", "format_results=3",
            "jpeg_assets=3", "thumbnail_days=2",
        ):
            self.assertIn(field, diagnostic)
        self.assertNotIn("secret", diagnostic)
        self.assertNotIn("http://immich.example", diagnostic)
        self.assertNotIn(ids[0], diagnostic)
        self.assertFalse(any("WARNING" in line for line in logs.output))
        self.assertEqual(len(calls), 3)
        self.assertEqual(result.days[14].thumbnail_url, f"/api/assets/{ids[1]}/thumbnail")
        self.assertEqual(result.days[15].thumbnail_url, f"/api/assets/{ids[3]}/thumbnail")
        self.assertTrue(result.days[16].hasAssets)
        self.assertIsNone(result.days[16].thumbnail_url)

    def test_optional_timeline_errors_keep_the_heatmap(self):
        for response in (httpx.Response(403, json={"message": "secret"}), httpx.Response(422),
                         httpx.Response(503), httpx.Response(200, content=b"{"),
                         bucket([str(UUID(int=1))], [], [], []),
                         bucket(["invalid"], [True], ["2026-07-01"], [0]),
                         bucket([str(UUID(int=1))], [True], ["broken-date"], [0]),
                         bucket([str(UUID(int=1))], [True], ["2026-07-01"], [None])):
            def handler(request):
                return httpx.Response(200, json={"series": [{"date": "2026-07-01", "count": 2}]}) \
                    if request.url.path.endswith("calendar-heatmap") else response
            with self.subTest(response=response):
                with self.assertLogs("immich", level="WARNING") as logs:
                    result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 7,
                        transport=httpx.MockTransport(handler)))
                self.assertEqual(len(logs.output), 1)
                self.assertIn("stage=timeline", logs.output[0])
                self.assertNotIn("secret", logs.output[0])
                if response.status_code != 200:
                    self.assertIn(f"http_status={response.status_code}", logs.output[0])
                self.assertTrue(result.days[0].hasAssets)
                self.assertTrue(all(day.thumbnail_url is None for day in result.days))

    def test_first_jpeg_is_selected_in_timeline_order_using_real_filenames(self):
        cases = ((["first.jpg", "later.dng"], 0),
                 (["first.dng", "second.dng", "third.JPEG", "fourth.jpg"], 2),
                 (["first.dng", "second.heic", "third.png"], None),
                 (["video.mp4", "photo.jpg"], 1),
                 (["first.jpeg", "second.jpg"], 0))
        for filenames, selected in cases:
            calls = []
            ids = [str(UUID(int=index + 1)) for index in range(len(filenames))]
            def handler(request):
                calls.append(request)
                if request.url.path.endswith("calendar-heatmap"):
                    return httpx.Response(200, json={"series": [{"date": "2026-07-15", "count": len(ids)}]})
                if request.url.path == "/api/timeline/bucket":
                    return bucket(ids, [name != "video.mp4" for name in filenames],
                        ["2026-07-15T00:00:00Z"] * len(ids), [0] * len(ids))
                self.assertEqual(request.url.path, "/api/search/metadata")
                self.assertEqual(request.headers["x-api-key"], "secret")
                body = json.loads(request.content)
                self.assertEqual(body["filter"], {"type": {"eq": "IMAGE"},
                    "or": [{"id": {"eq": ids[index]}} for index, name in enumerate(filenames) if name != "video.mp4"]})
                return page([asset(index) | {"originalFileName": name}
                    for index, name in reversed(list(enumerate(filenames))) if name != "video.mp4"])
            with self.subTest(filenames=filenames):
                result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 7,
                    transport=httpx.MockTransport(handler)))
                self.assertTrue(result.days[14].hasAssets)
                expected = None if selected is None else f"/api/assets/{ids[selected]}/thumbnail"
                self.assertEqual(result.days[14].thumbnail_url, expected)
                self.assertEqual(len(calls), 3)

    def test_format_lookup_is_batched_and_skips_days_with_a_jpeg_already_found(self):
        for first_is_jpeg, expected_sizes in ((True, [100]), (False, [100, 100, 5])):
            sizes = []
            ids = [str(UUID(int=index + 1)) for index in range(205)]
            def handler(request):
                if request.url.path.endswith("calendar-heatmap"):
                    return httpx.Response(200, json={"series": [{"date": "2026-07-15", "count": 205}]})
                if request.url.path == "/api/timeline/bucket":
                    return bucket(ids, [True] * 205, ["2026-07-15T00:00:00Z"] * 205, [0] * 205)
                self.assertEqual(request.url.path, "/api/search/metadata")
                requested = [branch["id"]["eq"] for branch in json.loads(request.content)["filter"]["or"]]
                sizes.append(len(requested))
                return page([asset(ids.index(asset_id)) | {"originalFileName":
                    "photo.jpg" if first_is_jpeg and asset_id == ids[0] else "photo.dng"} for asset_id in requested])
            result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 7,
                transport=httpx.MockTransport(handler)))
            self.assertEqual(sizes, expected_sizes)
            self.assertEqual(result.days[14].thumbnail_url,
                f"/api/assets/{ids[0]}/thumbnail" if first_is_jpeg else None)

    def test_format_lookup_failure_does_not_fail_the_calendar(self):
        for failed in (httpx.Response(403), httpx.Response(422), httpx.Response(500), httpx.Response(200, content=b"{"),
                       page([asset(0) | {"originalFileName": None}])):
            def handler(request):
                if request.url.path.endswith("calendar-heatmap"):
                    return httpx.Response(200, json={"series": [{"date": "2026-07-15", "count": 1}]})
                if request.url.path == "/api/timeline/bucket":
                    return bucket([str(UUID(int=1))], [True], ["2026-07-15T00:00:00Z"], [0])
                return failed
            with self.assertLogs("immich", level="WARNING") as logs:
                result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 7,
                    transport=httpx.MockTransport(handler)))
            self.assertIn("stage=format", logs.output[0])
            self.assertNotIn("secret", logs.output[0])
            if failed.status_code != 200:
                self.assertIn(f"http_status={failed.status_code}", logs.output[0])
            self.assertTrue(result.days[14].hasAssets)
            self.assertIsNone(result.days[14].thumbnail_url)

    def test_next_period_days_are_rejected_instead_of_leaking_into_calendar(self):
        for month, outside in ((7, "2026-08-01"), (None, "2027-01-01")):
            with self.subTest(month=month), self.assertRaises(ImmichRequestError) as error:
                asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, month,
                    transport=httpx.MockTransport(lambda request: httpx.Response(200,
                        json={"series": [{"date": outside, "count": 1}]}))))
            self.assertEqual(error.exception.error_code, "unexpected_response")

    def test_year_heatmap_uses_one_request_and_includes_all_days(self):
        for year, length in ((2026, 365), (2024, 366), (9999, 365)):
            calls = []
            def handler(request):
                calls.append(request)
                self.assertEqual(dict(request.url.params), {"from": f"{year}-01-01", "to": f"{year}-12-31", "type": "Taken"})
                self.assertEqual(request.headers["x-api-key"], "secret")
                return httpx.Response(200, json={"series": [
                    {"date": f"{year}-01-01", "count": 2}, {"date": f"{year}-12-31", "count": 5}]})
            result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", year,
                transport=httpx.MockTransport(handler)))
            self.assertIsNone(result.month)
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(result.days), length)
            self.assertEqual(result.days[0].count, 2)
            self.assertEqual(result.days[-1].count, 5)
            self.assertFalse(result.days[1].hasAssets)
            self.assertEqual(result.days[-1].date, f"{year}-12-31")

    def test_min_year_searches_one_oldest_image_and_returns_local_year(self):
        calls = []
        def handler(request):
            calls.append(request)
            self.assertEqual(request.url.path, "/api/search/metadata")
            self.assertEqual(request.headers["x-api-key"], "secret")
            self.assertEqual(json.loads(request.content), {
                "filter": {"type": {"eq": "IMAGE"}},
                "orderBy": {"field": "localDateTime", "direction": "asc"}, "size": 1,
            })
            return page([asset(0) | {"localDateTime": "2002-03-04T05:06:07.000Z"}])
        result = asyncio.run(get_calendar_min_year("http://immich.example", "secret",
            transport=httpx.MockTransport(handler)))
        self.assertEqual(result, 2002)
        self.assertEqual(len(calls), 1)

    def test_min_year_handles_no_images_and_rejects_upstream_failures(self):
        result = asyncio.run(get_calendar_min_year("http://immich.example", "secret",
            transport=httpx.MockTransport(lambda request: page([]))))
        self.assertIsNone(result)
        for response in (httpx.Response(403), httpx.Response(500), httpx.Response(200, content=b"{"),
                         httpx.Response(200, json={"assets": {"items": "invalid"}}),
                         page([asset(0) | {"localDateTime": None}]),
                         page([asset(0) | {"type": "VIDEO", "localDateTime": "2002-03-04T05:06:07Z"}])):
            with self.subTest(response=response), self.assertRaises(ImmichRequestError):
                asyncio.run(get_calendar_min_year("http://immich.example", "secret",
                    transport=httpx.MockTransport(lambda request: response)))

    def test_heatmap_queries_month_and_allowlists_presence(self):
        def handler(request):
            if request.url.path == "/api/timeline/bucket":
                return bucket()
            self.assertEqual(request.url.path, "/api/users/me/calendar-heatmap")
            self.assertEqual(dict(request.url.params), {"from": "2026-09-01", "to": "2026-09-30", "type": "Taken"})
            self.assertEqual(request.headers["x-api-key"], "secret")
            return httpx.Response(200, json={"from": "2026-09-01", "to": "2026-09-30", "totalCount": 2,
                "series": [{"date": "2026-09-01", "count": 2}, {"date": "2026-09-02", "count": 0}]})

        result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 9,
            transport=httpx.MockTransport(handler)))
        self.assertEqual(len(result.days), 30)
        self.assertEqual(result.days[0].model_dump(), {"date": "2026-09-01", "hasAssets": True, "count": 2, "thumbnail_url": None})
        self.assertEqual(result.days[1].model_dump(), {"date": "2026-09-02", "hasAssets": False, "count": 0, "thumbnail_url": None})
        self.assertEqual(result.days[-1].count, 0)
        self.assertFalse(result.days[-1].hasAssets)

    def test_heatmap_handles_february_and_rejects_bad_upstream(self):
        def leap(request):
            if request.url.path == "/api/timeline/bucket":
                return bucket()
            self.assertEqual(request.url.params["to"], "2024-02-29")
            return httpx.Response(200, json={"series": []})
        result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2024, 2,
            transport=httpx.MockTransport(leap)))
        self.assertEqual(len(result.days), 29)
        for response in (httpx.Response(403), httpx.Response(500), httpx.Response(200, content=b"{"),
                         httpx.Response(200, json={"series": "invalid"}),
                         httpx.Response(200, json={"series": [{"date": "2026-09-01", "count": -1}]}),
                         httpx.Response(200, json={"series": [{"date": "2026-10-01", "count": 1}]})):
            with self.subTest(response=response), self.assertRaises(ImmichRequestError):
                asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 9,
                    transport=httpx.MockTransport(lambda request: response)))

    def test_day_uses_half_open_image_search_and_photo_model(self):
        def handler(request):
            self.assertEqual(request.url.path, "/api/search/metadata")
            self.assertEqual(request.headers["x-api-key"], "secret")
            self.assertEqual(json.loads(request.content), {
                "filter": {"type": {"eq": "IMAGE"}, "takenAt": {
                    "gte": "2026-09-30T00:00:00.000Z", "lt": "2026-10-01T00:00:00.000Z"}},
                "orderBy": {"field": "localDateTime", "direction": "desc"}, "size": 1000,
            })
            return page([asset(0), asset(1, "VIDEO")])
        result = asyncio.run(get_calendar_day_assets("http://immich.example", "secret", DAY,
            transport=httpx.MockTransport(handler)))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].model_dump(mode="json"), {
            "id": str(UUID(int=1)), "filename": "photo-0.dng", "date": "2026-09-30T12:00:00.000Z",
            "thumbnail_url": f"/api/assets/{UUID(int=1)}/thumbnail", "format": "DNG", "is_raw": True,
        })

    def test_day_follows_cursor_past_1000_and_rejects_partial_results(self):
        bodies = []
        def handler(request):
            body = json.loads(request.content)
            bodies.append(body)
            return page([asset(index) for index in range(1000)], "page-2") if len(bodies) == 1 else page(
                [asset(index) for index in range(1000, 1558)])
        result = asyncio.run(get_calendar_day_assets("http://immich.example", "secret", DAY,
            transport=httpx.MockTransport(handler)))
        self.assertEqual(len(result), 1558)
        self.assertEqual(bodies[1]["cursor"], "page-2")
        self.assertEqual({key: value for key, value in bodies[1].items() if key != "cursor"}, bodies[0])

        calls = 0
        def failed(request):
            nonlocal calls
            calls += 1
            return page([asset(0)], "next") if calls == 1 else httpx.Response(503)
        with self.assertRaises(ImmichRequestError):
            asyncio.run(get_calendar_day_assets("http://immich.example", "secret", DAY,
                transport=httpx.MockTransport(failed)))
        with self.assertRaises(ImmichRequestError) as cycle:
            asyncio.run(get_calendar_day_assets("http://immich.example", "secret", DAY,
                transport=httpx.MockTransport(lambda request: page([asset(0)], "same"))))
        self.assertEqual(cycle.exception.error_code, "unexpected_response")

    def test_routes_validate_inputs_and_map_upstream_errors(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
                heatmap = AsyncMock(return_value={"year": 2026, "month": 9, "days": []})
                day_assets = AsyncMock(return_value=[])
                with patch("main.get_calendar_heatmap", heatmap), patch("main.get_calendar_day_assets", day_assets):
                    self.assertEqual((await client.get("/calendar/heatmap?year=2026&month=9")).status_code, 200)
                    heatmap.assert_awaited_with(None, None, 2026, 9)
                    heatmap.return_value = {"year": 2026, "month": None, "days": []}
                    response = await client.get("/calendar/heatmap?year=2026")
                    self.assertEqual(response.status_code, 200)
                    self.assertIsNone(response.json()["month"])
                    heatmap.assert_awaited_with(None, None, 2026, None)
                    self.assertEqual((await client.get("/calendar/2026-09-30/assets")).status_code, 200)
                    day_assets.assert_awaited_with(None, None, DAY)
                    heatmap.return_value = {"year": 9999, "month": 12, "days": []}
                    self.assertEqual((await client.get("/calendar/heatmap?year=9999&month=12")).status_code, 200)
                    for path in ("/calendar/heatmap?year=10000", "/calendar/heatmap?year=0", "/calendar/heatmap?year=0&month=9", "/calendar/heatmap?year=2026&month=13",
                                 "/calendar/heatmap?year=no&month=9", "/calendar/not-a-date/assets"):
                        self.assertEqual((await client.get(path)).status_code, 422)
                with patch("main.get_calendar_min_year", new=AsyncMock(return_value=2002)):
                    response = await client.get("/calendar/min-year")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), {"minYear": 2002})
                with patch("main.get_calendar_heatmap", new=AsyncMock(side_effect=ImmichRequestError("authentication_failed", "Denied"))):
                    self.assertEqual((await client.get("/calendar/heatmap?year=2026&month=9")).status_code, 502)
                with patch("main.get_calendar_min_year", new=AsyncMock(side_effect=ImmichRequestError("unreachable", "Failed"))):
                    self.assertEqual((await client.get("/calendar/min-year")).status_code, 503)
                with patch("main.get_calendar_day_assets", new=AsyncMock(side_effect=ImmichRequestError("unexpected_response", "Failed"))):
                    self.assertEqual((await client.get("/calendar/2026-09-30/assets")).status_code, 502)
        asyncio.run(exercise())
