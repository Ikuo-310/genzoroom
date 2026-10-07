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
        if request.url.path == "/api/timeline/bucket":
            assert request.method == "GET"
            return httpx.Response(200, json={
                "id": [item["id"] for item in items], "isImage": [True] * len(items),
                "fileCreatedAt": [item["fileCreatedAt"] for item in items], "localOffsetHours": [0] * len(items),
            })
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
    if kind == "calendar" and not items:
        assert calls == ["/api/timeline/bucket"]
    else:
        assert calls == (["/api/timeline/bucket"] if kind == "calendar" else []) + ["/api/search/metadata"] * pages + ["/api/stacks"]
    return [a.model_dump(mode="json") for a in result]


@pytest.mark.parametrize("kind", KINDS)
def test_joins_primary_members_multiple_stacks_and_unstacked_assets(kind):
    items = [asset(i) for i in IDS[:5]]
    items[0]["originalFileName"] = "photo.jpg"
    # Membership comes from the list even if search metadata is stale.
    items[-1]["stack"] = {"id": STACK_ID, "primaryAssetId": IDS[0]}
    result = fetch(kind, items, [stack(), stack(SECOND_STACK_ID, IDS[3], [IDS[3]])])
    assert [item["id"] for item in result] == [IDS[0], IDS[3], IDS[4]]
    assert result[0]["stackId"] == STACK_ID
    assert result[0]["primaryAssetId"] == IDS[0]
    assert result[0]["stackAssetCount"] == 3
    assert result[0]["stackMemberIds"] == IDS[:3]
    assert result[1]["stackId"] == SECOND_STACK_ID
    assert result[1]["primaryAssetId"] == IDS[3]
    assert result[1]["stackAssetCount"] == 1
    assert result[2]["stackId"] is None
    assert result[2]["primaryAssetId"] is None
    assert result[2]["stackAssetCount"] is None
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
    result = fetch(kind, [asset(IDS[0])], [stack()], pages=2)
    assert len(result) == (1 if kind == "calendar" else 2)
    assert all(a["stackId"] == STACK_ID and a["stackAssetCount"] == 3 for a in result)


MALFORMED = [
    None, {}, "bad", [None], [{}],
    [stack() | {"id": "bad"}], [stack() | {"id": None}],
    [stack() | {"primaryAssetId": "bad"}], [stack() | {"primaryAssetId": 123}],
    [stack() | {"assets": None}], [stack() | {"assets": {}}],
    [stack() | {"assets": ["bad"]}], [stack() | {"assets": [{}]}],
    [stack() | {"assets": [{"id": "bad"}]}], [stack() | {"assets": [{"id": 123}]}],
    [stack() | {"assets": []}],
    [stack(), stack(SECOND_STACK_ID)], [stack(), stack()],
    [stack(member_ids=[IDS[0], IDS[0]])],
]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("body", MALFORMED)
def test_malformed_stack_entries_are_skipped_for_home(kind, body):
    if not isinstance(body, list):
        with pytest.raises(ImmichRequestError) as error:
            fetch(kind, [asset(IDS[0])], body)
        assert error.value.error_code == "unexpected_response"
        return

    unrelated = str(UUID(int=1000))
    result = fetch(kind, [asset(IDS[0]), asset(unrelated)], body)
    # Entries without any readable identity cannot quarantine unrelated photos.
    expected_ids = [IDS[0], unrelated] if body in ([None], [{}]) else [unrelated]
    assert [item["id"] for item in result] == expected_ids
    assert all(item["stackId"] is None for item in result)


@pytest.mark.parametrize("kind", KINDS)
def test_home_hides_remaining_member_when_stack_primary_is_missing(kind):
    valid = stack()
    incomplete = stack(SECOND_STACK_ID, IDS[3], [IDS[3]])
    incomplete["primaryAssetId"] = IDS[4]
    result = fetch(kind, [asset(i) for i in IDS[:4]], [valid, incomplete])

    assert [item["id"] for item in result] == [IDS[0]]
    assert result[0]["stackId"] == STACK_ID and result[0]["stackAssetCount"] == 3


