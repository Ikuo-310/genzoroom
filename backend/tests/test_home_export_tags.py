import asyncio
import json
from uuid import UUID

import httpx
import pytest

from immich import get_recent_assets, get_favorite_assets, _search_assets

PRIMARY, CHILD, SOLO, STACK, TAG = [str(UUID(int=i)) for i in range(1, 6)]


def photo(asset_id, **metadata):
    return {"id": asset_id, "type": "IMAGE", "originalFileName": "ordinary.jpg",
            "fileCreatedAt": "2026-10-01T00:00:00Z", **metadata}


@pytest.mark.parametrize("tags,expected", [
    ([{"value": "GenzoRoom"}], True),
    ([{"name": "GenzoRoom", "value": "Other"}], False),
    ([{"value": "genzoroom"}], False),
    ([{"value": "parent/GenzoRoom"}], False),
    ([], False), (None, None), ("bad", None), ([None], None), ([{"value": 1}], None),
])
def test_home_parses_only_the_exact_asset_tag_and_preserves_optional_failure(tags, expected):
    body = {"assets": {"items": [photo(SOLO, tags=tags)]}}
    asset = _search_assets(body, home_metadata=True)[0]
    assert asset.isGenzoRoomExport is expected
    assert "tags" not in asset.model_dump()
    assert "isGenzoRoomExport" not in _search_assets(body)[0].model_dump()


@pytest.mark.parametrize("primary_tagged", [True, False])
def test_home_resolves_tag_membership_in_one_batch_without_child_aggregation(primary_tagged):
    calls = []
    items = [photo(PRIMARY), photo(CHILD, tags=[{"value": "GenzoRoom"}]), photo(SOLO)]

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/api/stacks":
            return httpx.Response(200, json=[{"id": STACK, "primaryAssetId": PRIMARY,
                                            "assets": [{"id": PRIMARY}, {"id": CHILD}]}])
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=[{"id": TAG, "value": "GenzoRoom", "name": "GenzoRoom"}])
        body = json.loads(request.content)
        if "tagIds" in body["filter"]:
            assert body["filter"]["tagIds"] == {"any": [TAG]}
            assert {entry["id"]["eq"] for entry in body["filter"]["or"]} == {PRIMARY, SOLO}
            return httpx.Response(200, json={"assets": {"items": [photo(SOLO), *([photo(PRIMARY)] if primary_tagged else [])], "nextCursor": None}})
        return httpx.Response(200, json={"assets": {"items": items, "nextCursor": None}})

    assets = asyncio.run(get_recent_assets("http://immich.example", "key", transport=httpx.MockTransport(handler)))
    assert [str(asset.id) for asset in assets] == [PRIMARY, SOLO]
    assert assets[0].isGenzoRoomExport is primary_tagged
    assert assets[1].isGenzoRoomExport is True
    assert calls == [("POST", "/api/search/metadata"), ("GET", "/api/stacks"),
                     ("GET", "/api/tags"), ("POST", "/api/search/metadata")]


def test_existing_tag_payload_needs_no_additional_request():
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/api/stacks":
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"assets": {"items": [photo(SOLO, tags=[{"value": "GenzoRoom"}])], "nextCursor": None}})

    assets = asyncio.run(get_recent_assets("http://immich.example", "key", transport=httpx.MockTransport(handler)))
    assert assets[0].isGenzoRoomExport is True
    assert calls == ["/api/search/metadata", "/api/stacks"]


@pytest.mark.parametrize("tag_response", [httpx.Response(403), httpx.Response(500),
    httpx.Response(200, json={}), httpx.Response(200, content=b"{"),
    httpx.Response(200, json=[{"value": "GenzoRoom", "id": "bad"}])])
def test_tag_failure_preserves_home_photos_and_leaves_identity_unknown(tag_response):
    def handler(request):
        if request.url.path == "/api/stacks":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/tags":
            return tag_response
        return httpx.Response(200, json={"assets": {"items": [photo(SOLO)], "nextCursor": None}})

    assets = asyncio.run(get_recent_assets("http://immich.example", "key", transport=httpx.MockTransport(handler)))
    assert len(assets) == 1
    assert assets[0].isGenzoRoomExport is None


def test_large_home_collection_uses_bounded_batches():
    items = [photo(str(UUID(int=i + 10))) for i in range(501)]
    batch_sizes = []

    def handler(request):
        if request.url.path == "/api/stacks":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=[{"id": TAG, "value": "GenzoRoom"}])
        body = json.loads(request.content)
        if "tagIds" in body["filter"]:
            batch_sizes.append(len(body["filter"]["or"]))
            return httpx.Response(200, json={"assets": {"items": [], "nextCursor": None}})
        return httpx.Response(200, json={"assets": {"items": items, "nextCursor": None}})

    assets = asyncio.run(get_favorite_assets("http://immich.example", "key", transport=httpx.MockTransport(handler)))
    assert len(assets) == 501
    assert all(asset.isGenzoRoomExport is False for asset in assets)
    assert batch_sizes == [500, 1]
