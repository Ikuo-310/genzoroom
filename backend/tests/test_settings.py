import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from immich import ImmichAbout, get_immich_about
from main import app


class SettingsAboutTests(unittest.TestCase):
    def about(self, handler, url="http://immich.example", key="private-key"):
        return asyncio.run(get_immich_about(url, key, transport=httpx.MockTransport(handler)))

    def test_allows_only_safe_build_information(self):
        def handler(request):
            self.assertEqual(request.url.path, "/api/server/about")
            self.assertEqual(request.headers["x-api-key"], "private-key")
            return httpx.Response(200, json={
                "version": "v3.0.0", "build": "release", "sourceRef": "main",
                "apiKey": "secret", "repositoryUrl": "http://private-host", "statistics": {"count": 10},
            })
        self.assertEqual(self.about(handler).model_dump(exclude_none=True), {
            "version": "v3.0.0", "build": "release", "sourceRef": "main",
        })

    def test_permission_and_server_errors_are_optional_diagnostics(self):
        for status, code in [(401, "authentication_failed"), (403, "authentication_failed"), (500, "unexpected_response")]:
            with self.subTest(status=status):
                result = self.about(lambda request: httpx.Response(status))
                self.assertEqual(result.error_code, code)
                self.assertIsNone(result.version)

    def test_unreachable_and_missing_configuration(self):
        def fail(request):
            raise httpx.ConnectError("private connection detail", request=request)
        self.assertEqual(self.about(fail).error_code, "unreachable")
        self.assertEqual(self.about(fail, key=None).error_code, "configuration_missing")

    def test_malformed_about_and_optional_fields(self):
        for body in [[], {}, {"version": 3}, {"version": ""}]:
            with self.subTest(body=body):
                self.assertEqual(self.about(lambda request: httpx.Response(200, json=body)).error_code, "unexpected_response")
        self.assertEqual(self.about(lambda request: httpx.Response(200, text="invalid")).error_code, "unexpected_response")
        result = self.about(lambda request: httpx.Response(200, json={"version": "v3", "build": 1}))
        self.assertIsNone(result.build)

    def test_backend_route_returns_safe_information_and_errors(self):
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
                for about in [ImmichAbout(version="v3"), ImmichAbout(error_code="authentication_failed")]:
                    with patch("main.get_immich_about", AsyncMock(return_value=about)):
                        response = await client.get("/immich/about")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), about.model_dump(exclude_none=True))
        asyncio.run(exercise())
