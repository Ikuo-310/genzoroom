import asyncio
from unittest.mock import patch

import httpx
import pytest

from backend_logging import BackendLogger
from main import app


def test_developer_api_lifecycle_without_private_collection_or_upstream_requests(monkeypatch):
    logger = BackendLogger()
    monkeypatch.setattr("main.backend_logger", logger)
    monkeypatch.setenv("IMMICH_API_KEY", "PRIVATE_ENV_KEY")
    monkeypatch.setenv("IMMICH_URL", "http://PRIVATE_HOST")
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
            with patch("httpx.AsyncHTTPTransport.handle_async_request", side_effect=AssertionError("Unexpected upstream request")) as send:
                async def request(method, path, **kwargs):
                    response = await client.request(method, path, **kwargs)
                    assert "PRIVATE" not in response.text
                    return response
                response = await request("GET", "/developer/logs/backend/level")
                assert response.status_code == 200 and response.json() == {"level": "off"}
                for level in ["off", "error", "warn", "info", "debug"]:
                    response = await request("PUT", "/developer/logs/backend/level", json={"level": level})
                    assert response.status_code == 200 and response.json() == {"level": level}
                    assert (await request("GET", "/developer/logs/backend/level")).json() == {"level": level}
                assert logger.get_entries() == []
                logger.add(level="warn", component="stack_write", event="operation.response", context={"httpStatus": 201})
                response = await request("GET", "/developer/logs/backend", headers={"Authorization": "PRIVATE_HEADER", "Cookie": "session=PRIVATE_COOKIE"})
                assert response.status_code == 200
                report = response.json()
                assert set(report) == {"schemaVersion", "generatedAt", "source", "entries"}
                assert report["schemaVersion"] == 1 and report["source"] == "backend" and report["generatedAt"].endswith("Z")
                assert report["entries"] == logger.get_entries()
                assert "level" not in report
                response = await request("DELETE", "/developer/logs/backend")
                assert response.status_code == 204 and response.content == b""
                assert (await request("GET", "/developer/logs/backend")).json()["entries"] == []
                assert logger.get_level() == "debug"
                send.assert_not_called()
    asyncio.run(exercise())


@pytest.mark.parametrize("body", [{"level": "WARNING"}, {"level": "invalid"}, {"level": None}, {"level": 1},
    {}, {"level": "debug", "extra": True}])
def test_invalid_level_requests_are_422_without_state_change(body, monkeypatch):
    logger = BackendLogger()
    monkeypatch.setattr("main.backend_logger", logger)
    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
            response = await client.put("/developer/logs/backend/level", json=body)
            assert response.status_code == 422
            assert logger.get_level() == "off" and logger.get_entries() == []
    asyncio.run(exercise())
