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


class CalendarTests(unittest.TestCase):
    def test_year_heatmap_uses_one_request_and_includes_all_days(self):
        for year, length in ((2026, 365), (2024, 366)):
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
            self.assertEqual(request.url.path, "/api/users/me/calendar-heatmap")
            self.assertEqual(dict(request.url.params), {"from": "2026-09-01", "to": "2026-09-30", "type": "Taken"})
            self.assertEqual(request.headers["x-api-key"], "secret")
            return httpx.Response(200, json={"from": "2026-09-01", "to": "2026-09-30", "totalCount": 2,
                "series": [{"date": "2026-09-01", "count": 2}, {"date": "2026-09-02", "count": 0}]})

        result = asyncio.run(get_calendar_heatmap("http://immich.example", "secret", 2026, 9,
            transport=httpx.MockTransport(handler)))
        self.assertEqual(len(result.days), 30)
        self.assertEqual(result.days[0].model_dump(), {"date": "2026-09-01", "hasAssets": True, "count": 2})
        self.assertEqual(result.days[1].model_dump(), {"date": "2026-09-02", "hasAssets": False, "count": 0})
        self.assertEqual(result.days[-1].count, 0)
        self.assertFalse(result.days[-1].hasAssets)

    def test_heatmap_handles_february_and_rejects_bad_upstream(self):
        def leap(request):
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
                    for path in ("/calendar/heatmap?year=0", "/calendar/heatmap?year=0&month=9", "/calendar/heatmap?year=2026&month=13",
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
