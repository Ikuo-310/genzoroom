"""Immich v3.2.4 Export adapters; writes converge without deleting assets or tags."""

from collections.abc import Mapping
from datetime import datetime
from uuid import UUID

import httpx

from immich_tags import assign_genzoroom_tag
from export_artifact import filename_family
from export_runtime import RegistrationResult
from export_runtime_store import runtime_log
from immich import (IMMICH_TIMEOUT, ImmichAlbumError, add_asset_to_album, get_asset_album_ids,
                    _require_configuration, _immich_request, _get_asset_stacks, _parse_stack_snapshot)


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
        phase = "album_context"
        context_diagnostics = {"registeredAssetId": None, "stackStarted": False}
        trace = {"runId": str(context.run_id), "assetId": str(source.id), "sourceAssetId": str(source.id), "position": context.position}
        try:
            url, key = _require_configuration(self._url, self._key)
            headers = {"x-api-key": key, "Accept": "application/json"}
            async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, trust_env=False, follow_redirects=False, transport=self._transport) as client:
                runtime_log("registration.stepStarted", level="debug", **trace, phase=phase)
                # Resolve the source Stack and its Albums before upload so a missing COVER cannot inherit an empty source.
                album_ids = []
                album_id_set = set()
                source_album_ids = await get_asset_album_ids(
                    client, url, headers, source.id, batch_id=str(context.run_id), operation_id=str(source.id),
                )
                phase = "stack_context"
                raw_stack_context = await _get_asset_stacks(url, key, transport=self._transport, batch_id=str(context.run_id))
                source_snapshot = _parse_stack_snapshot(raw_stack_context, require_primary=True)
                if source.id in source_snapshot.quarantined_member_ids:
                    context_diagnostics.update({
                        "sourceQuarantined": True, "outputQuarantined": False,
                        "validStackCount": len(source_snapshot.stacks),
                        "invalidStackCount": len(source_snapshot.invalid_stack_ids),
                        "quarantinedMemberCount": len(source_snapshot.quarantined_member_ids),
                    })
                    raise ValueError("invalid_stack_context")
                source_owners = {UUID(member["id"]): stack for stack in source_snapshot.stacks for member in stack["assets"]}
                source_stack_context = source_owners.get(source.id)
                source_member_ids = ([UUID(member["id"]) for member in source_stack_context["assets"]]
                                     if source_stack_context is not None else [source.id])
                phase = "album_context"
                for member_id in source_member_ids:
                    if member_id == source.id:
                        member_albums = source_album_ids
                    else:
                        context_diagnostics["memberAssetId"] = str(member_id)
                        member_albums = await get_asset_album_ids(
                            client, url, headers, member_id, batch_id=str(context.run_id), operation_id=str(source.id),
                        )

                    for album_id in member_albums:
                        if album_id not in album_id_set:
                            album_id_set.add(album_id)
                            album_ids.append(album_id)
                context_diagnostics.pop("memberAssetId", None)
                phase = "upload"
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
                context_diagnostics["registeredAssetId"] = str(output)
                runtime_log("registration.uploadCompleted", **trace, registeredAssetId=str(output), result=body["status"])
                phase = "tag"
                tag = await assign_genzoroom_tag(client, url, headers, output)
                runtime_log("registration.tagCompleted", **trace, registeredAssetId=str(output), tagId=str(tag))
                phase = "album"
                for album_id in album_ids:
                    context_diagnostics["albumId"] = str(album_id)
                    result = await add_asset_to_album(client, url, headers, album_id, output)
                    runtime_log("registration.albumAdded", level="debug", **trace,
                                registeredAssetId=str(output), albumId=str(album_id), result=result, stackStarted=False)
                context_diagnostics.pop("albumId", None)
                # Bounded chunks preserve every inherited ID within the structured logger's context limits.
                for offset in range(0, max(1, len(album_ids)), 20):
                    runtime_log("registration.albumsInherited", **trace, registeredAssetId=str(output),
                                inheritedAlbumIds=[str(value) for value in album_ids[offset:offset + 20]],
                                albumCount=len(album_ids), offset=offset, stackStarted=False)
                phase = "stack_context"
                raw = await _get_asset_stacks(url, key, transport=self._transport, batch_id=str(context.run_id))
                snapshot = _parse_stack_snapshot(raw, require_primary=True)
                source_quarantined = source.id in snapshot.quarantined_member_ids
                output_quarantined = output in snapshot.quarantined_member_ids
                # Invalid entries preserve possible ownership; unrelated library defects must not block export.
                if source_quarantined or output_quarantined:
                    context_diagnostics.update({"sourceQuarantined": source_quarantined, "outputQuarantined": output_quarantined,
                        "validStackCount": len(snapshot.stacks), "invalidStackCount": len(snapshot.invalid_stack_ids),
                        "quarantinedMemberCount": len(snapshot.quarantined_member_ids)})
                    raise ValueError("invalid_stack_context")
                owners = {UUID(member["id"]): stack for stack in snapshot.stacks for member in stack["assets"]}
                source_stack, output_stack = owners.get(source.id), owners.get(output)
                current_source_members = ({UUID(member["id"]) for member in source_stack["assets"]}
                                          if source_stack is not None else None)
                expected_source_members = set(source_member_ids) if source_stack_context is not None else None
                if (source_stack_context is None) != (source_stack is None) or (
                    source_stack is not None and (
                        UUID(source_stack["id"]) != UUID(source_stack_context["id"])
                        or current_source_members != expected_source_members
                    )
                ):
                    raise ValueError("source_stack_changed")
                phase = "stack"
                # Making the output COVER before all Album writes succeed would hide the source from those Albums.
                context_diagnostics["stackStarted"] = True
                runtime_log("registration.stackStarted", level="debug", **trace, registeredAssetId=str(output))
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
                runtime_log("registration.completed", **trace, registeredAssetId=str(output), stackId=str(stack_id), stackStarted=True)
                return RegistrationResult(output)
        except Exception as error:
            if phase in ("album_context", "album"):
                context_diagnostics["reason"] = error.code if isinstance(error, ImmichAlbumError) else (
                    "unreachable" if isinstance(error, (httpx.RequestError, httpx.InvalidURL)) else "album_inheritance_failed")
                context_diagnostics["result"] = "failed"
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
