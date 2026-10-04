import asyncio
from copy import deepcopy
from uuid import UUID
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from immich import ImmichRequestError, resolve_stacks
from main import app
from test_stack_assets import MALFORMED, asset, stack, IDS, STACK_ID, SECOND_STACK_ID


def full_stack(stack_id=STACK_ID, member_ids=None):
    ids = IDS[:2] if member_ids is None else member_ids
    return stack(stack_id, ids[0], ids) | {"assets": [asset(i) for i in ids]}


def resolve(body, requested=None):
    calls = []
    def handler(request):
        calls.append((request.method, request.url.path))
        assert request.headers["x-api-key"] == "key"
        if isinstance(body, Exception):
            raise body
        return body if isinstance(body, httpx.Response) else httpx.Response(200, json=body)
    result = asyncio.run(resolve_stacks("http://immich.example/api", "key",
        [UUID(i) for i in (requested if requested is not None else [STACK_ID])], transport=httpx.MockTransport(handler)))
    assert calls == [("GET", "/api/stacks")] if requested != [] else calls == []
    return result


def test_resolves_requested_full_stacks_once_in_request_and_member_order():
    first, second = full_stack(), full_stack(SECOND_STACK_ID, IDS[2:4])
    first["assets"][1]["originalFileName"] = "cover.JPG"
    result = resolve([second, first], [STACK_ID, SECOND_STACK_ID, STACK_ID])
    assert [str(s.id) for s in result] == [STACK_ID, SECOND_STACK_ID]
    assert [str(a.id) for a in result[0].assets] == IDS[:2]
    for resolved in result:
        for member in resolved.assets:
            assert member.stackId == resolved.id
            assert member.primaryAssetId == resolved.primaryAssetId
            assert member.stackAssetCount == 2
            assert member.thumbnail_url == f"/api/assets/{member.id}/thumbnail"
    assert result[0].assets[1].format == "JPEG" and not result[0].assets[1].is_raw
    assert resolve([second, first])[0].id == UUID(STACK_ID)


def test_empty_request_needs_no_upstream_request():
    assert resolve([], []) == []


@pytest.mark.parametrize("body", MALFORMED)
def test_reuses_home_membership_validation(body):
    with pytest.raises(ImmichRequestError) as error:
        resolve(body)
    assert error.value.error_code == "unexpected_response"


@pytest.mark.parametrize("mutation", ["unknown", "video", "missing_filename", "bad_date", "empty"])
def test_rejects_unknown_or_partial_editable_stacks(mutation):
    item = deepcopy(full_stack())
    if mutation == "unknown":
        item["id"] = SECOND_STACK_ID
    elif mutation == "video":
        item["assets"][1]["type"] = "VIDEO"
    elif mutation == "missing_filename":
        item["assets"][1].pop("originalFileName")
    elif mutation == "bad_date":
        item["assets"][1]["fileCreatedAt"] = None
    else:
        item["assets"] = []
    with pytest.raises(ImmichRequestError):
        resolve([item])


def test_resolves_singleton_image_snapshot_and_refreshes_it():
    item = full_stack(member_ids=IDS[:1])
    resolved = resolve([item])[0]
    assert len(resolved.assets) == 1
    member = resolved.assets[0]
    assert member.stackId == resolved.id == UUID(STACK_ID)
    assert member.primaryAssetId == resolved.primaryAssetId == UUID(IDS[0])
    assert member.stackAssetCount == 1
    refreshed = asyncio.run(resolve_stacks("http://immich.example", "key", [], asset_ids=[UUID(IDS[0])],
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[item]))))
    assert refreshed == [resolved]


def test_rejects_singleton_video_snapshot():
    item = full_stack(member_ids=IDS[:1])
    item["assets"][0]["type"] = "VIDEO"
    with pytest.raises(ImmichRequestError):
        resolve([item])


@pytest.mark.parametrize("response,code", [(httpx.Response(401), "authentication_failed"),
    (httpx.Response(403), "authentication_failed"), (httpx.Response(500), "unexpected_response"),
    (httpx.ConnectError("offline"), "unreachable")])
def test_propagates_upstream_errors(response, code):
    with pytest.raises(ImmichRequestError) as error:
        resolve(response)
    assert error.value.error_code == code


def test_route_validates_bounded_uuid_request_and_maps_errors():
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            with patch("main.resolve_stacks", new_callable=AsyncMock) as mocked:
                mocked.return_value = []
                for body in [{"stackIds": ["bad"]}, {"stackIds": [STACK_ID] * 101}, {"stackIds": [], "other": True}]:
                    assert (await client.post("/stacks/resolve", json=body)).status_code == 422
                mocked.assert_not_called()
                assert (await client.post("/stacks/resolve", json={"stackIds": [STACK_ID, STACK_ID]})).status_code == 200
                mocked.side_effect = ImmichRequestError("unexpected_response", "Immich returned an unexpected response.")
                assert (await client.post("/stacks/resolve", json={"stackIds": [STACK_ID]})).status_code == 502
    asyncio.run(run())

def test_refresh_finds_latest_stacks_by_asset_instead_of_stale_stack_id():
    body=[full_stack(SECOND_STACK_ID,IDS[:2])]
    result=asyncio.run(resolve_stacks('http://immich.example','key',[],asset_ids=[UUID(IDS[0])],transport=httpx.MockTransport(lambda request:httpx.Response(200,json=body))))
    assert str(result[0].id)==SECOND_STACK_ID
    result=asyncio.run(resolve_stacks('http://immich.example','key',[],asset_ids=[UUID(IDS[3])],transport=httpx.MockTransport(lambda request:httpx.Response(200,json=body))))
    assert result==[]
