import asyncio
import json
from datetime import date
from uuid import UUID

import httpx
import pytest

from immich import (
    ImmichRequestError, get_album_assets, get_calendar_day_assets,
    get_favorite_assets, get_recent_assets,
)

KINDS = ["recent", "album", "calendar", "favorites"]
IDS = [str(UUID(int=i)) for i in range(1, 8)]
STACK_ID, SECOND_STACK_ID = IDS[5:7]


def asset(asset_id):
    return {"id": asset_id, "type": "IMAGE", "originalFileName": "photo.dng",
            "fileCreatedAt": "2026-09-01T12:00:00Z"}


def stack(stack_id=STACK_ID, primary_id=IDS[0], member_ids=None):
    return {"id": stack_id, "primaryAssetId": primary_id,
            "assets": [{"id": i} for i in (member_ids if member_ids is not None else IDS[:3])]}


def fetch(kind, items, stacks, *, pages=1):
    calls = []
    search_count = 0

    def handler(request):
        nonlocal search_count
        calls.append(request.url.path)
        assert request.headers["x-api-key"] == "key"
        assert request.headers["Accept"] == "application/json"
        if request.url.path == "/api/stacks":
            assert request.method == "GET"
            assert search_count == pages
            if isinstance(stacks, Exception):
                raise stacks
            return stacks if isinstance(stacks, httpx.Response) else httpx.Response(200, json=stacks)
        assert request.method == "POST"
        assert request.url.path == "/api/search/metadata"
        search_count += 1
        if search_count > 1:
            assert json.loads(request.content)["cursor"] == "next"
        return httpx.Response(200, json={"assets": {"items": items,
                              "nextCursor": "next" if search_count < pages else None}})

    options = {"transport": httpx.MockTransport(handler)}
    args = ("http://immich.example/api", "key")
    if kind == "recent":
        call = get_recent_assets(*args, **options)
    elif kind == "album":
        call = get_album_assets(*args, UUID(IDS[0]), **options)
    elif kind == "calendar":
        call = get_calendar_day_assets(*args, date(2026, 9, 1), **options)
    else:
        call = get_favorite_assets(*args, **options)
    result = asyncio.run(call)
    assert calls == ["/api/search/metadata"] * pages + ["/api/stacks"]
    return [a.model_dump(mode="json") for a in result]


@pytest.mark.parametrize("kind", KINDS)
def test_joins_primary_members_multiple_stacks_and_unstacked_assets(kind):
    items = [asset(i) for i in IDS[:5]]
    items[0]["originalFileName"] = "photo.jpg"
    # Membership comes from the list even if search metadata is stale.
    items[-1]["stack"] = {"id": STACK_ID, "primaryAssetId": IDS[0]}
    result = fetch(kind, items, [stack(), stack(SECOND_STACK_ID, IDS[3], [IDS[3]])])
    assert len(result) == 5
    for item in result[:3]:
        assert item["stackId"] == STACK_ID
        assert item["primaryAssetId"] == IDS[0]
        assert item["stackAssetCount"] == 3
    assert result[0]["id"] == result[0]["primaryAssetId"]
    assert result[3]["stackId"] == SECOND_STACK_ID
    assert result[3]["primaryAssetId"] == IDS[3]
    assert result[3]["stackAssetCount"] == 1
    assert result[4]["stackId"] is None
    assert result[4]["primaryAssetId"] is None
    assert result[4]["stackAssetCount"] is None
    assert result[0]["format"] == "JPEG" and not result[0]["is_raw"]
    assert all(a["format"] == "DNG" and a["is_raw"] for a in result[1:])
    assert "assets" not in result[0]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("items", [[], [asset(IDS[0])]])
def test_successful_empty_stack_list_returns_null_metadata(kind, items):
    result = fetch(kind, items, [])
    assert all(a["stackId"] is None and a["primaryAssetId"] is None and a["stackAssetCount"] is None for a in result)


@pytest.mark.parametrize("kind", ["album", "calendar", "favorites"])
def test_fetches_stacks_once_after_all_search_pages(kind):
    result = fetch(kind, [asset(IDS[1])], [stack()], pages=2)
    assert len(result) == 2
    assert all(a["stackId"] == STACK_ID and a["stackAssetCount"] == 3 for a in result)


MALFORMED = [
    None, {}, "bad", [None], [{}],
    [stack() | {"id": "bad"}], [stack() | {"id": None}],
    [stack() | {"primaryAssetId": "bad"}], [stack() | {"primaryAssetId": 123}],
    [stack() | {"assets": None}], [stack() | {"assets": {}}],
    [stack() | {"assets": ["bad"]}], [stack() | {"assets": [{}]}],
    [stack() | {"assets": [{"id": "bad"}]}], [stack() | {"assets": [{"id": 123}]}],
    [stack() | {"assets": []}], [stack(primary_id=IDS[4])],
    [stack(), stack(SECOND_STACK_ID)], [stack(), stack()],
    [stack(member_ids=[IDS[0], IDS[0]])],
]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("body", MALFORMED)
def test_malformed_stack_list_fails_entire_home_request(kind, body):
    with pytest.raises(ImmichRequestError) as error:
        fetch(kind, [asset(IDS[0])], body)
    assert error.value.error_code == "unexpected_response"


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("response,code", [
    (httpx.Response(401), "authentication_failed"),
    (httpx.Response(403), "authentication_failed"),
    (httpx.Response(500), "unexpected_response"),
    (httpx.Response(302), "unexpected_response"),
    (httpx.Response(200, content=b"{"), "unexpected_response"),
    (httpx.ConnectError("offline"), "unreachable"),
    (httpx.ReadTimeout("timeout"), "unreachable"),
])
def test_stack_api_failure_never_returns_unstacked_assets(kind, response, code):
    with pytest.raises(ImmichRequestError) as error:
        fetch(kind, [asset(IDS[0])], response)
    assert error.value.error_code == code
    if isinstance(response, httpx.Response) and response.status_code != 200:
        assert error.value.status_code == response.status_code