@pytest.mark.parametrize("kind", KINDS)
def test_home_accepts_missing_primary_snapshot_but_hides_its_remaining_child(kind):
    missing_child = str(UUID(int=20))
    missing_primary = stack(SECOND_STACK_ID, IDS[4], [missing_child])
    items = [asset(IDS[0]), asset(IDS[1]), asset(IDS[2]), asset(missing_child), asset(IDS[6])]
    result = fetch(kind, items, [stack(), missing_primary])

    assert [item["id"] for item in result] == [IDS[0], IDS[6]]
    assert result[0]["stackId"] == STACK_ID
    assert result[1]["stackId"] is None


@pytest.mark.parametrize("kind", KINDS)
def test_home_skips_all_stacks_with_ambiguous_member_and_keeps_unrelated_stack(kind):
    overlapping = stack(SECOND_STACK_ID, IDS[0], [IDS[0], IDS[3]])
    unrelated_id = str(UUID(int=100))
    unrelated = stack(unrelated_id, IDS[4], [IDS[4], IDS[5]])
    result = fetch(kind, [asset(i) for i in IDS[:6]], [stack(), overlapping, unrelated])

    assert len(result) == 1
    assert result[0]["id"] == IDS[4]
    assert result[0]["stackId"] == unrelated_id
    assert result[0]["primaryAssetId"] == IDS[4]
    assert result[0]["stackAssetCount"] == 2


@pytest.mark.parametrize("kind", KINDS)
def test_home_skips_stack_with_duplicate_member_inside_entry(kind):
    duplicate_member = stack(member_ids=[IDS[0], IDS[0]])
    result = fetch(kind, [asset(IDS[0])], [duplicate_member])
    assert result == []


def test_home_stack_formats_use_primary_first_and_stable_unique_identity():
    members = [
        {"id": IDS[1], "originalFileName": "second.jpg"},
        {"id": IDS[2], "originalFileName": "third.jpeg"},
        {"id": IDS[0], "originalFileName": "cover.dng"},
        {"id": IDS[3], "originalFileName": "fourth.heic"},
        {"id": IDS[4], "originalFileName": "fifth.dng"},
    ]
    result = fetch("recent", [asset(i) for i in IDS[:5]], [stack(member_ids=IDS[:5]) | {"assets": members}])

    assert result[0]["stackFormats"] == [
        {"format": "DNG", "isRaw": True},
        {"format": "JPEG", "isRaw": False},
        {"format": "HEIC", "isRaw": False},
    ]
    assert len(result) == 1


def test_home_incomplete_stack_formats_do_not_hide_the_photo():
    incomplete = stack(member_ids=IDS[:2])
    incomplete["assets"][1]["originalFileName"] = "member.jpg"
    result = fetch("recent", [asset(IDS[0]), asset(IDS[1])], [incomplete])

    assert [item["id"] for item in result] == [IDS[0]]
    assert "stackFormats" not in result[0]


@pytest.mark.parametrize("invalid", [
    lambda: stack() | {"id": "bad"},
    lambda: stack() | {"primaryAssetId": "bad"},
    lambda: stack() | {"assets": [{"id": IDS[0]}, {"id": "bad"}]},
])
def test_unrelated_invalid_entry_preserves_healthy_primary_and_nonstack_dng(invalid):
    healthy = stack(SECOND_STACK_ID, IDS[3], IDS[3:5])
    independent = str(UUID(int=1000))
    result = fetch("recent", [asset(i) for i in [IDS[0], IDS[3], IDS[4], independent]], [invalid(), healthy])
    assert [item["id"] for item in result] == [IDS[3], independent]
    assert result[0]["stackMemberIds"] == IDS[3:5]
    assert result[1]["is_raw"] and result[1]["stackId"] is None


def test_duplicate_id_with_malformed_copy_and_valid_invalid_overlap_are_quarantined():
    healthy = stack(member_ids=IDS[:2])
    for invalid in [healthy | {"primaryAssetId": "bad"},
                    stack(SECOND_STACK_ID, IDS[2], [IDS[1], "bad"])]:
        result = fetch("recent", [asset(i) for i in IDS[:2]], [healthy, invalid])
        assert result == []


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
