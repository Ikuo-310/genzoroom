"""Explicit Stack writes; no retries or cross-request transaction assumptions."""
from collections.abc import Mapping
from typing import Literal
from uuid import UUID, uuid4

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend_logging import backend_logger
from immich import (
    IMMICH_TIMEOUT, ImmichRequestError, classify_image_format, _get_asset_stacks, _immich_request, _parse_stack_snapshot,
    _log_response_failure, _request_error, _require_configuration, _stack_uuid,
)


class StackOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str = Field(min_length=1, max_length=200)
    type: Literal["create", "update", "delete"]
    stackId: UUID | None = None
    memberIds: list[UUID] | None = Field(default=None, max_length=1000)
    primaryAssetId: UUID | None = None

    trashAssetIds: list[UUID] = Field(default_factory=list, max_length=1000)
    expectedMemberIds: list[UUID] | None = Field(default=None, max_length=1000)
    expectedPrimaryAssetId: UUID | None = None

    @model_validator(mode="after")
    def validate_operation(self):
        if (self.type == "create") != (self.stackId is None):
            raise ValueError("Invalid Stack ID for operation")
        if self.type == "delete":
            if self.memberIds is not None or self.primaryAssetId is not None:
                raise ValueError("Delete accepts no members or primary")
        elif self.memberIds is None or len(self.memberIds) < (1 if self.trashAssetIds else 2) or len(set(self.memberIds)) != len(self.memberIds) or self.primaryAssetId not in self.memberIds:
            raise ValueError("Invalid members or primary")
        if self.trashAssetIds:
            if self.type == "delete" or len(set(self.trashAssetIds)) != len(self.trashAssetIds) or set(self.trashAssetIds) & set(self.memberIds or []):
                raise ValueError("Invalid trash membership")
            if not self.expectedMemberIds or len(set(self.expectedMemberIds)) != len(self.expectedMemberIds) or not set(self.trashAssetIds) <= set(self.expectedMemberIds):
                raise ValueError("Missing trash source")
            if self.expectedPrimaryAssetId not in self.expectedMemberIds or self.expectedPrimaryAssetId in self.trashAssetIds or self.primaryAssetId in self.trashAssetIds:
                raise ValueError("Protected primary")
        elif self.expectedMemberIds is not None or self.expectedPrimaryAssetId is not None:
            raise ValueError("Unexpected trash source")
        return self


class StackApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operations: list[StackOperation] = Field(max_length=500)

    @model_validator(mode="after")
    def validate_batch(self):
        operations, stacks, members = set(), set(), set()
        for op in self.operations:
            if op.operationId in operations or (op.stackId is not None and op.stackId in stacks):
                raise ValueError("Duplicate operation or Stack")
            operations.add(op.operationId)
            if op.stackId is not None:
                stacks.add(op.stackId)
            for member in [*(op.memberIds or []), *op.trashAssetIds]:
                if member in members:
                    raise ValueError("Duplicate final membership")
                members.add(member)
        return self


class StackWriteResult(BaseModel):
    operationId: str
    status: Literal["success", "failed", "unknown", "blocked"]
    stackId: UUID | None = None
    releasedStackId: UUID | None = None
    errorCode: str | None = None
    trashStatus: Literal["success", "failed", "unknown", "blocked"] | None = None


class StackApplyResponse(BaseModel):
    results: list[StackWriteResult]


