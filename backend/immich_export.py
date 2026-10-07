"""Immich v3.2.4 Export adapters; writes converge without deleting assets or tags."""

from collections.abc import Mapping
from datetime import datetime
from uuid import UUID

import httpx

from export_artifact import filename_family
from export_runtime import RegistrationResult
from export_runtime_store import runtime_log
from immich import IMMICH_TIMEOUT, _require_configuration, _immich_request, _get_asset_stacks, _parse_stack_snapshot


UPLOAD_TIMEOUT = httpx.Timeout(connect=10, read=120, write=120, pool=10)
MAX_FAMILY_PAGES = 10000


class ExportRegistrationError(Exception):
    code = "registration_failed"


def _uuid(value):
    if type(value) is not str:
        raise ValueError("invalid_id")
    return UUID(value)


def _date(value):
    if type(value) is not str:
        raise ValueError("invalid_date")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("invalid_date")
    return value


class ImmichFamilyFilenameProvider:
    def __init__(self, url, api_key, *, transport=None):
        self._url, self._key, self._transport = url, api_key, transport

    async def filenames(self, source, context):
        url, key = _require_configuration(self._url, self._key)
        root = filename_family(source.filename)
        if not root:
            raise ValueError("invalid_family")
        cursor, seen, names = None, set(), set()
        async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, trust_env=False, follow_redirects=False, transport=self._transport) as client:
            for page_index in range(MAX_FAMILY_PAGES):
                body = {"filter": {"type": {"eq": "IMAGE"}, "trashedAt": {"eq": None},
                                   "originalFileName": {"startsWith": root}},
                        "withStacked": True, "size": 1000,
                        "orderBy": {"field": "fileCreatedAt", "direction": "asc"}}
                if cursor is not None:
                    body["cursor"] = cursor
                response = await _immich_request(client, "POST", url, "/search/metadata",
                    headers={"x-api-key": key, "Accept": "application/json"}, json=body)
                if response.status_code != 200:
                    raise ValueError("family_search_failed")
                result = response.json()
                if not isinstance(result, Mapping) or not isinstance(result.get("assets"), Mapping):
                    raise ValueError("invalid_family_response")
                assets = result["assets"]
                items, next_cursor = assets["items"], assets["nextCursor"]
                if not isinstance(items, list) or len(items) > 1000:
                    raise ValueError("invalid_family_response")
                for item in items:
                    if not isinstance(item, Mapping) or item.get("type") != "IMAGE":
                        raise ValueError("invalid_family_response")
                    _uuid(item["id"])
                    name = item["originalFileName"]
                    if type(name) is not str or not name:
                        raise ValueError("invalid_family_response")
                    # Prefix filtering is only candidate discovery, including archived/stacked assets.
                    if item.get("trashedAt") is None and filename_family(name) == root:
                        names.add(name)
                runtime_log("family.pageRead", level="debug", runId=str(context.run_id), assetId=str(source.id),
                            pageCount=page_index + 1, candidateCount=len(items), familyCount=len(names))
                if next_cursor is None:
                    return sorted(names)
                if type(next_cursor) is not str or not next_cursor or not items or next_cursor in seen:
                    raise ValueError("invalid_family_cursor")
                seen.add(next_cursor); cursor = next_cursor
        raise ValueError("family_page_limit")


