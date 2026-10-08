import asyncio
import json
from uuid import UUID

import httpx
import pytest

from immich import get_recent_assets, get_favorite_assets, _search_assets, _attach_home_stack_metadata, _parse_stack_snapshot, _with_home_export_tags

PRIMARY, CHILD, SOLO, STACK, TAG = [str(UUID(int=i)) for i in range(1, 6)]


def photo(asset_id, **metadata):
    return {"id": asset_id, "type": "IMAGE", "originalFileName": "ordinary.jpg",
            "fileCreatedAt": "2026-10-01T00:00:00Z", **metadata}


@pytest.mark.parametrize("fail", [False, True])
def test_gallery_member_tags_are_atomic_and_deduplicate_covers_across_100_stacks(fail):
    members = [photo(str(UUID(int=1000 + index))) for index in range(505)]
    snapshots = [{"id": str(UUID(int=2000 + index)), "primaryAssetId": members[index * 5]["id"],
                  "assets": members[index * 5:index * 5 + 5]} for index in range(101)]
    covers = _attach_home_stack_metadata(_search_assets({"assets": {"items": members}}),
                                        _parse_stack_snapshot(snapshots, require_primary=False))
    batches = []

    def handler(request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=[{"id": TAG, "value": "GenzoRoom"}])
        ids = [entry["id"]["eq"] for entry in json.loads(request.content)["filter"]["or"]]
        batches.append(ids)
        if fail and len(batches) == 2:
            return httpx.Response(500)
        return httpx.Response(200, json={"assets": {"items": [photo(ids[0])], "nextCursor": None}})

    result = asyncio.run(_with_home_export_tags("http://immich.example", "key", covers, transport=httpx.MockTransport(handler)))
    assert len(result) == 101
    assert [len(batch) for batch in batches] == [500, 5]
    assert len(set(identifier for batch in batches for identifier in batch)) == 505
    if fail:
        assert all(cover.stackMembers is None and cover.isGenzoRoomExport is None for cover in result)
    else:
        assert all(len(cover.stackMembers) == 5 for cover in result)
        assert sum(member.isGenzoRoomExport for cover in result for member in cover.stackMembers) == 2


@pytest.mark.parametrize("invalid", [{"originalFileName": None}, {"fileCreatedAt": None}, {"type": "VIDEO"}])
def test_bad_member_detail_preserves_display_without_candidate_list(invalid):
    snapshot = [{"id": STACK, "primaryAssetId": PRIMARY, "assets": [photo(PRIMARY), photo(CHILD, **invalid)]}]
    result = _attach_home_stack_metadata(_search_assets({"assets": {"items": [photo(PRIMARY)]}}),
                                        _parse_stack_snapshot(snapshot, require_primary=False))
    assert len(result) == 1 and result[0].stackMemberIds == [UUID(PRIMARY), UUID(CHILD)]
    assert result[0].stackMembers is None


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
