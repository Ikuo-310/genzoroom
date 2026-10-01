import asyncio
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from immich import ImmichRequestError, get_favorite_assets
from main import app


ASSET = {"id": "12345678-1234-4234-9234-123456789abc", "type": "IMAGE",
         "originalFileName": "favorite.jpg", "fileCreatedAt": "2026-09-01T12:00:00Z"}


def run_search(handler):
    return asyncio.run(get_favorite_assets("http://immich.example", "key", transport=httpx.MockTransport(handler)))


def test_favorites_conditions_and_cursor_use_shared_search():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        assert request.url.path == "/api/search/metadata"
        expected = {"filter": {"type": {"eq": "IMAGE"}, "visibility": {"eq": "timeline"},
                               "isFavorite": {"eq": True}},
                    "orderBy": {"field": "fileCreatedAt", "direction": "desc"}, "size": 1000}
        if len(bodies) == 2:
            expected["cursor"] = "next"
        assert bodies[-1] == expected
        return httpx.Response(200, json={"assets": {"items": [ASSET],
                              "nextCursor": "next" if len(bodies) == 1 else None}})

    assets = run_search(handler)
    assert len(assets) == 2
    assert assets[0].filename == "favorite.jpg"
    assert assets[0].is_raw is False
    assert assets[0].thumbnail_url == f"/api/assets/{ASSET['id']}/thumbnail"
    assert len(bodies) == 2


def test_empty_favorites():
    assert run_search(lambda request: httpx.Response(200, json={"assets": {"items": [], "nextCursor": None}})) == []


@pytest.mark.parametrize("response", [httpx.Response(403), httpx.Response(500),
                                     httpx.Response(200, json={"assets": {"items": "invalid"}})])
def test_favorite_upstream_failures(response):
    with pytest.raises(ImmichRequestError):
        run_search(lambda request: response)


def test_favorite_endpoint_model_and_error():
    async def exercise():
        assets = run_search_result
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend") as client:
            with patch("main.get_favorite_assets", new=AsyncMock(return_value=assets)) as search:
                response = await client.get("/assets/favorites")
                assert response.status_code == 200
                assert response.json() == [asset.model_dump(mode="json") for asset in assets]
                assert search.await_count == 1
            with patch("main.get_favorite_assets", new=AsyncMock(side_effect=ImmichRequestError("authentication_failed", "Denied"))):
                assert (await client.get("/assets/favorites")).status_code == 502

    run_search_result = run_search(lambda request: httpx.Response(200, json={"assets": {"items": [ASSET], "nextCursor": None}}))
    asyncio.run(exercise())
