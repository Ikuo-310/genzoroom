import asyncio
from datetime import date
from uuid import UUID

import httpx
import pytest

from immich import (
    ImmichRequestError, get_album_assets, get_calendar_day_assets,
    get_favorite_assets, get_recent_assets,
)

ASSET_ID = "12345678-1234-4234-9234-123456789abc"
STACK_ID = "22345678-1234-4234-9234-123456789abc"
PRIMARY_ID = "32345678-1234-4234-9234-123456789abc"
ASSET = {"id": ASSET_ID, "type": "IMAGE", "originalFileName": "member.dng",
         "fileCreatedAt": "2026-09-01T12:00:00Z"}


def fetch_assets(kind, item):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path == "/api/search/metadata"
        return httpx.Response(200, json={"assets": {"items": [item], "nextCursor": None}})

    options = {"transport": httpx.MockTransport(handler)}
    args = ("http://immich.example", "key")
    if kind == "recent":
        call = get_recent_assets(*args, **options)
    elif kind == "album":
        call = get_album_assets(*args, UUID(ASSET_ID), **options)
    elif kind == "calendar":
        call = get_calendar_day_assets(*args, date(2026, 9, 1), **options)
    else:
        call = get_favorite_assets(*args, **options)
    result = asyncio.run(call)
    assert len(requests) == 1
    return result[0].model_dump(mode="json")


@pytest.mark.parametrize("kind", ["recent", "album", "calendar", "favorites"])
@pytest.mark.parametrize("metadata", [{}, {"stack": None}])
def test_assets_without_stack_metadata_remain_compatible(kind, metadata):
    asset = fetch_assets(kind, ASSET | metadata)
    assert asset["id"] == ASSET_ID
    assert asset["format"] == "DNG"
    assert asset["is_raw"] is True
    assert asset["stackId"] is None
    assert asset["primaryAssetId"] is None


@pytest.mark.parametrize("kind", ["recent", "album", "calendar", "favorites"])
def test_stack_metadata_is_preserved_without_fetching_members(kind):
    asset = fetch_assets(kind, ASSET | {"stack": {
        "id": STACK_ID, "primaryAssetId": PRIMARY_ID, "assetCount": 2,
    }})
    assert asset["stackId"] == STACK_ID
    assert asset["primaryAssetId"] == PRIMARY_ID
    assert asset["id"] == ASSET_ID
    assert "assetCount" not in asset


@pytest.mark.parametrize("kind", ["recent", "album", "calendar", "favorites"])
@pytest.mark.parametrize("stack", [
    [], "bad", {}, {"id": STACK_ID},
    {"id": "bad", "primaryAssetId": PRIMARY_ID},
    {"id": STACK_ID, "primaryAssetId": "bad"},
    {"id": None, "primaryAssetId": PRIMARY_ID},
    {"id": STACK_ID, "primaryAssetId": 123},
])
def test_malformed_stack_metadata_rejects_the_response(kind, stack):
    with pytest.raises(ImmichRequestError) as error:
        fetch_assets(kind, ASSET | {"stack": stack})
    assert error.value.error_code == "unexpected_response"
