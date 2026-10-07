"""Permission-safe GenzoRoom tag assignment shared by Export and Home repair."""

from collections.abc import Mapping
from uuid import UUID

from immich import _immich_request


async def assign_genzoroom_tag(client, url: str, headers: dict, asset_id: UUID) -> UUID:
    response = await _immich_request(client, "PUT", url, "/tags", headers=headers, json={"tags": ["GenzoRoom"]})
    tags = response.json()
    if response.status_code != 200 or not isinstance(tags, list) or len(tags) != 1 \
            or not isinstance(tags[0], Mapping) or tags[0].get("name") != "GenzoRoom" or tags[0].get("value") != "GenzoRoom":
        raise ValueError("invalid_tag_response")
    if type(tags[0].get("id")) is not str:
        raise ValueError("invalid_id")
    tag = UUID(tags[0]["id"])
    response = await _immich_request(client, "PUT", url, "/tags/assets", headers=headers,
        json={"tagIds": [str(tag)], "assetIds": [str(asset_id)]})
    tagged = response.json()
    if response.status_code != 200 or not isinstance(tagged, Mapping) or set(tagged) != {"count"} \
            or type(tagged["count"]) is not int or tagged["count"] not in (0, 1):
        raise ValueError("invalid_asset_tag_response")
    if tagged["count"] == 0:
        # v3.2.4 counts inserted associations; zero also needs permission-safe verification.
        response = await _immich_request(client, "GET", url, f"/assets/{asset_id}", headers=headers)
        asset = response.json()
        if response.status_code != 200 or not isinstance(asset, Mapping) \
                or type(asset.get("id")) is not str or UUID(asset["id"]) != asset_id \
                or not isinstance(asset.get("tags"), list) \
                or not any(isinstance(entry, Mapping) and entry.get("id") == str(tag) and entry.get("value") == "GenzoRoom" for entry in asset["tags"]):
            raise ValueError("tag_not_confirmed")
    return tag