class ImmichExportRegistrar:
    def __init__(self, url, api_key, *, transport=None):
        self._url, self._key, self._transport = url, api_key, transport

    async def register(self, source, artifact, context):
        phase = "upload"
        context_diagnostics = {}
        trace = {"runId": str(context.run_id), "assetId": str(source.id), "position": context.position}
        try:
            url, key = _require_configuration(self._url, self._key)
            headers = {"x-api-key": key, "Accept": "application/json"}
            async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, trust_env=False, follow_redirects=False, transport=self._transport) as client:
                runtime_log("registration.stepStarted", level="debug", **trace, phase=phase)
                response = await _immich_request(client, "POST", url, "/assets", expected_status=(200, 201),
                    headers=headers, timeout=UPLOAD_TIMEOUT,
                    data={"filename": artifact.filename, "fileCreatedAt": _date(source.date),
                          "fileModifiedAt": _date(context.export_timestamp),
                          "isFavorite": source.is_favorite},
                    files={"assetData": (artifact.filename, artifact.jpeg, "image/jpeg")})
                body = response.json()
                if not isinstance(body, Mapping) or set(body) != {"status", "id"} \
                        or (response.status_code, body["status"]) not in ((201, "created"), (200, "duplicate")):
                    raise ValueError("invalid_upload_response")
                output = _uuid(body["id"])
                if output == source.id:
                    raise ValueError("registration_conflict")
                runtime_log("registration.uploadCompleted", **trace, registeredAssetId=str(output), result=body["status"])
                phase = "tag"
                response = await _immich_request(client, "PUT", url, "/tags", headers=headers, json={"tags": ["GenzoRoom"]})
                tags = response.json()
                if response.status_code != 200 or not isinstance(tags, list) or len(tags) != 1 \
                        or not isinstance(tags[0], Mapping) or tags[0].get("name") != "GenzoRoom" or tags[0].get("value") != "GenzoRoom":
                    raise ValueError("invalid_tag_response")
                tag = _uuid(tags[0]["id"])
                response = await _immich_request(client, "PUT", url, "/tags/assets", headers=headers,
                    json={"tagIds": [str(tag)], "assetIds": [str(output)]})
                tagged = response.json()
                if response.status_code != 200 or not isinstance(tagged, Mapping) or set(tagged) != {"count"} \
                        or type(tagged["count"]) is not int or tagged["count"] not in (0, 1):
                    raise ValueError("invalid_asset_tag_response")
                if tagged["count"] == 0:
                    # v3.2.4 counts inserted associations; zero also needs permission-safe verification.
                    response = await _immich_request(client, "GET", url, f"/assets/{output}", headers=headers)
                    asset = response.json()
                    if response.status_code != 200 or not isinstance(asset, Mapping) or _uuid(asset.get("id")) != output \
                            or not isinstance(asset.get("tags"), list) \
                            or not any(isinstance(entry, Mapping) and entry.get("id") == str(tag) and entry.get("value") == "GenzoRoom" for entry in asset["tags"]):
                        raise ValueError("tag_not_confirmed")
                runtime_log("registration.tagCompleted", **trace, registeredAssetId=str(output), tagId=str(tag))
                phase = "stack_context"
                raw = await _get_asset_stacks(url, key, transport=self._transport)
                snapshot = _parse_stack_snapshot(raw, require_primary=True)
                source_quarantined = source.id in snapshot.quarantined_member_ids
                output_quarantined = output in snapshot.quarantined_member_ids
                # Invalid entries preserve possible ownership; unrelated library defects must not block export.
                if source_quarantined or output_quarantined:
                    context_diagnostics = {"sourceQuarantined": source_quarantined, "outputQuarantined": output_quarantined,
                        "validStackCount": len(snapshot.stacks), "invalidStackCount": len(snapshot.invalid_stack_ids),
                        "quarantinedMemberCount": len(snapshot.quarantined_member_ids)}
                    raise ValueError("invalid_stack_context")
                owners = {UUID(member["id"]): stack for stack in snapshot.stacks for member in stack["assets"]}
                source_stack, output_stack = owners.get(source.id), owners.get(output)
                phase = "stack"
                if output_stack is not None:
                    if source_stack is None or output_stack["id"] != source_stack["id"]:
                        raise ValueError("registration_conflict")
                    stack_id = _uuid(output_stack["id"])
                    if _uuid(output_stack["primaryAssetId"]) != output:
                        response = await _immich_request(client, "PUT", url, f"/stacks/{stack_id}", headers=headers,
                            json={"primaryAssetId": str(output)})
                        self._verify_stack(response, 200, output, source.id,
                                           {UUID(member["id"]) for member in source_stack["assets"]}, expected_id=stack_id)
                else:
                    primary = _uuid(source_stack["primaryAssetId"]) if source_stack else source.id
                    old_members = {UUID(member["id"]) for member in source_stack["assets"]} if source_stack else {source.id}
                    # v3.2.4 POST absorbs the current primary's entire Stack transactionally.
                    response = await _immich_request(client, "POST", url, "/stacks", expected_status=201, headers=headers,
                        json={"assetIds": [str(output), str(primary)]})
                    stack_id = self._verify_stack(response, 201, output, source.id, old_members)
                runtime_log("registration.completed", **trace, registeredAssetId=str(output), stackId=str(stack_id))
                return RegistrationResult(output)
        except Exception:
            runtime_log("registration.stepFailed", level="error", **trace, phase=phase, errorCode="registration_failed", **context_diagnostics)
            raise ExportRegistrationError() from None

    @staticmethod
    def _verify_stack(response, status, output, source, old_members, expected_id=None):
        if response.status_code != status:
            raise ValueError("stack_write_failed")
        body = response.json()
        if not isinstance(body, Mapping):
            raise ValueError("invalid_stack_response")
        parsed = _parse_stack_snapshot([body], require_primary=True)
        if len(parsed.stacks) != 1:
            raise ValueError("invalid_stack_response")
        stack_id = _uuid(body["id"])
        members = {UUID(member["id"]) for member in body["assets"]}
        if expected_id is not None and stack_id != expected_id or _uuid(body["primaryAssetId"]) != output \
                or members != old_members | {output, source}:
            raise ValueError("stack_response_mismatch")
        return stack_id