def _log_operation(op, event, *, level="debug", **context):
    if backend_logger.get_level() == "off":
        return
    base = {"operationId": op.operationId, "type": op.type, **context}
    if op.stackId is not None:
        base.setdefault("stackId", str(op.stackId))
    if op.primaryAssetId is not None:
        base["requestedPrimaryAssetId"] = str(op.primaryAssetId)
    lists = {key: value for key, value in base.items() if isinstance(value, list)}
    base = {key: value for key, value in base.items() if key not in lists}
    # Keep complete membership evidence within the logger's depth/node/byte limits.
    # Shared operation/request IDs and chunkIndex allow report consumers to reconstruct it.
    chunks = max([1, *[(len(value) + 7) // 8 for value in lists.values()]])
    for index in range(chunks):
        fields = {**base, **{key: value[index * 8:(index + 1) * 8] for key, value in lists.items()}}
        if chunks > 1:
            fields.update(chunkIndex=index, chunkCount=chunks)
        backend_logger.add(level=level, component="stack_write", event=event, context=fields)


def _validate_written(response, op, expected_id=None):
    trace = response.extensions.get("genzoroom_diagnostics", {}).get("context", {})
    try:
        body = response.json()
        stack_id = UUID(body["id"])
        primary = UUID(body["primaryAssetId"])
        ids = [UUID(asset["id"]) for asset in body["assets"]]
    except (ValueError, KeyError, TypeError, AttributeError):
        _log_operation(op, "operation.response", level="warn", **trace, httpStatus=response.status_code,
                       validationResult="invalid_response", requestedMemberIds=[str(member) for member in op.memberIds])
        raise
    matches = not ((expected_id is not None and stack_id != expected_id) or primary != op.primaryAssetId
                   or len(set(ids)) != len(ids) or set(ids) != set(op.memberIds))
    _log_operation(op, "operation.response", level="debug" if matches else "warn", **trace,
                   httpStatus=response.status_code, stackId=str(stack_id), responsePrimaryAssetId=str(primary),
                   requestedMemberIds=[str(member) for member in op.memberIds], responseMemberIds=[str(member) for member in ids],
                   validationResult="matched" if matches else "mismatch")
    if not matches:
        raise ValueError("Inconsistent write response")
    return stack_id


async def _verify_created(client, url, headers, op, stack_id, batch_id):
    context = {"batchId": batch_id, "requestId": uuid4().hex, "stackId": str(stack_id),
               "expectedMemberIds": [str(member) for member in op.memberIds]}
    response = None
    # Verification is diagnostic only: unreadable or mismatched state cannot reverse a committed POST.
    try:
        response = await _immich_request(client, "GET", url, f"/stacks/{stack_id}",
                                         request_id=context["requestId"], batch_id=batch_id, operation_id=op.operationId, headers=headers)
        if response.status_code != 200:
            raise _request_error(response)
        body = response.json()
        actual_stack = UUID(body["id"])
        primary = UUID(body["primaryAssetId"])
        members = [UUID(member["id"]) for member in body["assets"]]
        matches = actual_stack == stack_id and primary == op.primaryAssetId and len(members) == len(set(members)) and set(members) == set(op.memberIds)
        _log_operation(op, "create.verify", level="debug" if matches else "warn", **context,
                       httpStatus=response.status_code, actualStackId=str(actual_stack), primaryAssetId=str(primary),
                       actualMemberIds=[str(member) for member in members], matches=matches)
    except (httpx.RequestError, httpx.InvalidURL, ImmichRequestError, ValueError, KeyError, TypeError, AttributeError) as error:
        if isinstance(error, ImmichRequestError):
            code = error.error_code
        elif isinstance(error, (httpx.RequestError, httpx.InvalidURL)):
            code = "unreachable"
        else:
            code = "unexpected_response"
        if response is not None:
            _log_response_failure(response, code)
            context["httpStatus"] = response.status_code
        _log_operation(op, "verify.failed", level="warn", **context, errorCode=code)


def _operation_results(ops, results, batch_id):
    counts = {status: sum(result.status == status for result in results) for status in ("success", "failed", "unknown", "blocked")}
    for op, result in zip(ops, results):
        fields = {"batchId": batch_id, "status": result.status}
        for field in ("stackId", "releasedStackId", "errorCode", "trashStatus"):
            value = getattr(result, field)
            if value is not None:
                fields[field] = str(value)
        # Failed/unknown writes are terminal for this requested operation; dependency blocks are recoverable.
        severity = "error" if result.status in ("failed", "unknown") else "warn" if result.status == "blocked" else "error" if result.trashStatus in ("failed", "unknown", "blocked") else "info"
        _log_operation(op, "operation.result", level=severity, **fields)
    trash_failures = sum(result.trashStatus in ("failed", "unknown", "blocked") for result in results)
    overall = "success" if counts["success"] == len(results) and not trash_failures else "partial_failure" if counts["success"] else "failure"
    # A retained final summary still explains large batches whose detailed evidence has overflowed.
    backend_logger.add(level="info" if overall == "success" else "warn" if overall == "partial_failure" else "error",
                       component="stack_write", event="batch.result", context={
                           "batchId": batch_id, "operationCount": len(results), "successCount": counts["success"],
                           "failedCount": counts["failed"], "unknownCount": counts["unknown"],
                           "blockedCount": counts["blocked"], "trashFailureCount": trash_failures, "overallResult": overall,
                       })
    return StackApplyResponse(results=results)


async def apply_stacks(immich_url, api_key, payload: StackApplyRequest, *, transport=None):
    ops = payload.operations
    if not ops:
        return StackApplyResponse(results=[])
    batch_id = uuid4().hex
    backend_logger.add(level="debug", component="stack_write", event="batch.start",
                       context={"batchId": batch_id, "operationCount": len(ops)})
    try:
        url, key = _require_configuration(immich_url, api_key)
        snapshot = _parse_stack_snapshot(
            await _get_asset_stacks(url, key, transport=transport, batch_id=batch_id), require_primary=True,
        )
    except ImmichRequestError as error:
        return _operation_results(ops, [StackWriteResult(operationId=op.operationId, status="failed", errorCode=error.error_code) for op in ops], batch_id)
    stacks = snapshot.stacks
    lookup = {UUID(stack["id"]): stack for stack in stacks}
    owners = {UUID(asset["id"]): UUID(stack["id"]) for stack in stacks for asset in stack["assets"]}
    # Quarantined ownership can fail one operation without authorizing a steal or blocking unrelated work.
    results = {
        op.operationId: StackWriteResult(operationId=op.operationId, status="failed", errorCode="unexpected_response")
        for op in ops if op.stackId in snapshot.invalid_stack_ids
        or any(member in snapshot.quarantined_member_ids for member in [*(op.memberIds or []), *op.trashAssetIds])
    }
    released = set()
    replacements = set()
    headers = {"x-api-key": key, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, trust_env=False, follow_redirects=False, transport=transport) as client:
        async def write(op, method, path, body=None, expected_id=None):
            request_id = uuid4().hex
            _log_operation(op, "operation.start", batchId=batch_id, requestId=request_id, method=method, endpoint=path,
                           memberIds=[str(member) for member in op.memberIds] if op.memberIds is not None else [])
            response = None
            try:
                expected_status = 204 if method == "DELETE" else 201 if method == "POST" else 200
                response = await _immich_request(client, method, url, path, expected_status=expected_status,
                                                 request_id=request_id, batch_id=batch_id, operation_id=op.operationId, headers=headers, json=body)
                if response.status_code != expected_status:
                    _log_operation(op, "operation.response", level="warn", batchId=batch_id, requestId=request_id, method=method,
                                   endpoint=path, httpStatus=response.status_code, errorCode=_request_error(response).error_code)
                    # A returned error is definite; malformed/redirected success cannot establish outcome.
                    status = "failed" if response.status_code >= 400 else "unknown"
                    return StackWriteResult(operationId=op.operationId, status=status, errorCode=_request_error(response).error_code)
                stack_id = None if method == "DELETE" else _validate_written(response, op, expected_id)
                if method == "DELETE":
                    _log_operation(op, "operation.response", batchId=batch_id, requestId=request_id, method=method, endpoint=path, httpStatus=response.status_code)
                elif method == "POST" and backend_logger.get_level() == "debug":
                    await _verify_created(client, url, headers, op, stack_id, batch_id)
                return StackWriteResult(operationId=op.operationId, status="success", stackId=stack_id)
            except (httpx.RequestError, httpx.InvalidURL):
                return StackWriteResult(operationId=op.operationId, status="unknown", errorCode="unreachable")
            except (ValueError, KeyError, TypeError, AttributeError):
                if response is not None:
                    _log_response_failure(response, "unexpected_response")
                # The write may have committed despite an unusable success body.
                return StackWriteResult(operationId=op.operationId, status="unknown", errorCode="unexpected_response")

        async def asset_state(op, asset_id):
            response = await _immich_request(client, "GET", url, f"/assets/{asset_id}", headers=headers,
                                             batch_id=batch_id, operation_id=op.operationId, request_id=uuid4().hex)
            if response.status_code != 200:
                raise _request_error(response)
            body = response.json()
            if UUID(body["id"]) != asset_id or not isinstance(body.get("originalFileName"), str) or not body["originalFileName"] or not isinstance(body.get("isTrashed"), bool):
                raise ValueError("Unusable asset state")
            if classify_image_format(body["originalFileName"])[1] or body["isTrashed"]:
                raise ValueError("Protected or already trashed asset")
            return body

        # Validate reservation provenance before releasing any Stack, including current COVER and RAW.
        for op in ops:
            if not op.trashAssetIds or op.operationId in results:
                continue
            try:
                old = lookup.get(op.stackId) if op.stackId else None
                if op.stackId and (old is None or {UUID(a["id"]) for a in old["assets"]} != set(op.expectedMemberIds)
                                   or UUID(old["primaryAssetId"]) != op.expectedPrimaryAssetId):
                    raise ValueError("Changed source Stack")
                for asset_id in op.trashAssetIds:
                    body = await asset_state(op, asset_id)
                    owner = owners.get(asset_id)
                    if owner != op.stackId or (body.get("stack") is not None and UUID(body["stack"]["id"]) != op.stackId):
                        raise ValueError("Changed asset ownership")
                    # The detail response can be newer than the batch's initial Stack snapshot.
                    if op.stackId and (body.get("stack") is None
                                       or UUID(body["stack"]["primaryAssetId"]) != op.expectedPrimaryAssetId):
                        raise ValueError("Changed source primary")
            except (httpx.RequestError, httpx.InvalidURL, ImmichRequestError, ValueError, KeyError, TypeError, AttributeError):
                results[op.operationId] = StackWriteResult(operationId=op.operationId, status="failed", errorCode="trash_preflight_failed")

        # Release all changing memberships first, including cycles between two updated Stacks.
        # v3.2.4 PUT changes only primary; membership updates require delete then create.
        for op in ops:
            if op.operationId in results:
                continue
            if op.type == "create":
                continue
            old = lookup.get(op.stackId)
            if old is None:
                results[op.operationId] = StackWriteResult(operationId=op.operationId, status="failed", errorCode="stack_missing")
                continue
            old_ids = {UUID(asset["id"]) for asset in old["assets"]}
            if op.type == "delete" or old_ids != set(op.memberIds):
                result = await write(op, "DELETE", f"/stacks/{op.stackId}")
                if result.status == "success":
                    released.add(op.stackId)
                    result.releasedStackId = op.stackId
                    if op.type == "update":
                        replacements.add(op.operationId)
                        continue
                results[op.operationId] = result
        for op in ops:
            if op.operationId in results:
                continue
            dependencies = {owners[member] for member in op.memberIds if member in owners and owners[member] != op.stackId}
            # Do not steal or merge assets from active or unsuccessfully released Stacks.
            if any(owner not in released for owner in dependencies):
                results[op.operationId] = StackWriteResult(operationId=op.operationId, status="blocked", errorCode="membership_dependency")
            elif len(op.memberIds) == 1 and op.trashAssetIds:
                results[op.operationId] = StackWriteResult(operationId=op.operationId, status="success")
            elif op.type == "create" or op.operationId in replacements:
                ordered = [op.primaryAssetId, *[member for member in op.memberIds if member != op.primaryAssetId]]
                results[op.operationId] = await write(op, "POST", "/stacks", {"assetIds": [str(member) for member in ordered]})
            else:
                results[op.operationId] = await write(op, "PUT", f"/stacks/{op.stackId}", {"primaryAssetId": str(op.primaryAssetId)}, op.stackId)
            if op.operationId in replacements:
                results[op.operationId].releasedStackId = op.stackId
        # Trash is a separate outcome: a committed Stack update is never rolled back or repeated.
        for op in ops:
            result = results[op.operationId]
            if not op.trashAssetIds:
                continue
            if result.status != "success":
                result.trashStatus = "blocked"
                continue
            step = "stack_list_fetch"
            try:
                raw_stacks = await _get_asset_stacks(url, key, transport=transport, batch_id=batch_id)
                step = "stack_list_parse"
                current = _parse_stack_snapshot(raw_stacks, require_primary=True)
                target_members = set(op.memberIds) | set(op.trashAssetIds)
                target_stacks = {stack_id for stack_id in (op.stackId, result.stackId) if stack_id is not None}
                related_invalid = current.invalid_stack_ids & target_stacks
                related_quarantined = current.quarantined_member_ids & target_members
                # Known, unrelated quarantined ownership is harmless. Missing identities cannot prove non-membership.
                unproven_entries = sum(
                    not isinstance(stack, Mapping)
                    or _stack_uuid(stack.get("id")) is None
                    or _stack_uuid(stack.get("primaryAssetId")) is None
                    or not isinstance(stack.get("assets"), list)
                    or any(not isinstance(asset, Mapping) or _stack_uuid(asset.get("id")) is None for asset in stack["assets"])
                    for stack in raw_stacks
                )
                snapshot_fields = {"invalidStackCount": len(current.invalid_stack_ids), "quarantinedMemberCount": len(current.quarantined_member_ids),
                                   "validStackCount": len(current.stacks), "relatedInvalidStackCount": len(related_invalid),
                                   "relatedQuarantinedMemberCount": len(related_quarantined), "unprovenOwnershipEntryCount": unproven_entries,
                                   "relatedInvalidStackIds": [str(stack_id) for stack_id in related_invalid],
                                   "relatedQuarantinedMemberIds": [str(asset_id) for asset_id in related_quarantined]}
                snapshot_ok = not related_invalid and not related_quarantined and not unproven_entries
                snapshot_reason = "unproven_stack_ownership" if unproven_entries else "related_invalid_or_quarantined_stack_state"
                _log_operation(op, "trash.verify", level="debug" if snapshot_ok else "error", batchId=batch_id,
                               verificationStep="stack_list_parse", passed=snapshot_ok, reason=None if snapshot_ok else snapshot_reason,
                               **snapshot_fields)
                if not snapshot_ok:
                    raise ValueError(snapshot_reason)
                current_owners = {UUID(a["id"]): UUID(stack["id"]) for stack in current.stacks for a in stack["assets"]}
                for asset_id in op.trashAssetIds:
                    step = "trash_asset_stack_membership"
                    owner_id = current_owners.get(asset_id)
                    passed = owner_id is None
                    _log_operation(op, "trash.verify", level="debug" if passed else "error", batchId=batch_id,
                                   verificationStep=step, passed=passed, reason=None if passed else "trash_asset_still_in_stack",
                                   assetId=str(asset_id), actualStackId=str(owner_id) if owner_id else None)
                    if not passed:
                        raise ValueError("trash_asset_still_in_stack")
                if len(op.memberIds) > 1:
                    step = "replacement_stack_exists"
                    surviving = next((stack for stack in current.stacks if UUID(stack["id"]) == result.stackId), None)
                    passed = surviving is not None
                    _log_operation(op, "trash.verify", level="debug" if passed else "error", batchId=batch_id,
                                   verificationStep=step, passed=passed, reason=None if passed else "replacement_stack_missing",
                                   expectedStackId=str(result.stackId), actualStackId=str(UUID(surviving["id"])) if surviving else None)
                    if not passed:
                        raise ValueError("replacement_stack_missing")
                    step = "replacement_stack_members"
                    actual_members = {UUID(a["id"]) for a in surviving["assets"]}
                    passed = actual_members == set(op.memberIds)
                    _log_operation(op, "trash.verify", level="debug" if passed else "error", batchId=batch_id,
                                   verificationStep=step, passed=passed, reason=None if passed else "replacement_members_mismatch",
                                   expectedMemberIds=[str(member) for member in op.memberIds],
                                   actualMemberIds=[str(member) for member in actual_members])
                    if not passed:
                        raise ValueError("replacement_members_mismatch")
                    step = "replacement_stack_primary"
                    actual_primary = UUID(surviving["primaryAssetId"])
                    passed = actual_primary == op.primaryAssetId
                    _log_operation(op, "trash.verify", level="debug" if passed else "error", batchId=batch_id,
                                   verificationStep=step, passed=passed, reason=None if passed else "replacement_primary_mismatch",
                                   expectedPrimaryAssetId=str(op.primaryAssetId), actualPrimaryAssetId=str(actual_primary))
                    if not passed:
                        raise ValueError("replacement_primary_mismatch")
                else:
                    step = "singleton_released"
                    actual_owner = current_owners.get(op.memberIds[0])
                    passed = actual_owner is None
                    _log_operation(op, "trash.verify", level="debug" if passed else "error", batchId=batch_id,
                                   verificationStep=step, passed=passed, reason=None if passed else "singleton_still_in_stack",
                                   assetId=str(op.memberIds[0]), actualStackId=str(actual_owner) if actual_owner else None)
                    if not passed:
                        raise ValueError("singleton_still_in_stack")
                for asset_id in op.trashAssetIds:
                    step = "trash_asset_detail_fetch"
                    body = await asset_state(op, asset_id)
                    step = "trash_asset_detail_stack"
                    actual_stack = body.get("stack")
                    actual_stack_id = None
                    if isinstance(actual_stack, dict) and actual_stack.get("id") is not None:
                        actual_stack_id = str(UUID(actual_stack["id"]))
                    passed = actual_stack is None
                    _log_operation(op, "trash.verify", level="debug" if passed else "error", batchId=batch_id,
                                   verificationStep=step, passed=passed, reason=None if passed else "asset_detail_still_stacked",
                                   assetId=str(asset_id), actualStackId=actual_stack_id,
                                   stackFieldState="absent" if "stack" not in body else "null" if actual_stack is None else "present")
                    if not passed:
                        raise ValueError("asset_detail_still_stacked")
            except (httpx.RequestError, httpx.InvalidURL, ImmichRequestError, ValueError, KeyError, TypeError, AttributeError) as error:
                details = {"batchId": batch_id, "verificationStep": step, "reason": str(error) if isinstance(error, ValueError) and str(error) in {
                    "related_invalid_or_quarantined_stack_state", "unproven_stack_ownership", "trash_asset_still_in_stack", "replacement_stack_missing",
                    "replacement_members_mismatch", "replacement_primary_mismatch", "singleton_still_in_stack", "asset_detail_still_stacked"} else "verification_exception",
                    "exceptionType": type(error).__name__}
                if isinstance(error, ImmichRequestError):
                    if error.status_code is None and error.error_code == "unexpected_response":
                        details["verificationStep"] = "stack_list_parse"
                    details["errorCode"] = error.error_code
                    if error.status_code is not None:
                        details["httpStatus"] = error.status_code
                elif isinstance(error, (httpx.RequestError, httpx.InvalidURL)):
                    details["errorCode"] = "unreachable"
                _log_operation(op, "trash.verify.failed", level="error", **details)
                result.trashStatus = "blocked"
                result.errorCode = "trash_verification_failed"
                _log_operation(op, "trash.result", level="error", batchId=batch_id, status="blocked", errorCode=result.errorCode)
                continue
            trash_result = await write(op, "DELETE", "/assets", {"ids": [str(asset_id) for asset_id in op.trashAssetIds], "force": False})
            result.trashStatus = trash_result.status
            result.errorCode = trash_result.errorCode
            _log_operation(op, "trash.result", level="info" if trash_result.status == "success" else "error",
                           batchId=batch_id, status=trash_result.status, assetCount=len(op.trashAssetIds), errorCode=trash_result.errorCode)
    return _operation_results(ops, [results[op.operationId] for op in ops], batch_id)
