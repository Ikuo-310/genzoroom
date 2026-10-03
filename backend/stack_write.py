"""Explicit Stack writes; no retries or cross-request transaction assumptions."""
from typing import Literal
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

from immich import IMMICH_TIMEOUT, ImmichRequestError, _api_url, _get_asset_stacks, _request_error, _require_configuration


class StackOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str = Field(min_length=1, max_length=200)
    type: Literal["create", "update", "delete"]
    stackId: UUID | None = None
    memberIds: list[UUID] | None = Field(default=None, max_length=1000)
    primaryAssetId: UUID | None = None

    @model_validator(mode="after")
    def validate_operation(self):
        if (self.type == "create") != (self.stackId is None):
            raise ValueError("Invalid Stack ID for operation")
        if self.type == "delete":
            if self.memberIds is not None or self.primaryAssetId is not None:
                raise ValueError("Delete accepts no members or primary")
        elif self.memberIds is None or len(self.memberIds) < 2 or len(set(self.memberIds)) != len(self.memberIds) or self.primaryAssetId not in self.memberIds:
            raise ValueError("Invalid members or primary")
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
            for member in op.memberIds or []:
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


class StackApplyResponse(BaseModel):
    results: list[StackWriteResult]


def _validate_written(response, op, expected_id=None):
    body = response.json()
    stack_id = UUID(body["id"])
    primary = UUID(body["primaryAssetId"])
    ids = [UUID(asset["id"]) for asset in body["assets"]]
    if (expected_id is not None and stack_id != expected_id) or primary != op.primaryAssetId or len(set(ids)) != len(ids) or set(ids) != set(op.memberIds):
        raise ValueError("Inconsistent write response")
    return stack_id


async def apply_stacks(immich_url, api_key, payload: StackApplyRequest, *, transport=None):
    ops = payload.operations
    if not ops:
        return StackApplyResponse(results=[])
    try:
        url, key = _require_configuration(immich_url, api_key)
        stacks = await _get_asset_stacks(url, key, transport=transport)
    except ImmichRequestError as error:
        return StackApplyResponse(results=[StackWriteResult(operationId=op.operationId, status="failed", errorCode=error.error_code) for op in ops])
    lookup = {UUID(stack["id"]): stack for stack in stacks}
    owners = {UUID(asset["id"]): UUID(stack["id"]) for stack in stacks for asset in stack["assets"]}
    results = {}
    released = set()
    replacements = set()
    headers = {"x-api-key": key, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=IMMICH_TIMEOUT, trust_env=False, follow_redirects=False, transport=transport) as client:
        async def write(op, method, path, body=None, expected_id=None):
            try:
                response = await client.request(method, _api_url(url, path), headers=headers, json=body)
                expected_status = 204 if method == "DELETE" else 201 if method == "POST" else 200
                if response.status_code != expected_status:
                    # A returned error is definite; malformed/redirected success cannot establish outcome.
                    status = "failed" if response.status_code >= 400 else "unknown"
                    return StackWriteResult(operationId=op.operationId, status=status, errorCode=_request_error(response).error_code)
                stack_id = None if method == "DELETE" else _validate_written(response, op, expected_id)
                return StackWriteResult(operationId=op.operationId, status="success", stackId=stack_id)
            except (httpx.RequestError, httpx.InvalidURL):
                return StackWriteResult(operationId=op.operationId, status="unknown", errorCode="unreachable")
            except (ValueError, KeyError, TypeError, AttributeError):
                # The write may have committed despite an unusable success body.
                return StackWriteResult(operationId=op.operationId, status="unknown", errorCode="unexpected_response")

        # Release all changing memberships first, including cycles between two updated Stacks.
        # v3.2.4 PUT changes only primary; membership updates require delete then create.
        for op in ops:
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
            elif op.type == "create" or op.operationId in replacements:
                ordered = [op.primaryAssetId, *[member for member in op.memberIds if member != op.primaryAssetId]]
                results[op.operationId] = await write(op, "POST", "/stacks", {"assetIds": [str(member) for member in ordered]})
            else:
                results[op.operationId] = await write(op, "PUT", f"/stacks/{op.stackId}", {"primaryAssetId": str(op.primaryAssetId)}, op.stackId)
            if op.operationId in replacements:
                results[op.operationId].releasedStackId = op.stackId
    return StackApplyResponse(results=[results[op.operationId] for op in ops])
