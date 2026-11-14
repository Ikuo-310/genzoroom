"""Windows-only RAW editing, durable recipes and confirmed History operations."""

import asyncio
import hashlib
import json
import math
import re
import secrets
from time import monotonic
from uuid import UUID

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from lightcraft_mcp import LightCraftError
from lightcraft_raw import MAX_EDITS, MAX_IMAGE_BYTES, MAX_PREVIEW_SIDE, SUPERSEDED, _settings_json
from lightcraft_runtime import _await_task_resilient, lightcraft_log
from lightcraft_artifact import ENGINE_VERSION
from raw_source import RawSourceCache
from raw_controls import CONTROLS, control_location, controls_state, validate_controls, validate_history_operation
from thumbnail_lifecycle import mutate_raw_edits

REGENERATE_AFTER_EDITS = 200
MAX_JSON_BYTES = 4096
# Full-precision values plus 36 control specs and the History receipt exceed 4 KiB.
MAX_SETTINGS_RESPONSE_BYTES = 16384
# 200 steps can each expose 36 full-precision deltas; keep the listing bounded without truncation.
MAX_HISTORY_RESPONSE_BYTES = 1024 * 1024
HISTORY_CONFLICTS = {"raw_history_save_pending", "raw_history_commit_required", "raw_history_client_required",
                     "raw_history_not_initialized", "raw_history_revision_conflict", "raw_history_save_id_reused",
                     "raw_history_target_missing", "raw_history_readback_mismatch", "raw_history_baseline_mismatch",
                     "raw_history_step_id_reused", "raw_recipe_save_pending", "raw_history_requires_operation",
                     "raw_geometry_gesture_pending", "raw_geometry_outcome_unknown", "raw_geometry_request_conflict",
                     "raw_history_operation_outcome_unknown",
                     "raw_curve_interaction_pending", "raw_mixer_interaction_pending",
                     "raw_curve_interaction_stale", "raw_mixer_interaction_stale", "raw_mixer_interaction_sequence",
                     "raw_mixer_interaction_conflict"}
LEASE_SECONDS = 180
LEASE_POLL_SECONDS = 15


def _public_region_mapping_reason(mapping, revision, target):
    if not mapping:
        return "public_mapping_missing"
    if mapping[0] != revision or target["documentRevision"] != revision:
        return "public_revision_mismatch"
    if mapping[1] != target["geometryId"]:
        return "public_geometry_mismatch"
    return None


class _ImageResponse(Response):
    async def __call__(self, scope, receive, send):
        try:
            async with asyncio.timeout(90):
                await super().__call__(scope, receive, send)
        finally:
            self.release_lease()


class RawPreviewApi:
    def __init__(self):
        self.raw = self.manager = None
        self.thumbnail_scheduler = lambda: None
        self.cache = None
        self.workspace = self.document = None
        self._lock = asyncio.Lock()
        self._tasks = set()
        self._image_tasks = set()
        self._image_leases = set()
        self._response_leases = set()
        self._images_idle = asyncio.Event()
        self._images_idle.set()
        self._lease_tickets = {}
        self._preview_latest = {}
        self._region_geometry = {}
        self._wb_frames = {}
        self._history_tasks = set()
        self._closing = False
        self._lease_task = None
        self._close_task = None
        self._discard_task = None
        self._discard_request = None
        self._discarding = False
        self._touched = monotonic()
        self._workspace_state = "empty"
        self._native_released = False
        self.diagnostics_busy = lambda: False
        self._recipe_save = None
        self._history_save = None
        self._geometry_gesture = None
        self._history_identity = None
        self._recipe_recovery_baseline = None
        self._history_initialized = self._history_enabled = self._history_draining = False
        # A reset can outlive document release; retain its owner so the same request can retry safely.
        self._reset_asset_id = None
        self._reset_owner = None
        self.app = Starlette(routes=[
            Route("/capabilities", self.capabilities),
            Route("/lens-database", self.lens_database, methods=["GET", "POST"]),
            Route("/workspaces", self.endpoint, methods=["POST"]),
            Route("/workspaces/{workspace}", self.endpoint, methods=["DELETE"]),
            Route("/workspaces/{workspace}/discard", self.endpoint, methods=["POST"]),
            Route("/edit-status", self.endpoint, methods=["POST"]),
            Route("/assets/{asset_id}/edits/reset", self.endpoint, methods=["POST"]),
            Route("/documents", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}", self.endpoint, methods=["GET", "DELETE"]),
            Route("/documents/{handle}/preview", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/preview/cancel", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/region", self.endpoint, methods=["GET", "POST"]),
            Route("/documents/{handle}/region/cancel", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/settings", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/controls", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/geometry/begin", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/geometry", self.endpoint, methods=["POST"]),
            *[Route(f"/documents/{{handle}}/curve-interaction/{action}", self.endpoint, methods=["POST"])
              for action in ("begin", "update", "preview", "cancel")],
            *[Route(f"/documents/{{handle}}/mixer-interaction/{action}", self.endpoint, methods=["POST"])
              for action in ("begin", "update", "preview", "cancel")],
            Route("/documents/{handle}/recipe", self.endpoint, methods=["GET", "PUT"]),
            Route("/documents/{handle}/history", self.endpoint, methods=["GET"]),
            *[Route(f"/documents/{{handle}}/history/{action}", self.endpoint, methods=["POST"])
              for action in ("initialize", "commit", "undo", "redo", "jump", "recover", "operate")],
        ])

    def bind(self, raw, manager):
        self.raw, self.manager = raw, manager
        self._closing = False
        self._close_task = None

    async def lens_database(self, request):
        try:
            if request.method == "POST" and await self._body(request):
                raise LightCraftError("raw_invalid_request")
            self._ready()
            async with self._lock:
                status = await self.raw.lens_database_status()
                value = self._lens_database_state(status)
                if request.method == "POST":
                    if value["download"]["state"] == "running":
                        raise LightCraftError("raw_busy")
                    if self.manager.lensfun_override_configured():
                        raise LightCraftError("raw_lens_database_user_directory")
                    try:
                        result = await self.raw.download_lens_database()
                    except LightCraftError:
                        raise LightCraftError("raw_lens_database_download_failed") from None
                    if not isinstance(result, dict) or result.get("started") is not True or not isinstance(result.get("dir"), str):
                        raise LightCraftError("raw_lens_database_download_failed")
                    lightcraft_log("lensDatabase.download.started", level="info", generation=self.manager.status().generation,
                                   available=value["available"])
                    status = await self.raw.lens_database_status()
                    value = self._lens_database_state(status)
                return JSONResponse(value, headers={"Cache-Control": "no-store"})
        except LightCraftError as error:
            code = error.code
            if code not in {"raw_invalid_request", "raw_busy", "raw_unavailable", "raw_lens_database_user_directory",
                            "raw_lens_database_download_failed", "raw_invalid_lens_database_response"}:
                code = "raw_lens_database_unavailable"
            status = 400 if code == "raw_invalid_request" else 409 if code in {"raw_busy", "raw_lens_database_user_directory"} else 503 if code == "raw_unavailable" else 502
            lightcraft_log("lensDatabase.request.failed", level="warn" if status < 500 else "error",
                           generation=self.manager.status().generation if self.manager else None, errorCode=code)
            return JSONResponse({"code": code}, status_code=status, headers={"Cache-Control": "no-store"})
        except Exception:
            lightcraft_log("lensDatabase.request.failed", level="error", errorCode="raw_lens_database_unavailable")
            return JSONResponse({"code": "raw_lens_database_unavailable"}, status_code=503,
                                headers={"Cache-Control": "no-store"})

    def _lens_database_state(self, value):
        if not isinstance(value, dict) or not isinstance(value.get("download"), dict) or \
                value.get("dir") is not None and not isinstance(value.get("dir"), str) or \
                type(value.get("lenses")) is not int or value["lenses"] < 0:
            raise LightCraftError("raw_invalid_lens_database_response")
        download = value["download"]
        state = download.get("state")
        if state not in {"idle", "running", "done", "failed", "cancelled"}:
            raise LightCraftError("raw_invalid_lens_database_response")
        if state == "running":
            done, total = download.get("bytes"), download.get("total")
            if type(done) is not int or type(total) is not int or not 0 <= done <= total or total <= 0:
                raise LightCraftError("raw_invalid_lens_database_response")
            progress = {"state": state, "bytes": done, "total": total}
        elif state == "done":
            if type(download.get("files")) is not int or download["files"] <= 0:
                raise LightCraftError("raw_invalid_lens_database_response")
            progress = {"state": state, "files": download["files"]}
        else:
            progress = {"state": state}
        return {"available": value["lenses"] > 0, "lensCount": value["lenses"],
                "userDirectoryConfigured": self.manager.lensfun_override_configured(),
                "download": progress}

    def _ready(self):
        if self._closing or self.manager is None or self.manager.status().state != "ready":
            raise LightCraftError("raw_unavailable")

    async def capabilities(self, _request):
        status = self.manager.status() if self.manager else None
        region = {}
        if status and status.state == 'ready' and not self._closing:
            try:
                if await self.manager._raw_region_supported(status.generation):
                    region = {'regionContract':1}
            except LightCraftError:
                # Optional Region negotiation must not hide healthy B1 Whole availability.
                pass
        current = self.manager.status() if self.manager else None
        if current != status:
            region = {}
        status = current
        artifact = self.manager.artifact_info() if status and not self._closing else None
        return JSONResponse({"available": bool(status and status.state == "ready" and status.version == ENGINE_VERSION and artifact and not self._closing),
                             "state": status.state if status else "disabled", "version": status.version if status else None,
                             "artifact": artifact,
                             "workspaceState": self._workspace_state,
                             "cleanupPending": bool(self.cache and self.cache.cleanup_pending),
                             "maxSide": MAX_PREVIEW_SIDE, "maxImageBytes": MAX_IMAGE_BYTES, **region}, headers={"Cache-Control": "no-store"})

    async def _body(self, request):
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise LightCraftError("raw_invalid_request")
        data = bytearray()
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_JSON_BYTES:
                    raise LightCraftError("raw_request_too_large")
                data.extend(chunk)
        try:
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError, RecursionError):
            raise LightCraftError("raw_invalid_request") from None

    async def endpoint(self, request):
        region_owner_get = request.method == 'GET' and request.url.path.endswith('/region')
        if region_owner_get:
            lightcraft_log('region.owner.started', level='debug')
        try:
            body = await self._body(request) if request.method in {"POST", "PUT"} else {}
            if request.method == 'POST' and request.url.path.endswith('/discard'):
                return await self._discard(request, body)
            if request.method == "POST" and request.url.path.endswith("/edit-status"):
                if set(body) != {"assetIds"} or not isinstance(body["assetIds"], list) or len(body["assetIds"]) > 100:
                    raise LightCraftError("raw_invalid_request")
                try:
                    asset_ids = [UUID(value) for value in body["assetIds"]]
                except (ValueError, TypeError, AttributeError):
                    raise LightCraftError("raw_invalid_request") from None
                if len({str(asset_id) for asset_id in asset_ids}) != len(asset_ids):
                    raise LightCraftError("raw_invalid_request")
                from raw_recipe_store import get_raw_edit_statuses, InvalidRawRecipe, StoreUnavailable
                try:
                    edited = await run_in_threadpool(get_raw_edit_statuses, asset_ids)
                except (InvalidRawRecipe, StoreUnavailable):
                    raise LightCraftError("raw_recipe_unavailable") from None
                return JSONResponse({"edited": edited}, headers={"Cache-Control": "no-store"})
            if request.url.path.endswith("/preview/cancel"):
                return self._cancel_preview(request, body)
            if request.url.path.endswith("/region/cancel"):
                return self._cancel_region(request, body)
            curve_interaction = "/curve-interaction/" in request.url.path
            mixer_interaction = "/mixer-interaction/" in request.url.path
            region = request.url.path.endswith("/region") and request.method == "POST"
            preview = request.url.path.endswith("/preview") or region or request.url.path.endswith(("/curve-interaction/preview", "/mixer-interaction/preview"))
            if region:
                self._region_owner(request, body)
                target = body["target"]
                mapping = self._region_geometry.get((target["identity"]["kind"], target["quality"]))
                if mapping and mapping[:2] == (target["documentRevision"], target["geometryId"]):
                    self._replace_pending_region()
            if preview and not self._closing and not self._history_draining and len(self._image_leases) >= 3:
                self._replace_pending_image(request, body)
            if self._closing or self._history_draining or self._discarding or (len(self._image_leases) >= 3 if preview else len(self._tasks) >= 2):
                raise LightCraftError("raw_busy")
            # HTTP cancellation detaches the waiter, never a transmitted MCP operation.
            handler = self._region if region else self._curve_interaction if curve_interaction else self._mixer_interaction if mixer_interaction else self._preview if preview else self._execute
            lease = object() if preview else None
            raw_owner_handle = self._raw_handle if region else None
            task = asyncio.create_task(handler(request, body, lease) if preview else handler(request, body), name="windows-raw-before"
                                       if handler == self._preview and body.get("kind") == "before" else "windows-raw-request")
            if preview:
                self._image_leases.add(lease)
                self._image_tasks.add(task)
                def image_done(done):
                    self._image_tasks.discard(done)
                    if done.cancelled() or done.exception() is not None:
                        self._release_image_lease(lease)
                    else:
                        response = done.result()
                        if not isinstance(response, _ImageResponse):
                            self._release_image_lease(lease)
                task.add_done_callback(image_done)
            else:
                self._tasks.add(task)
                if not curve_interaction and not mixer_interaction:
                    control_owner = self.raw
                    control_owner.reserve_control()
                    task.add_done_callback(lambda _: control_owner.release_control())
            if request.method == "POST" and "/history/" in request.url.path:
                self._history_tasks.add(task)
            task.add_done_callback(self._done)
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                if preview:
                    if region:
                        try:
                            self.raw.cancel_region(raw_owner_handle, body["target"]["requestId"])
                        except LightCraftError:
                            pass  # Generation loss already invalidated the detached waiter.
                    # A detached HTTP waiter cannot own a response body that will never be sent.
                    task.add_done_callback(lambda _: self._release_image_lease(lease))
                raise
        except (LightCraftError, TimeoutError) as error:
            code = error.code if isinstance(error, LightCraftError) else "raw_request_timeout"
            if code == "lightcraft_invalid_preview":
                code = "raw_invalid_preview"
            status = (413 if code in {"raw_request_too_large", "raw_source_too_large", "raw_preview_budget_exceeded"} else
                      422 if code.startswith('raw_wb_') and code in {
                          'raw_wb_no_valid_samples', 'raw_wb_invalid_response', 'raw_wb_settings_mismatch',
                          'raw_wb_estimation_failed', 'raw_wb_source_unavailable', 'raw_wb_unsupported', 'raw_wb_stale_result',
                          'raw_wb_geometry_mismatch', 'raw_wb_point_outside_source', 'raw_wb_connection_failed', 'raw_wb_timeout'} else
                      400 if code in {"raw_invalid_region_request", "raw_invalid_preview_request", "raw_invalid_request",
                                      "raw_invalid_controls", "raw_invalid_point_color_index",
                                      "raw_invalid_point_color_control", "raw_point_color_limit",
                                      "raw_wb_unavailable", "raw_recipe_invalid", "raw_history_invalid"} else
                      503 if code in {"raw_unavailable", "lightcraft_not_ready", "raw_recipe_unavailable", "raw_recipe_save_failed",
                                      "raw_history_unavailable", "raw_history_save_failed", "raw_edit_reset_database_failed",
                                      "raw_preview_unsupported", "raw_region_unsupported"} else
                      409 if code in HISTORY_CONFLICTS or code in {"raw_busy", "raw_workspace_conflict", "raw_stale_handle", "raw_revision_conflict",
                                      "raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending",
                                      "raw_recipe_source_mismatch", "raw_recipe_engine_incompatible",
                                      "raw_recipe_revision_conflict", "raw_recipe_save_id_reused",
                                      "raw_mixer_target_unavailable"} else 502)
            if region_owner_get:
                lightcraft_log('region.owner.failed', level='warn', errorCode=code, status=status)
            return JSONResponse({"code": code}, status_code=status, headers={"Cache-Control": "no-store"})
        except Exception:
            if region_owner_get:
                lightcraft_log('region.owner.failed', level='error', errorCode='raw_operation_failed', status=502)
            lightcraft_log("raw.http.failed", level="error", errorCode="raw_operation_failed")
            return JSONResponse({"code": "raw_operation_failed"}, status_code=502,
                                headers={"Cache-Control": "no-store"})

    def _cancel_preview(self, request, body):
        if set(body) != {"workspaceId", "generation", "documentToken", "kind", "serial"} or \
                body.get("kind") not in ("after", "before") or type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1:
            raise LightCraftError("raw_invalid_request")
        self._owner(body["workspaceId"])
        doc = self._document(request.path_params["handle"])
        if type(body["generation"]) is not int or any(body[k] != doc[k] for k in ("generation", "documentToken")):
            raise LightCraftError("raw_stale_handle")
        self.raw.cancel_preview(self._raw_handle, body["kind"], body["serial"])
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    def _release_image_lease(self, lease):
        self._image_leases.discard(lease)
        self._response_leases.discard(lease)
        self._lease_tickets.pop(lease, None)
        if not self._response_leases:
            self._images_idle.set()

    def _hold_image_response(self, response, lease):
        if isinstance(response, _ImageResponse):
            # Register under the document lock: close can resume before task-done callbacks run.
            self._response_leases.add(lease)
            self._images_idle.clear()
            response.release_lease = lambda: self._release_image_lease(lease)
        return response

    def _region_owner(self, request, body):
        from raw_region import validate_target
        if set(body) != {"workspaceId", "operation", "target"}:
            raise LightCraftError("raw_invalid_region_request")
        target = validate_target(body["target"], body["operation"])
        self._owner(body["workspaceId"])
        doc = self._document(request.path_params["handle"])
        if self._workspace_state != "active" or target["identity"] != self.raw.region_identity(
                self._raw_handle, target["identity"]["kind"], document_token=doc["documentToken"]) \
                or target["documentRevision"] != doc["revision"]:
            raise LightCraftError("raw_revision_conflict")
        return doc

    def _replace_pending_region(self):
        pending = self.raw._pending
        if pending is not None and pending.region_operation is not None:
            self.raw.cancel_region(self._raw_handle, pending.region_target["requestId"])
            pending.reason = "replaced"
            for lease, ticket in list(self._lease_tickets.items()):
                if ticket is pending:
                    self._release_image_lease(lease)

    def _cancel_region(self, request, body):
        if set(body) != {"workspaceId", "generation", "documentToken", "requestId"} \
                or not isinstance(body["requestId"], str) or not re.fullmatch("[a-f0-9]{32}", body["requestId"]):
            raise LightCraftError("raw_invalid_region_request")
        self._owner(body["workspaceId"])
        doc = self._document(request.path_params["handle"])
        if type(body["generation"]) is not int or any(body[k] != doc[k] for k in ("generation", "documentToken")):
            raise LightCraftError("raw_stale_handle")
        self.raw.cancel_region(self._raw_handle, body["requestId"])
        return Response(status_code=204)

    async def _region(self, request, body, lease):
        async with self._lock:
            doc = self._region_owner(request, body)
            if not await self.manager._raw_region_supported(doc["generation"]):
                raise LightCraftError("raw_region_unsupported")
            # Whole's public geometry is scoped to its owner; only this owner unwraps it.
            target = body["target"]
            mapping = self._region_geometry.get((target["identity"]["kind"], target["quality"]))
            reason = _public_region_mapping_reason(mapping, doc["revision"], target)
            if reason:
                context = {"stage": "public_mapping", "reason": reason, "operation": body["operation"],
                    "revision": doc["revision"], "quality": target["quality"], "kind": target["identity"]["kind"],
                    "viewGeneration": target["viewGeneration"], "publicGeometryMappingMatch": False,
                    "nativeResponseReceived": False, "mismatchSide": "public_mapping"}
                if reason == "public_revision_mismatch":
                    context["mismatchFields"] = ["documentRevision"]
                elif reason == "public_geometry_mismatch":
                    context["mismatchFields"] = ["geometryId"]
                    context["geometryMatches"] = False
                elif reason == "public_mapping_missing":
                    context["mismatchFields"] = ["geometryMapping"]
                if "desiredLongEdge" in target:
                    context["desiredLongEdge"] = target["desiredLongEdge"]
                lightcraft_log("region.geometryMismatch", level="warn", **context)
                raise LightCraftError("raw_region_geometry_mismatch")
            lightcraft_log("region.started", level="debug", operation=body["operation"],
                revision=doc["revision"], quality=target["quality"], kind=target["identity"]["kind"],
                viewGeneration=target["viewGeneration"], requestId=target["requestId"],
                desiredLongEdge=target.get("desiredLongEdge"), publicGeometryMappingMatch=True,
                nativeResponseReceived=False)
            native_target = {**target, "geometryId": mapping[2]}
            ticket = self.raw.request_region(self._raw_handle, native_target, operation=body["operation"],
                                             document_token=doc["documentToken"])
            self._lease_tickets[lease] = ticket
        frame = await ticket
        async with self._lock:
            if frame is SUPERSEDED or self.document is not doc or target["documentRevision"] != doc["revision"]:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": ticket.reason})
            self._document(doc["handle"])
            metadata = {**frame.metadata["response"], "geometryId": target["geometryId"]}
            lightcraft_log("region.nativeResponse", level="debug", operation=body["operation"],
                revision=doc["revision"], quality=target["quality"], kind=target["identity"]["kind"],
                viewGeneration=target["viewGeneration"], requestId=target["requestId"],
                desiredLongEdge=target.get("desiredLongEdge"), publicGeometryMappingMatch=True,
                nativeResponseReceived=True)
            headers = {"Cache-Control": "no-store", "X-Raw-Region": json.dumps(metadata, separators=(",", ":"))}
            lightcraft_log("raw.region.delivered", level="debug", operation=body["operation"],
                requestId=target["requestId"], viewGeneration=target["viewGeneration"], revision=doc["revision"],
                quality=target["quality"], kind=metadata["kind"], disposition="accepted")
            if body["operation"] == "plan":
                return JSONResponse(metadata, headers={"Cache-Control": "no-store"})
            return self._hold_image_response(_ImageResponse(frame.data, media_type="image/png", headers=headers), lease)

    def _replace_pending_image(self, request, body):
        # A replaced, unsent ticket owns no bitmap; its terminal 204 can leave the image pool.
        doc = self.document
        kind = body.get("kind", "after")
        if set(body) - {"kind"} != {"workspaceId", "generation", "documentToken", "revision", "serial", "quality", "mode", "maxSide", "viewGeneration", "geometryId"} or \
                not doc or request.path_params.get("handle") != doc["handle"] or \
                any(type(body.get(k)) is not int for k in ("generation", "revision")) or \
                any(body.get(k) != doc[k] for k in ("workspaceId", "generation", "documentToken", "revision")) or \
                type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1 or \
                kind not in ("before", "after") or body.get("quality") not in ("draft", "full") or \
                not self._valid_display_target(body):
            return
        pending = self.raw._before_pending if kind == "before" else self.raw._pending
        if pending is None or pending.serial >= body["serial"]:
            return
        for lease, ticket in list(self._lease_tickets.items()):
            if ticket is pending:
                self.raw.cancel_preview(self._raw_handle, kind, pending.serial)
                pending.reason = "replaced"
                self._release_image_lease(lease)
                return

    @staticmethod
    def _valid_display_target(body):
        return (body.get("mode") in ("whole", "crop-edit") and type(body.get("maxSide")) is int and 16 <= body["maxSide"] <= MAX_PREVIEW_SIDE
            and type(body.get("viewGeneration")) is int and 0 <= body["viewGeneration"] <= 2**53 - 1
            and "geometryId" in body and (body["geometryId"] is None or isinstance(body["geometryId"], str)
                and re.fullmatch(r"[a-f0-9]{64}", body["geometryId"]) is not None))

    def _done(self, task):
        self._tasks.discard(task)
        self._history_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            error = task.exception()
            code = error.code if isinstance(error, LightCraftError) else "raw_operation_failed"
            rejection = code in {"raw_busy", "raw_workspace_conflict", "raw_stale_handle", "raw_revision_conflict",
                                 "raw_invalid_request", "raw_invalid_controls", "raw_wb_unavailable",
                                 "raw_source_too_large", "raw_cache_capacity", "raw_disk_capacity"}
            rejection |= code in {"raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending"}
            rejection |= code in HISTORY_CONFLICTS
            if code in {"raw_history_revision_conflict", "raw_history_readback_mismatch", "raw_history_baseline_mismatch"}:
                rejection &= not (self._history_save and self._history_save["stage"] != "complete")
            lightcraft_log("raw.operation.failed", level="warn" if rejection or task.get_name() == "windows-raw-before" else "error", errorCode=code)

    def _owner(self, workspace):
        if self.workspace is None or workspace != self.workspace:
            raise LightCraftError("raw_workspace_conflict")
        self._touched = monotonic()

    def _document(self, handle, *, resync=False):
        self._ready()
        doc = self.document
        if doc is None or doc["handle"] != handle or doc["generation"] != self.manager.status().generation:
            raise LightCraftError("raw_stale_handle")
        if self.raw.status().state in ({"lost", "stopped", "closing"} if resync else {"lost", "desynchronized", "stopped", "closing"}):
            raise LightCraftError("raw_unavailable")
        return doc

    async def _discard(self, request, body):
        identity = (request.path_params['workspace'], body)
        if self._closing:
            raise LightCraftError('raw_busy')
        if identity != self._discard_request:
            doc = self.document
            expected = {k:doc[k] for k in ('handle','generation','documentToken')} if doc else None
            if (self.workspace is not None and identity[0] != self.workspace) or (body != {'scope':'workspace'} and (not doc or type(body.get('generation')) is not int or body != expected)):
                raise LightCraftError('raw_stale_handle')
            if self._history_draining or self._discarding:
                raise LightCraftError('raw_busy')
            self._discard_request = identity
            self._discard_task = None
        if self._discard_task is None or self._discard_task.done() and (self._discard_task.cancelled() or self._discard_task.exception() is not None):
            # Close admission before yielding. Existing shielded owners, including a
            # lost save reply, finish before the durable Recipe is detached.
            self._history_draining = self._discarding = True
            self._discard_task = asyncio.create_task(self._discard_owned(identity[0]), name='raw-discard')
        return await asyncio.shield(self._discard_task)

    async def _discard_owned(self, workspace):
        try:
            if self.cache: self.cache.stop_download()
            if self._tasks:
                await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
            if self._image_tasks:
                await asyncio.gather(*tuple(self._image_tasks), return_exceptions=True)
            async with self._lock:
                if self.workspace not in (None, workspace):
                    raise LightCraftError('raw_stale_handle')
                try:
                    await self._release(checkpoint_history=False)
                except Exception:
                    # Reimport is unnecessary for discard. If restart failed, prove
                    # the old Native owner is closed before releasing its source.
                    await self.raw.close()
                    if self.cache: await self.cache.close()
                    self.cache = self.workspace = self.document = None
                    self._workspace_state = 'empty'
                    from lightcraft_raw import LightCraftRawSession
                    self.raw = LightCraftRawSession(self.manager)
                    lightcraft_log('raw.discard.engineUnavailable', level='warn', errorCode='raw_unavailable')
                lightcraft_log('raw.discard.completed', level='info')
                return Response(status_code=204, headers={'Cache-Control':'no-store'})
        finally:
            self._history_draining = self._discarding = False

    async def _execute(self, request, body):
        async with self._lock:
            path, method = request.url.path, request.method
            reset_path = method == "POST" and path.endswith("/edits/reset")
            if method != "DELETE" and not reset_path:
                self._ready()
            elif reset_path and (self.manager is None or self._closing):
                raise LightCraftError("raw_unavailable")
            if reset_path:
                return await self._reset_raw_edits(request, body)
            if method == "POST" and path.endswith("/workspaces"):
                if self.diagnostics_busy():
                    raise LightCraftError("raw_busy")
                if body or self.workspace is not None:
                    raise LightCraftError("raw_workspace_conflict")
                self._discard_task = self._discard_request = None
                self.workspace = secrets.token_hex(16)
                self._reset_asset_id = self._reset_owner = None
                self.cache = RawSourceCache()
                self._workspace_state = "active"
                self._native_released = False
                self._touched = monotonic()
                self._lease_task = asyncio.create_task(self._expire(), name="windows-raw-lease")
                return JSONResponse({"workspaceId": self.workspace})
            workspace = body.get("workspaceId") if method in {"POST", "PUT"} else request.headers.get("x-raw-workspace")
            if "workspace" in request.path_params:
                workspace = request.path_params["workspace"]
            self._owner(workspace)
            if path.endswith("/region") and method == "GET":
                doc = self._document(request.path_params["handle"])
                if request.headers.get("x-raw-generation") != str(doc["generation"]) or request.headers.get("x-raw-token") != doc["documentToken"]:
                    raise LightCraftError("raw_stale_handle")
                lightcraft_log('region.owner.validated', level='debug', generation=doc['generation'])
                source_id = self.raw.region_identity(self._raw_handle)['sourceId']
                supported = await self.manager._raw_region_supported(doc['generation'])
                lightcraft_log('region.owner.completed', level='debug', generation=doc['generation'],
                               supported=supported, sourceIdCharacters=len(source_id), status=200)
                return JSONResponse({'sourceId': source_id, 'regionContract': 1 if supported else None})
            if method == "DELETE":
                if "handle" in request.path_params:
                    self._document(request.path_params["handle"])
                await self._release()
                return Response(status_code=204)
            if self._workspace_state != "active":
                raise LightCraftError("raw_workspace_releasing" if self._workspace_state == "releasing"
                                      else "raw_workspace_cleanup_failed")
            if path.endswith("/documents") and method == "POST":
                if set(body) != {"assetId", "workspaceId"}:
                    raise LightCraftError("raw_invalid_request")
                try:
                    asset_id = UUID(body["assetId"])
                except (ValueError, TypeError, AttributeError):
                    raise LightCraftError("raw_invalid_request") from None
                if self.document is not None:
                    raise LightCraftError("raw_workspace_conflict")
                lightcraft_log("raw.document.open", assetId=str(asset_id))
                try:
                    source = await self.cache.download(asset_id)
                    handle, snapshot = await self.raw.open_raw(str(asset_id), str(source))
                    import_defaults_fingerprint = self._fingerprint(snapshot.settings)
                    snapshot, recipe_status, recipe_revision, recovery_pending = await self._restore_document(handle, snapshot)
                except BaseException:
                    # Import may have partially registered the source; reap before deleting it.
                    await self._release()
                    raise
                self._raw_handle = handle
                self._preview_latest.clear()
                self._region_geometry.clear()
                self._wb_frames.clear()
                self.document = {"handle": secrets.token_hex(16), "assetId": str(asset_id),
                                 "generation": handle.generation, "documentToken": handle.document_token,
                                 "revision": snapshot.revision, "workspaceId": self.workspace,
                                 "sourceWidth": self.raw._photo(handle, active=True).source_size[0],
                                 "sourceHeight": self.raw._photo(handle, active=True).source_size[1],
                                 "recipeStatus": recipe_status, "recipeRevision": recipe_revision,
                                 "importDefaultsFingerprint": import_defaults_fingerprint,
                                 "recipeRecoveryPending": recovery_pending}
                self.document.update(self._edit_budget())
                self.document["settingsFingerprint"] = self._fingerprint(snapshot.settings)
                self.document["recipeFingerprint"] = self.document["settingsFingerprint"]
                self._recipe_save = None
                self._history_save = None
                self._history_enabled = False
                self._wb_available = controls_state(snapshot)["wb"]["available"]
                self._touched = monotonic()
                lightcraft_log("raw.document.ready", assetId=str(asset_id), generation=handle.generation,
                               revision=snapshot.revision)
                return JSONResponse(self.document)
            settings_request = path.endswith("/settings")
            history_request = "/history" in path
            doc = self._document(request.path_params["handle"], resync=settings_request or history_request or "/geometry" in path)
            if "/geometry" in path:
                return await self._geometry(request, body, doc)
            if history_request:
                return await self._history(request, body, doc)
            if path.endswith("/recipe"):
                return await self._recipe(request, body, doc)
            if settings_request or path.endswith("/controls"):
                required = {"workspaceId", "generation", "documentToken"}
                if not settings_request:
                    required |= {"expectedRevision", "values"}
                if set(body) != required or type(body.get("generation")) is not int:
                    raise LightCraftError("raw_invalid_request")
                if any(body[key] != doc[key] for key in ("generation", "documentToken")):
                    raise LightCraftError("raw_stale_handle")
                if settings_request:
                    snapshot = await self.raw.get_settings(self._raw_handle)
                else:
                    self._history_unsettled()
                    if self._history_initialized and not self._history_enabled:
                        raise LightCraftError("raw_history_client_required")
                    if type(body.get("expectedRevision")) is not int or body["expectedRevision"] != doc["revision"]:
                        raise LightCraftError("raw_revision_conflict")
                    values = validate_controls(body["values"], self._wb_available)
                    snapshot = await self.raw.set_controls(self._raw_handle, values, doc["revision"])
                confirmed = controls_state(snapshot)
                doc["revision"] = snapshot.revision
                doc.update(self._edit_budget())
                doc["settingsFingerprint"] = self._fingerprint(snapshot.settings)
                self._wb_available = confirmed["wb"]["available"]
                lightcraft_log("raw.controls.confirmed", level="debug", generation=doc["generation"], revision=doc["revision"])
                return JSONResponse({**doc, **confirmed})
            if method == "GET":
                return JSONResponse({**doc, "state": self.raw.status().state})
            raise LightCraftError("raw_invalid_request")

    async def _geometry(self, request, body, doc):
        from raw_geometry import GESTURES, validate_operation, geometry_state
        begin = request.url.path.endswith('/begin')
        required = {'workspaceId', 'generation', 'documentToken', 'expectedRevision', 'settingsFingerprint', 'gestureId', 'operation'}
        if not begin:
            required.add('sequence')
        if (set(body) != required or type(body.get('generation')) is not int
                or type(body.get('expectedRevision')) is not int or not 0 <= body['expectedRevision'] < 2**53
                or type(body.get('gestureId')) is not str or re.fullmatch('[a-f0-9]{32}', body['gestureId']) is None
                or type(body.get('settingsFingerprint')) is not str or re.fullmatch('[a-f0-9]{64}', body['settingsFingerprint']) is None):
            raise LightCraftError('raw_invalid_request')
        if any(body[k] != doc[k] for k in ('generation', 'documentToken')):
            raise LightCraftError('raw_stale_handle')
        if begin:
            if type(body['operation']) is not str or body['operation'] not in GESTURES:
                raise LightCraftError('raw_invalid_request')
            if self._geometry_gesture is not None:
                if self._geometry_gesture['begin'] != body:
                    raise LightCraftError('raw_geometry_gesture_pending')
                return JSONResponse(self._geometry_gesture['beginResponse'])
            self._history_unsettled()
        else:
            op = validate_operation(body['operation'])
            if type(body['sequence']) is not int or not 0 <= body['sequence'] < 256:
                raise LightCraftError('raw_invalid_request')
            g = self._geometry_gesture
            if not g or g['id'] != body['gestureId'] or op['type'] != g['operation']:
                raise LightCraftError('raw_geometry_request_conflict')
            if g['stage'] == 'unknown':
                raise LightCraftError('raw_geometry_outcome_unknown')
            # Only the last immutable request is replayable; older sequences fail without sending.
            if g.get('lastRequest') == body:
                return JSONResponse(g['response'])
            if body['sequence'] != g['sequence'] + 1:
                raise LightCraftError('raw_geometry_request_conflict')
            self._history_unsettled(allow_geometry=True)
        if body['expectedRevision'] != doc['revision'] or body['settingsFingerprint'] != doc['settingsFingerprint']:
            raise LightCraftError('raw_revision_conflict')
        if begin:
            if self._recipe_save and not self._recipe_save.get('settled', False):
                raise LightCraftError('raw_recipe_save_pending')
            state = await self._history_load(doc)
            if not state['initialized'] or not state['recipe']:
                raise LightCraftError('raw_history_not_initialized')
            if self._fingerprint(state['recipe']['settings']) != doc['settingsFingerprint']:
                raise LightCraftError('raw_history_commit_required')
            self._geometry_gesture = {'id': body['gestureId'], 'operation': body['operation'], 'begin': body,
                                      'sequence': -1, 'stage': 'ready', 'baseline': state['recipe']['settings']}
            snapshot = self.raw.confirmed_settings(self._raw_handle, doc['revision'])
            payload = {**doc, **controls_state(snapshot), 'gestureId': body['gestureId'], 'sequence': -1}
            self._geometry_gesture['beginResponse'] = payload
            return JSONResponse(payload)
        if op['type'] == 'drag':
            rect = geometry_state(g['baseline'])['crop']['geometry']['rect']
            start = [rect[k] for k in ('x0', 'y0', 'x1', 'y1')]
            if 'start' in op['params'] and op['params']['start'] != start:
                raise LightCraftError('raw_geometry_request_conflict')
            if 'grab' in g and g['grab'] != (op['params']['handle'], op['params']['from']):
                raise LightCraftError('raw_geometry_request_conflict')
            g['grab'] = (op['params']['handle'], op['params']['from'])
            op['params']['start'] = start
        g['stage'] = 'unknown'
        lightcraft_log('raw.geometry.started', level='debug', generation=doc['generation'], revision=doc['revision'])
        try:
            snapshot = await self.raw.apply_geometry(self._raw_handle, op, doc['revision'])
        except BaseException as error:
            from raw_geometry import NOT_SENT
            if getattr(error, 'code', '') in NOT_SENT:
                g['stage'] = 'ready'
            lightcraft_log('raw.geometry.failed', level='error', generation=doc['generation'], revision=doc['revision'],
                           errorCode=getattr(error, 'code', 'raw_geometry_outcome_unknown'))
            raise
        self._history_verify(doc)
        self._confirmed(doc, snapshot)
        payload = {**doc, **controls_state(snapshot), 'gestureId': g['id'], 'sequence': body['sequence']}
        g.update(stage='ready', sequence=body['sequence'], lastRequest=body, response=payload)
        lightcraft_log('raw.geometry.confirmed', level='debug', generation=doc['generation'], revision=doc['revision'])
        return JSONResponse(payload)

    async def _preview(self, request, body, lease=None):
        async with self._lock:
            self._owner(body.get("workspaceId"))
            doc = self._document(request.path_params["handle"])
            kind = body.get("kind", "after")
            adaptive = "quality" in body
            extra = {"quality", "mode", "maxSide", "viewGeneration", "geometryId"} if adaptive else set()
            if set(body) - {"kind"} - extra != {"workspaceId", "generation", "documentToken", "revision", "serial"} \
                    or kind not in ("before", "after") \
                    or any(type(body.get(key)) is not int for key in ("generation", "revision")) \
                    or any(body.get(key) != doc[key] for key in ("generation", "documentToken", "revision")) \
                    or type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1:
                raise LightCraftError("raw_revision_conflict")
            if adaptive and (not extra <= set(body) or body["quality"] not in ("draft", "full") or not self._valid_display_target(body)):
                raise LightCraftError("raw_invalid_preview_request")
            if body.get('mode') == 'crop-edit' and kind != 'after':
                raise LightCraftError('raw_invalid_preview_request')
            handle = self._raw_handle
            options = {"kind": kind} if kind == "before" else {}
            if adaptive:
                supported = await self.manager._raw_preview_supported(doc["generation"])
                if body.get("mode") == "crop-edit":
                    if not supported and not await self.manager._raw_crop_edit_supported(doc["generation"]):
                        raise LightCraftError("raw_preview_unsupported")
                    options["mode"] = "crop-edit"
                    self._region_geometry.clear()
                    self._wb_frames.clear()
                options.update(max_side=body["maxSide"], serial=body["serial"], view_generation=body["viewGeneration"],
                               geometry_id=body["geometryId"], quality=body["quality"] if supported else
                               "full" if body.get("mode") == "crop-edit" else None)
            latest_key = (doc["handle"], kind)
            latest = self._preview_latest.get(latest_key, -1)
            if adaptive and body["serial"] <= latest:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced"})
            if adaptive:
                self._preview_latest[latest_key] = body["serial"]
            ticket = self.raw.request_preview(handle, doc["revision"], **options)
            if lease is not None:
                self._lease_tickets[lease] = ticket
        frame = await ticket
        async with self._lock:
            if frame is SUPERSEDED or self.document is not doc or adaptive and self._preview_latest.get(latest_key) != body["serial"]:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": ticket.reason})
            return self._hold_image_response(self._preview_response(frame, doc, body, kind, handle), lease)

    async def _curve_interaction(self, request, body, lease=None):
        self._owner(body.get("workspaceId"))
        doc = self._document(request.path_params["handle"], resync=True)
        if any(type(body.get(key)) is not int for key in ("generation", "documentRevision")) or \
                any(body.get(key) != doc[key] for key in ("generation", "documentToken")) or \
                body["documentRevision"] != doc["revision"]:
            raise LightCraftError("raw_stale_handle")
        identity = {"workspaceId", "generation", "documentToken", "documentRevision"}
        action = request.url.path.rsplit("/", 1)[1]
        if action == "begin":
            if set(body) not in (identity | {"channel"}, identity | {"channel", "mode"}) or body.get("mode", "points") not in ("points", "targeted"):
                raise LightCraftError("raw_invalid_request")
            async with self._lock:
                self._history_unsettled()
                interaction_id = await self.raw.begin_curve_interaction(
                    self._raw_handle, body["channel"], doc["revision"], body.get("mode", "points"))
            return JSONResponse({**{key: doc[key] for key in ("workspaceId", "handle", "assetId", "generation", "documentToken")},
                                 "revision": doc["revision"],
                                 "interactionId": interaction_id}, headers={"Cache-Control": "no-store"})
        if action == "cancel":
            if set(body) != identity | {"interactionId"} or type(body.get("interactionId")) is not str:
                raise LightCraftError("raw_invalid_request")
            await self.raw.cancel_curve_interaction(self._raw_handle, body["interactionId"], doc["revision"])
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        targeted = "steps" in body
        if action == "preview":
            required = identity | {"interactionId", "interactionSequence", "serial", "maxSide", "viewGeneration", "geometryId"}
            if set(body) != required or type(body.get("interactionId")) is not str or \
                    type(body.get("interactionSequence")) is not int or not 1 <= body["interactionSequence"] <= 2**31 - 1 or \
                    type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1 or \
                    type(body.get("viewGeneration")) is not int or body["viewGeneration"] < 0 or \
                    type(body.get("maxSide")) is not int or not 16 <= body["maxSide"] <= MAX_PREVIEW_SIDE or \
                    not (body["geometryId"] is None or type(body["geometryId"]) is str and re.fullmatch(r"[a-f0-9]{64}", body["geometryId"])):
                raise LightCraftError("raw_invalid_request")
            interaction = self.raw._ensure_curve_interaction_owner(body["interactionId"])
            if interaction is None or interaction.handle != self._raw_handle:
                raise LightCraftError("raw_curve_interaction_stale")
            ticket = interaction.preview_tickets.pop(body["interactionSequence"], None)
            if ticket is None:
                if body["interactionSequence"] <= interaction.latest_sequence:
                    return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced", "Cache-Control": "no-store"})
                raise LightCraftError("raw_curve_interaction_stale")
            update = None
        else:
            update = None
        required = identity | ({"interactionId", "target", "steps", "serial", "maxSide", "viewGeneration", "geometryId"} if targeted else {"interactionId", "points", "serial", "maxSide", "viewGeneration", "geometryId"})
        if action != "preview" and (set(body) != required or type(body.get("interactionId")) is not str or \
                type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1 or \
                type(body.get("maxSide")) is not int or not 16 <= body["maxSide"] <= MAX_PREVIEW_SIDE or \
                type(body.get("viewGeneration")) is not int or body["viewGeneration"] < 0 or \
                not (body["geometryId"] is None or type(body["geometryId"]) is str and re.fullmatch(r"[a-f0-9]{64}", body["geometryId"]))):
            raise LightCraftError("raw_invalid_request")
        if action == "preview":
            pass
        elif targeted:
            update = await self.raw.update_targeted_curve_interaction(self._raw_handle, body["interactionId"],
                doc["revision"], body["target"], body["steps"], max_side=body["maxSide"],
                view_generation=body["viewGeneration"], geometry_id=body["geometryId"])
        else:
            update = await self.raw.update_curve_interaction(self._raw_handle, body["interactionId"],
                doc["revision"], body["points"], max_side=body["maxSide"],
                view_generation=body["viewGeneration"], geometry_id=body["geometryId"])
        if action == "update" and targeted:
            if update is SUPERSEDED or not update.applied:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced", "Cache-Control": "no-store"})
            return JSONResponse({"interactionId": update.interaction_id, "interactionSequence": update.sequence,
                "curvePoints": update.settings["curve"][self.raw._curve_interaction.channel]}, headers={"Cache-Control": "no-store"})
        if action != "preview":
            ticket = update.preview_ticket if update is not SUPERSEDED and update.applied else None
        if update is SUPERSEDED or action != "preview" and (not update.applied or ticket is None):
            return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced", "Cache-Control": "no-store"})
        frame = await ticket
        if frame is SUPERSEDED:
            return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced", "Cache-Control": "no-store"})
        async with self._lock:
            if self.document is not doc or self._document(doc["handle"]) is not doc or \
                    frame.interaction_id != body["interactionId"] or frame.interaction_sequence is None:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "cancelled", "Cache-Control": "no-store"})
            response = self._preview_response(frame, doc, {"revision": doc["revision"], "serial": body["serial"],
                "quality": "draft", "mode": "whole", "viewGeneration": body["viewGeneration"],
                "maxSide": body["maxSide"], "geometryId": body["geometryId"]}, "after", self._raw_handle)
            if isinstance(response, _ImageResponse):
                response.headers["X-Raw-Interaction-Id"] = frame.interaction_id
                response.headers["X-Raw-Interaction-Sequence"] = str(frame.interaction_sequence)
                if targeted:
                    response.headers["X-Raw-Curve-Points"] = json.dumps(update.settings["curve"][self.raw._curve_interaction.channel], separators=(",", ":"))
            return self._hold_image_response(response, lease)

    async def _mixer_interaction(self, request, body, lease=None):
        self._owner(body.get("workspaceId"))
        doc = self._document(request.path_params["handle"], resync=True)
        if any(type(body.get(key)) is not int for key in ("generation", "documentRevision")) or \
                any(body.get(key) != doc[key] for key in ("generation", "documentToken")) or \
                body["documentRevision"] != doc["revision"]:
            raise LightCraftError("raw_stale_handle")
        identity = {"workspaceId", "generation", "documentToken", "documentRevision"}
        action = request.url.path.rsplit("/", 1)[1]
        if action == "begin":
            if set(body) != identity | {"target", "x", "y"} or body.get("target") not in ("hue", "sat", "lum") or \
                    any(type(body.get(key)) not in (int, float) or not math.isfinite(body[key]) or not 0 <= body[key] <= 1 for key in ("x", "y")):
                raise LightCraftError("raw_invalid_request")
            async with self._lock:
                self._history_unsettled()
                interaction_id = await self.raw.begin_mixer_interaction(self._raw_handle, body["target"],
                    body["x"], body["y"], doc["revision"])
            return JSONResponse({**{key: doc[key] for key in ("workspaceId", "handle", "assetId", "generation", "documentToken")},
                "revision": doc["revision"], "interactionId": interaction_id}, headers={"Cache-Control": "no-store"})
        if action == "cancel":
            if set(body) != identity | {"interactionId"} or type(body.get("interactionId")) is not str or \
                    re.fullmatch(r"[a-f0-9]{32}", body["interactionId"]) is None:
                raise LightCraftError("raw_invalid_request")
            await self.raw.cancel_mixer_interaction(self._raw_handle, body["interactionId"], doc["revision"])
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        common = {"interactionId", "serial", "maxSide", "viewGeneration", "geometryId"}
        if set(body) != identity | common | ({"interactionSequence"} if action == "preview" else {"sequence", "delta"}):
            raise LightCraftError("raw_invalid_request")
        if type(body.get("interactionId")) is not str or re.fullmatch(r"[a-f0-9]{32}", body["interactionId"]) is None or \
                type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1 or \
                type(body.get("maxSide")) is not int or not 16 <= body["maxSide"] <= MAX_PREVIEW_SIDE or \
                type(body.get("viewGeneration")) is not int or body["viewGeneration"] < 0 or \
                not (body["geometryId"] is None or type(body["geometryId"]) is str and re.fullmatch(r"[a-f0-9]{64}", body["geometryId"])):
            raise LightCraftError("raw_invalid_request")
        if action == "update":
            update = await self.raw.update_mixer_interaction(self._raw_handle, body["interactionId"], doc["revision"],
                body["sequence"], body["delta"], max_side=body["maxSide"],
                view_generation=body["viewGeneration"], geometry_id=body["geometryId"])
            return JSONResponse({"interactionId": update.interaction_id, "interactionSequence": update.sequence,
                "changes": update.changes}, headers={"Cache-Control": "no-store"})
        if action != "preview" or type(body.get("interactionSequence")) is not int or not 1 <= body["interactionSequence"] <= 2**31 - 1:
            raise LightCraftError("raw_invalid_request")
        interaction = self.raw._ensure_mixer_interaction_owner(body["interactionId"])
        if interaction is None or interaction.handle != self._raw_handle:
            raise LightCraftError("raw_mixer_interaction_stale")
        ticket = interaction.preview_tickets.pop(body["interactionSequence"], None)
        if ticket is None:
            if body["interactionSequence"] <= interaction.latest_sequence:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced", "Cache-Control": "no-store"})
            raise LightCraftError("raw_mixer_interaction_stale")
        frame = await ticket
        if frame is SUPERSEDED:
            return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced", "Cache-Control": "no-store"})
        async with self._lock:
            if self.document is not doc or self._document(doc["handle"]) is not doc or \
                    frame.interaction_id != body["interactionId"] or frame.interaction_sequence != body["interactionSequence"]:
                return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "cancelled", "Cache-Control": "no-store"})
            response = self._preview_response(frame, doc, {"revision": doc["revision"],
                "serial": body["serial"], "quality": "draft", "mode": "whole",
                "viewGeneration": body["viewGeneration"], "maxSide": body["maxSide"],
                "geometryId": body["geometryId"]}, "after", self._raw_handle)
            if isinstance(response, _ImageResponse):
                response.headers["X-Raw-Interaction-Id"] = frame.interaction_id
                response.headers["X-Raw-Interaction-Sequence"] = str(frame.interaction_sequence)
            return self._hold_image_response(response, lease)

    def _preview_response(self, frame, doc, body, kind, handle):
        if frame is SUPERSEDED:
            return Response(status_code=204)
        if self._document(doc["handle"]) is not doc or frame.handle != self._raw_handle \
                or frame.kind != kind or len(frame.data) > MAX_IMAGE_BYTES \
                or (kind == "after" and frame.revision != doc["revision"]) \
                or (kind == "before" and frame.frame is None and frame.key != self.raw.before_key(handle)):
            raise LightCraftError("raw_stale_handle")
        if (body.get('mode') == 'crop-edit') != (frame.crop_display is not None):
            raise LightCraftError('lightcraft_invalid_preview')
        headers = {"X-Raw-Generation": str(frame.handle.generation), "X-Raw-Token": frame.handle.document_token,
                   "X-Raw-Revision": str(body["revision"]), "X-Raw-Epoch": str(frame.selection_epoch),
                   "X-Raw-Sequence": str(frame.sequence), "X-Raw-Serial": str(body["serial"]),
                   "X-Raw-Width": str(frame.width), "X-Raw-Height": str(frame.height),
                   "Cache-Control": "no-store"}
        headers["X-Raw-Kind"] = frame.kind
        if "quality" in body:
            headers.update({"X-Raw-Quality": frame.quality, "X-Raw-Mode": "whole",
                            "X-Raw-Preview-Contract": "1" if frame.frame is not None else "0",
                            "X-Raw-View-Generation": str(body["viewGeneration"])})
            if frame.frame is not None:
                native_frame = dict(frame.frame)
                native_geometry = native_frame["geometryId"]
                native_frame["geometryId"] = hashlib.sha256((f"{handle.source_key}:{handle.document_token}:"
                    f"{handle.generation}:{native_frame['geometryId']}").encode()).hexdigest()
                if body["geometryId"] is not None and body["geometryId"] != native_frame["geometryId"]:
                    return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced"})
                headers["X-Raw-Frame"] = json.dumps(native_frame, separators=(",", ":"), ensure_ascii=True)
                if body['mode'] == 'crop-edit':
                    if frame.crop_display is None: raise LightCraftError('raw_invalid_preview')
                    headers.pop('X-Raw-Preview-Contract', None)
                    headers['X-Raw-Crop-Edit-Contract'] = '1'
                    headers['X-Raw-Mode'] = 'crop-edit'
                    headers['X-Raw-Crop'] = json.dumps({**frame.crop_display,'settingsFingerprint':doc['settingsFingerprint']}, separators=(',',':'))
                else:
                    self._region_geometry[(kind, frame.quality)] = (doc["revision"], native_frame["geometryId"], native_geometry)
                    # Retained overlay bases may use a former Whole size. Attest exact render conditions, bounded per owner.
                    key = (kind, frame.quality, body['maxSide'], native_frame['geometryId'])
                    self._wb_frames.pop(key, None)
                    self._wb_frames[key] = (doc['revision'], doc.get('beforeKey'), native_geometry)
                    while len(self._wb_frames) > 16:
                        self._wb_frames.pop(next(iter(self._wb_frames)))
        if frame.key:
            headers["X-Raw-Before-Key"] = frame.key
        lightcraft_log("raw.preview.complete", level="debug", assetId=doc["assetId"],
                       generation=frame.handle.generation, revision=frame.revision, bytes=len(frame.data), kind=kind)
        self._touched = monotonic()
        return _ImageResponse(frame.data, media_type="image/png", headers=headers)

    def _edit_budget(self):
        # The soft boundary leaves 56 attempts for final flush, resync and failed readbacks.
        return {"beforeKey": self.raw.before_key(self._raw_handle) if getattr(self, "_raw_handle", None) else None,
                "mutationAttempts": self.raw.status().edits, "mutationLimit": MAX_EDITS,
                "regenerationThreshold": REGENERATE_AFTER_EDITS}

    @staticmethod
    def _fingerprint(settings):
        if type(settings) is dict and "point_colors" not in settings:
            # Legacy snapshots omit this serde-default array; compare them as the empty Native value.
            settings = {**settings, "point_colors": []}
        return hashlib.sha256(_settings_json(settings).encode("utf-8")).hexdigest()

    async def _recipe(self, request, body, doc):
        from raw_recipe_store import get_raw_recipe, put_raw_recipe, InvalidRawRecipe, StoreConflict, StoreUnavailable

        def verify():
            if self._closing or self._document(doc["handle"]) is not doc:
                raise LightCraftError("raw_stale_handle")

        if request.method == "GET":
            if request.headers.get("x-raw-generation") != str(doc["generation"]) or \
                    request.headers.get("x-raw-token") != doc["documentToken"]:
                raise LightCraftError("raw_stale_handle")
            try:
                saved = await run_in_threadpool(get_raw_recipe, self.raw.recipe_identity(self._raw_handle))
            except (StoreUnavailable, InvalidRawRecipe):
                raise LightCraftError("raw_recipe_unavailable") from None
            verify()
            present = saved["recipe"] is not None
            fingerprint = self._fingerprint(saved["recipe"]["settings"]) if present else None
            return JSONResponse({**doc, "recipeRevision": saved["revision"] if present else 0,
                "recipeFingerprint": fingerprint, "lastSaveId": saved.get("lastSaveId"), "updatedAt": saved.get("updatedAt")})

        if doc.get("recipeRecoveryPending"):
            raise LightCraftError("raw_history_requires_operation")
        self._history_unsettled()
        if set(body) != {"workspaceId", "generation", "documentToken", "documentRevision", "expectedRecipeRevision", "saveId"} \
                or any(type(body.get(key)) is not int or not 0 <= body[key] < 2**53
                       for key in ("generation", "documentRevision", "expectedRecipeRevision")):
            raise LightCraftError("raw_invalid_request")
        if any(body[key] != doc[key] for key in ("generation", "documentToken")):
            raise LightCraftError("raw_stale_handle")
        try:
            if not isinstance(body["saveId"], str) or len(body["saveId"]) > 45:
                raise ValueError()
            body = {**body, "saveId": str(UUID(body["saveId"]))}
        except ValueError:
            raise LightCraftError("raw_invalid_request") from None
        pending = self._recipe_save
        if pending and pending["request"]["saveId"] == body["saveId"]:
            if pending["request"] != body:
                raise LightCraftError("raw_recipe_save_id_reused")
        else:
            if body["documentRevision"] != doc["revision"]:
                raise LightCraftError("raw_revision_conflict")
            snapshot = await self.raw.get_settings(self._raw_handle)
            verify()
            doc["revision"] = snapshot.revision
            doc["settingsFingerprint"] = self._fingerprint(snapshot.settings)
            if snapshot.revision != body["documentRevision"]:
                raise LightCraftError("raw_revision_conflict")
            # One immutable transport retry belongs to this document, not a photo snapshot store.
            pending = {"request": body, "settings": snapshot.settings,
                       "identity": self.raw.recipe_identity(self._raw_handle), "fingerprint": doc["settingsFingerprint"],
                       "importDefaultsFingerprint": doc["importDefaultsFingerprint"], "settled": False}
            self._recipe_save = pending
        try:
            result = await mutate_raw_edits(self.thumbnail_scheduler(), doc["assetId"],
                                           put_raw_recipe, pending["identity"], body["expectedRecipeRevision"],
                                           body["saveId"], pending["settings"],
                                           import_defaults_fingerprint=pending["importDefaultsFingerprint"])
        except StoreConflict as error:
            if error.code == "raw_history_requires_operation":
                # The store has rejected this new checkpoint without a receipt or a write.
                pending["settled"] = True
            raise LightCraftError("raw_history_requires_operation" if error.code == "raw_history_requires_operation" else
                                  "raw_recipe_save_id_reused" if error.code == "save_id_reused"
                                  else "raw_recipe_revision_conflict") from None
        except InvalidRawRecipe:
            raise LightCraftError("raw_recipe_invalid") from None
        except StoreUnavailable:
            raise LightCraftError("raw_recipe_save_failed") from None
        try:
            verify()
        except LightCraftError:
            # The DB may already have committed; stale ownership is not proof of a rejected save.
            raise LightCraftError("raw_recipe_save_unknown") from None
        doc["recipeRevision"] = result["revision"]
        doc["recipeFingerprint"] = pending["fingerprint"]
        pending["settled"] = True
        lightcraft_log("raw.recipe.saved", level="debug", assetId=doc["assetId"], revision=result["revision"])
        return JSONResponse({**{key: doc[key] for key in ("workspaceId", "handle", "assetId", "generation", "documentToken")},
            "documentRevision": body["documentRevision"], "settingsFingerprint": pending["fingerprint"],
            "recipeRevision": result["revision"], "saveId": result["lastSaveId"], "updatedAt": result["updatedAt"]})

    def _history_unsettled(self, *, allow_geometry=False):
        if self._geometry_gesture is not None and not allow_geometry:
            raise LightCraftError("raw_geometry_gesture_pending")
        if self._history_save and self._history_save["stage"] != "complete":
            raise LightCraftError("raw_history_save_pending")

    def _history_verify(self, doc):
        if self._closing or self._document(doc["handle"], resync=True) is not doc:
            raise LightCraftError("raw_stale_handle")
        if self.raw.status().state == "synced" and self.raw.recipe_identity(self._raw_handle) != self._history_identity:
            raise LightCraftError("raw_stale_handle")

    def _confirmed(self, doc, snapshot):
        if doc["revision"] != snapshot.revision:
            self._region_geometry.clear()
            self._wb_frames.clear()
        doc["revision"] = snapshot.revision
        doc["settingsFingerprint"] = self._fingerprint(snapshot.settings)
        doc.update(self._edit_budget())
        self._wb_available = controls_state(snapshot)["wb"]["available"]

    async def _history_load(self, doc):
        from raw_recipe_store import get_raw_history, InvalidRawRecipe, StoreUnavailable
        try:
            state = await run_in_threadpool(get_raw_history, self._history_identity)
        except (InvalidRawRecipe, StoreUnavailable):
            raise LightCraftError("raw_history_unavailable") from None
        self._history_verify(doc)
        self._history_initialized = state["initialized"]
        return state

    def _history_public(self, doc, state):
        history = state["history"]
        cursor = history["cursor"] if history else 0
        steps = history["steps"] if history else []
        saved = self._fingerprint(state["recipe"]["settings"]) if state["recipe"] else None
        return {"history": {"initialized": state["initialized"], "cursor": cursor, "length": len(steps),
                            "selectedStepId": steps[cursor - 1]["stepId"] if cursor else None},
                "recipeRevision": state["revision"], "recipeFingerprint": saved,
                "historyPending": bool(self._history_save and self._history_save["stage"] != "complete"),
                "nativeState": self.raw.status().state,
                "nativeMatchesRecipe": self.raw.status().state == "synced"
                    and doc["settingsFingerprint"] == (saved or doc["recipeFingerprint"])}

    @staticmethod
    def _history_changes(step, before_settings, after_settings):
        from raw_controls import with_legacy_grading_defaults, with_legacy_optics_defaults, with_legacy_profile_defaults
        before_settings = with_legacy_grading_defaults(before_settings)
        after_settings = with_legacy_grading_defaults(after_settings)
        before_settings = with_legacy_optics_defaults(before_settings)
        after_settings = with_legacy_optics_defaults(after_settings)
        before_settings = with_legacy_profile_defaults(before_settings)
        after_settings = with_legacy_profile_defaults(after_settings)
        metadata = step["metadata"]
        if step['kind'] in ('vignetteStyle', 'geometry'):
            return []
        if step["kind"] in ("control", "controlReset"):
            controls = (["wb.temp", "wb.tint"] if step["kind"] == "controlReset"
                        and metadata["control"].startswith("wb.") else [metadata["control"]])
        elif step["kind"] == "wbReset":
            controls = ["wb.temp", "wb.tint"]
        elif step["kind"] == "colorReset":
            controls = [control for control in CONTROLS if control.startswith(("wb.", "color.", "mixer.", "grading."))]
        elif step["kind"] in ("opticsFlag", "opticsFlagReset"):
            controls = []
        elif step['kind'] in ('wbAuto', 'wbPick'):
            controls = ['wb.temp', 'wb.tint']
        elif step["kind"] in ("sectionToggle", "sectionReset"):
            section = metadata["section"]
            controls = [control for control in CONTROLS if control.startswith(f"{section}.")
                        or section == "color" and control.startswith("wb.")]
        else:
            controls = list(CONTROLS)

        changes = []
        for control in controls:
            before_group, key = control_location(before_settings, control)
            after_group, _ = control_location(after_settings, control)
            if type(before_group) is not dict or type(after_group) is not dict:
                return None
            before, after = before_group.get(key), after_group.get(key)
            if (type(before) not in (int, float) or not math.isfinite(before)
                    or type(after) not in (int, float) or not math.isfinite(after)):
                return None
            if before != after:
                changes.append({"control": control, "before": before, "after": after})
        return changes

    @staticmethod
    def _history_flag_changes(step, before_settings, after_settings):
        from raw_controls import (HISTORY_FLAG_CONTROLS, control_location, with_legacy_grading_defaults,
                                  with_legacy_optics_defaults, with_legacy_profile_defaults)
        before_settings = with_legacy_grading_defaults(before_settings)
        after_settings = with_legacy_grading_defaults(after_settings)
        before_settings = with_legacy_optics_defaults(before_settings)
        after_settings = with_legacy_optics_defaults(after_settings)
        before_settings = with_legacy_profile_defaults(before_settings)
        after_settings = with_legacy_profile_defaults(after_settings)
        kind = step['kind']
        if kind in ('opticsFlag', 'opticsFlagReset'):
            controls = [step['metadata']['control']]
        elif ((kind == 'sectionReset' and step['metadata']['section'] == 'optics') or kind == 'allReset'):
            controls = sorted(HISTORY_FLAG_CONTROLS)
        else:
            return []
        changes = []
        for control in controls:
            before_group, key = control_location(before_settings, control)
            after_group, _ = control_location(after_settings, control)
            if type(before_group) is not dict or type(after_group) is not dict:
                return None
            before, after = before_group.get(key), after_group.get(key)
            if type(before) is not bool or type(after) is not bool:
                return None
            if before != after:
                changes.append({"control": control, "before": before, "after": after})
        return changes

    @staticmethod
    def _history_json(payload, limit=MAX_SETTINGS_RESPONSE_BYTES):
        response = JSONResponse(payload, headers={"Cache-Control": "no-store"})
        if len(response.body) > limit:
            raise LightCraftError("raw_history_response_too_large")
        return response

    async def _history_response(self, doc, result):
        state = await self._history_load(doc)
        metadata = self._history_public(doc, state)
        doc["recipeRevision"] = metadata["recipeRevision"]
        if metadata["recipeFingerprint"] is not None:
            doc["recipeFingerprint"] = metadata["recipeFingerprint"]
        snapshot = self.raw.confirmed_settings(self._raw_handle, doc["revision"], allow_desync=True)
        return self._history_json({**doc, **controls_state(snapshot), **metadata,
                                   "ack": result["ack"] if result else None,
                                   "replayed": result["replayed"] if result else False})

    def _history_body(self, body, doc, action):
        required = {"workspaceId", "generation", "documentToken", "documentRevision",
                    "expectedRecipeRevision", "settingsFingerprint"}
        if action != "recover":
            required.add("saveId")
        if action in ("commit", "operate"):
            required |= {"kind", "metadata"}
            if body.get('kind') == 'geometry':
                required.add('geometry' if action == 'operate' else 'gestureId')
            if action == 'operate' and body.get('kind') == 'curve':
                required.add('curvePoints')
                if 'curveInteractionId' in body:
                    required.add('curveInteractionId')
            if action == 'operate' and body.get('kind') == 'mixerTarget':
                required.add('mixerInteractionId')
        elif action == "jump":
            required.add("targetStepId")
        if action == 'operate' and body.get('kind') == 'wbPick':
            required.add('frame')
            from raw_white_balance import validate_pick_frame
            try:
                validate_pick_frame(body.get('frame'))
            except ValueError:
                raise LightCraftError('raw_invalid_request') from None
        if (set(body) != required or any(type(body.get(key)) is not int or not 0 <= body[key] < 2**53
                for key in ("generation", "documentRevision", "expectedRecipeRevision"))
                or type(body.get("settingsFingerprint")) is not str
                or re.fullmatch(r"[0-9a-f]{64}", body["settingsFingerprint"]) is None):
            raise LightCraftError("raw_invalid_request")
        if any(body[key] != doc[key] for key in ("generation", "documentToken")):
            raise LightCraftError("raw_stale_handle")
        body = dict(body)
        try:
            for key in ("saveId", "targetStepId"):
                if key in body and (key != "targetStepId" or body[key] is not None):
                    if type(body[key]) is not str or len(body[key]) > 45:
                        raise ValueError()
                    body[key] = str(UUID(body[key]))
        except ValueError:
            raise LightCraftError("raw_invalid_request") from None
        if body.get('kind') == 'geometry':
            from raw_geometry import validate_operation, valid_metadata
            if not valid_metadata(body.get('metadata')):
                raise LightCraftError('raw_invalid_request')
            if action == 'operate':
                op = validate_operation(body['geometry'])
                if op['type'] != body['metadata']['operation']:
                    raise LightCraftError('raw_invalid_request')
            elif type(body.get('gestureId')) is not str or len(body['gestureId']) != 32 or not re.fullmatch('[a-f0-9]{32}', body['gestureId']):
                raise LightCraftError('raw_invalid_request')
        elif action == "commit":
            from raw_controls import CONTROLS
            metadata = body["metadata"]
            if (body["kind"] != "control" or type(metadata) is not dict or set(metadata) != {"control"}
                    or type(metadata["control"]) is not str or metadata["control"] not in CONTROLS):
                raise LightCraftError("raw_invalid_request")
        elif action == "operate":
            from raw_controls import POINT_COLOR_HISTORY_SCHEMAS, validate_point_color_history_operation
            if type(body["kind"]) is str and body["kind"] in POINT_COLOR_HISTORY_SCHEMAS:
                body["metadata"] = validate_point_color_history_operation(body["kind"], body["metadata"])
            else:
                validate_history_operation(body["kind"], body["metadata"])
            if body["kind"] == "curve":
                from raw_controls import validate_curve_operation
                validate_curve_operation("curve", {"channel": body["metadata"].get("channel"), "points": body.get("curvePoints")})
                if 'curveInteractionId' in body and (type(body['curveInteractionId']) is not str
                        or re.fullmatch(r"[a-f0-9]{32}", body['curveInteractionId']) is None):
                    raise LightCraftError("raw_invalid_request")
            elif body["kind"] == "mixerTarget":
                if 'mixerInteractionId' not in body or type(body['mixerInteractionId']) is not str or \
                        re.fullmatch(r"[a-f0-9]{32}", body['mixerInteractionId']) is None:
                    raise LightCraftError("raw_invalid_request")
            elif 'mixerInteractionId' in body:
                raise LightCraftError("raw_invalid_request")
            elif 'curveInteractionId' in body:
                raise LightCraftError("raw_invalid_request")
            kind, metadata = body["kind"], body["metadata"]
            if not self._wb_available and (kind in ("allReset", "wbAuto", "wbPick", "wbReset", "colorReset") or kind == "sectionReset" and metadata["section"] == "color"
                    or kind == "controlReset" and metadata["control"].startswith("wb.")):
                raise LightCraftError("raw_wb_unavailable")
        return body

    async def _history(self, request, body, doc):
        from raw_recipe_store import (HISTORY_LIMIT, get_raw_history_save, initialize_raw_history, append_raw_history,
                                      move_raw_history_cursor, InvalidRawRecipe, StoreConflict, StoreUnavailable)
        if request.method == "GET":
            if (request.headers.get("x-raw-generation") != str(doc["generation"])
                    or request.headers.get("x-raw-token") != doc["documentToken"]):
                raise LightCraftError("raw_stale_handle")
            try:
                if request.query_params:
                    raise ValueError()
            except ValueError:
                raise LightCraftError("raw_invalid_request") from None
            state = await self._history_load(doc)
            history = state["history"]
            steps = history["steps"] if history else []
            baseline = history["baselineSettings"] if history else None
            public_steps = []
            for index, step in enumerate(steps):
                before = baseline if index == 0 else steps[index - 1]["settings"]
                public = {key: step[key] for key in ("stepId", "kind", "metadata", "createdAt")}
                public["changes"] = self._history_changes(step, before, step["settings"])
                if step['kind'] in ('opticsFlag', 'opticsFlagReset', 'allReset') or (
                        step['kind'] == 'sectionReset' and step['metadata']['section'] == 'optics'):
                    public['flagChanges'] = self._history_flag_changes(step, before, step["settings"])
                public_steps.append(public)
            return self._history_json({**doc, **self._history_public(doc, state), "steps": public_steps}, MAX_HISTORY_RESPONSE_BYTES)
        action = request.url.path.rsplit("/", 1)[1]
        body = self._history_body(body, doc, action)
        if doc.get("recipeRecoveryPending") and action == "initialize":
            raise LightCraftError("raw_history_requires_operation")
        geometry_commit = action == 'commit' and body.get('kind') == 'geometry'
        curve_interaction = action == 'operate' and body.get('kind') == 'curve' and 'curveInteractionId' in body
        mixer_target_interaction = action == 'operate' and body.get('kind') == 'mixerTarget'
        if self._geometry_gesture is not None and action != 'recover' and not geometry_commit:
            raise LightCraftError('raw_geometry_gesture_pending')
        fingerprint = hashlib.sha256(json.dumps([doc["handle"], action, body], sort_keys=True,
                                                separators=(",", ":")).encode()).hexdigest()
        if self._recipe_save and not self._recipe_save.get("settled", False):
            raise LightCraftError("raw_recipe_save_pending")
        pending = self._history_save
        if pending and pending["request"].get("saveId") == body.get("saveId") and action != "recover":
            if pending["action"] != action or pending["request"] != body:
                raise LightCraftError("raw_history_save_id_reused")
        try:
            if action != "recover":
                replay = await run_in_threadpool(get_raw_history_save, self._history_identity, body["saveId"],
                                                 request_fingerprint=fingerprint)
                self._history_verify(doc)
                if replay is not None:
                    if pending and pending["request"].get("saveId") == body["saveId"]:
                        pending["stage"] = "complete"
                        if pending.get("recovering"):
                            doc["recipeRecoveryPending"] = False
                            self._recipe_recovery_baseline = None
                            self._history_initialized = self._history_enabled = True
                    if curve_interaction:
                        snapshot = self.raw.confirm_curve_interaction(self._raw_handle,
                            body["curveInteractionId"], body["documentRevision"])
                        self._history_verify(doc)
                        self._confirmed(doc, snapshot)
                    if mixer_target_interaction:
                        snapshot = self.raw.confirm_mixer_interaction(self._raw_handle,
                            body["mixerInteractionId"], body["documentRevision"])
                        self._history_verify(doc)
                        self._confirmed(doc, snapshot)
                    self._history_enabled = True
                    lightcraft_log("raw.history.replayed", level="debug", assetId=doc["assetId"], saveId=body["saveId"],
                                   revision=replay["current"]["revision"], historyCursor=replay["current"]["historyCursor"])
                    return await self._history_response(doc, replay)
            if action == "recover":
                return await self._history_recover(doc, body)
            if not pending or pending["request"].get("saveId") != body["saveId"]:
                self._history_unsettled(allow_geometry=geometry_commit)
                if geometry_commit:
                    g = self._geometry_gesture
                    if not g or g['id'] != body['gestureId'] or g['operation'] != body['metadata']['operation'] or g['stage'] != 'ready':
                        raise LightCraftError('raw_geometry_request_conflict')
                if body["documentRevision"] != doc["revision"] or body["settingsFingerprint"] != doc["settingsFingerprint"]:
                    raise LightCraftError("raw_revision_conflict")
                state = await self._history_load(doc)
                if state["revision"] != body["expectedRecipeRevision"]:
                    raise LightCraftError("raw_history_revision_conflict")
                recovering = bool(doc.get("recipeRecoveryPending") and self._recipe_recovery_baseline is not None
                                  and not state["initialized"] and state["recipe"] is None
                                  and state["revision"] == 0)
                if action != "initialize" and not state["initialized"] and not (
                        recovering and action in ("commit", "operate")):
                    raise LightCraftError("raw_history_not_initialized")
                if (action == "initialize" and state["recipe"]
                        and self._fingerprint(state["recipe"]["settings"]) != doc["settingsFingerprint"]):
                    raise LightCraftError("raw_history_commit_required")
                target = None
                if action in {"undo", "redo", "jump", "operate"}:
                    if self._fingerprint(state["recipe"]["settings"]) != doc["settingsFingerprint"]:
                        raise LightCraftError("raw_history_commit_required")
                    history = state["history"]
                    cursor = history["cursor"]
                    if action == "operate":
                        selected = state["recipe"]["settings"] if state["recipe"] else (
                            self._recipe_recovery_baseline if recovering else None)
                    elif action == "undo":
                        cursor = max(0, cursor - 1)
                        target = history["steps"][cursor - 1]["stepId"] if cursor else None
                    elif action == "redo":
                        cursor = min(len(history["steps"]), cursor + 1)
                        target = history["steps"][cursor - 1]["stepId"] if cursor else None
                    elif action == "jump":
                        target = body["targetStepId"]
                        matches = [i for i, step in enumerate(history["steps"], 1) if step["stepId"] == target]
                        if target is not None and not matches:
                            raise LightCraftError("raw_history_target_missing")
                        cursor = matches[0] if target is not None else 0
                    if action != "operate":
                        selected = history["steps"][cursor - 1]["settings"] if cursor else history["baselineSettings"]
                else:
                    selected = state["recipe"]["settings"] if action == "initialize" and state["recipe"] else None
                pending = {"request": body, "action": action, "stage": "readback", "settings": None,
                           "fingerprint": fingerprint, "identity": dict(self._history_identity),
                           "target": target, "selected": selected, "recovering": recovering}
                self._history_save = pending
                lightcraft_log("raw.history.started", level="debug", assetId=doc["assetId"], saveId=body["saveId"],
                               generation=doc["generation"], revision=doc["revision"], phase=action)
            if pending.get("noOp"):
                return await self._history_response(doc, None)
            state = await self._history_load(doc)
            if state["revision"] != body["expectedRecipeRevision"]:
                raise LightCraftError("raw_history_revision_conflict")
            if (pending["stage"] == "applying" and action == "operate" and body.get("kind") in (
                    "pointColorPick", "pointColorDelete", "pointColorControl", "pointColorControlReset", "pointColorReset")):
                # A retry cannot infer whether a non-replayable Native operation took effect.
                raise LightCraftError("raw_history_operation_outcome_unknown")
            if pending['stage'] == 'applying' and action == 'operate' and body.get('kind') == 'geometry':
                # A relative command may have run. No snapshot comparison proves execution count.
                raise LightCraftError('raw_geometry_outcome_unknown')
            if pending["stage"] != "save":
                if curve_interaction:
                    pending["stage"] = "ending"
                    interaction_result = await self.raw.end_curve_interaction(self._raw_handle,
                        body["curveInteractionId"], body["documentRevision"], body["curvePoints"])
                    self._history_verify(doc)
                    pending["settings"] = interaction_result.settings
                elif mixer_target_interaction:
                    pending["stage"] = "ending"
                    interaction_result = await self.raw.end_mixer_interaction(self._raw_handle,
                        body["mixerInteractionId"], body["documentRevision"], body["metadata"]["target"])
                    self._history_verify(doc)
                    pending["settings"] = interaction_result.settings
                else:
                    mutation_attempts = self.raw.status().edits
                    try:
                        snapshot = await self.raw.get_settings(self._raw_handle)
                    except LightCraftError:
                        status = self.raw.status()
                        if (action == "operate" and body["kind"] in ("pointColorPick", "pointColorDelete",
                                "pointColorControl", "pointColorControlReset", "pointColorReset")
                                and status.edits == mutation_attempts and status.state == "synced"):
                            self._history_save = None
                        raise
                    self._history_verify(doc)
                    self._confirmed(doc, snapshot)
                wb_operation = action == 'operate' and body['kind'] in ('wbAuto', 'wbPick')
                if curve_interaction or mixer_target_interaction:
                    pass
                elif wb_operation:
                    snapshot = await self._history_wb(doc, pending, snapshot)
                    self._history_verify(doc)
                    self._confirmed(doc, snapshot)
                elif action in {"initialize", "commit"}:
                    if snapshot.revision != body["documentRevision"] or doc["settingsFingerprint"] != body["settingsFingerprint"]:
                        # No mutation was sent here; let the caller resync and submit fresh confirmed intent.
                        self._history_save = None
                        raise LightCraftError("raw_revision_conflict")
                elif pending["stage"] == "readback" and (snapshot.revision != body["documentRevision"]
                        or doc["settingsFingerprint"] != body["settingsFingerprint"]):
                    self._history_save = None
                    raise LightCraftError("raw_revision_conflict")
                elif self._fingerprint(snapshot.settings) != self._fingerprint(pending["selected"]):
                    pending["stage"] = "applying"
                    snapshot = await self.raw.restore_persisted_settings(self._raw_handle,
                        {**pending["identity"], "settings": pending["selected"]}, snapshot.revision)
                    self._history_verify(doc)
                    self._confirmed(doc, snapshot)
                if action == "operate" and not wb_operation and not curve_interaction and not mixer_target_interaction:
                    pending["stage"] = "applying"
                    if body['kind'] == 'geometry':
                        try:
                            snapshot = await self.raw.apply_geometry(self._raw_handle, body['geometry'], snapshot.revision)
                        except BaseException as error:
                            from raw_geometry import NOT_SENT
                            if getattr(error, 'code', '') in NOT_SENT:
                                pending['stage'] = 'readback'
                            raise
                    else:
                        mutation_attempts = self.raw.status().edits
                        try:
                            snapshot = await self.raw.apply_history_operation(self._raw_handle, body["kind"],
                                body["metadata"], snapshot.revision, curve_points=body.get("curvePoints"))
                        except LightCraftError:
                            status = self.raw.status()
                            if (body["kind"] in ("pointColorPick", "pointColorDelete", "pointColorControl",
                                    "pointColorControlReset", "pointColorReset")
                                    and status.edits == mutation_attempts and status.state == "synced"):
                                # No Native mutation attempt and a synced session prove the failure was pre-mutation.
                                self._history_save = None
                            raise
                    self._history_verify(doc)
                    self._confirmed(doc, snapshot)
                # Keep supported legacy omission of WB scale in saved snapshots; the adapter has
                # verified their complete normalized engine representation, as in C3-B restore.
                if not curve_interaction and not mixer_target_interaction:
                    pending["settings"] = pending["selected"] if pending["selected"] is not None and action != "operate" else snapshot.settings
                if action == 'operate' and body.get('kind') == 'geometry' and self._fingerprint(snapshot.settings) == self._fingerprint(pending['selected']):
                    # Preserve a legacy snapshot's omitted serde defaults when the operation is a semantic no-op.
                    pending['settings'] = pending['selected']
                pending["stage"] = "save"
            self._history_verify(doc)
            if not curve_interaction and not mixer_target_interaction and self._fingerprint(pending["settings"]) != doc["settingsFingerprint"]:
                raise LightCraftError("raw_history_readback_mismatch")
            if pending.get("recovering") and self._fingerprint(pending["settings"]) == self._fingerprint(self._recipe_recovery_baseline):
                # The initial Import state is only a transient History baseline; a no-op must not create rows.
                pending["stage"] = "complete"
                pending["noOp"] = True
                self._history_initialized = self._history_enabled = False
                lightcraft_log("raw.history.noop", level="debug", assetId=doc["assetId"], saveId=body["saveId"],
                               generation=doc["generation"], revision=doc["revision"])
                return await self._history_response(doc, None)
            kwargs = {"request_fingerprint": pending["fingerprint"],
                      "import_defaults_fingerprint": doc["importDefaultsFingerprint"]}
            args = (pending["identity"], body["expectedRecipeRevision"], body["saveId"], pending["settings"])
            if action == "initialize":
                result = await mutate_raw_edits(self.thumbnail_scheduler(), doc["assetId"], initialize_raw_history, *args, **kwargs)
            elif action in ("commit", "operate"):
                result = await mutate_raw_edits(self.thumbnail_scheduler(), doc["assetId"], append_raw_history, *args,
                                               kind=body["kind"], metadata=body["metadata"],
                                               baseline_settings=self._recipe_recovery_baseline if pending.get("recovering") else None,
                                               **kwargs)
            else:
                result = await mutate_raw_edits(self.thumbnail_scheduler(), doc["assetId"], move_raw_history_cursor, *args,
                                               target_step_id=pending["target"], **kwargs)
            try:
                self._history_verify(doc)
            except LightCraftError:
                raise LightCraftError("raw_history_save_unknown") from None
            if curve_interaction:
                snapshot = self.raw.confirm_curve_interaction(self._raw_handle,
                    body["curveInteractionId"], body["documentRevision"])
                self._history_verify(doc)
                self._confirmed(doc, snapshot)
            if mixer_target_interaction:
                snapshot = self.raw.confirm_mixer_interaction(self._raw_handle,
                    body["mixerInteractionId"], body["documentRevision"])
                self._history_verify(doc)
                self._confirmed(doc, snapshot)
            pending["stage"] = "complete"
            if geometry_commit:
                self._geometry_gesture = None
            self._history_initialized = self._history_enabled = True
            if pending.get("recovering"):
                doc["recipeRecoveryPending"] = False
                self._recipe_recovery_baseline = None
            lightcraft_log("raw.history.saved", level="debug", assetId=doc["assetId"], saveId=body["saveId"],
                           generation=doc["generation"], documentRevision=doc["revision"],
                           mutationAttempts=self.raw.status().edits, revision=result["current"]["revision"],
                           historyCursor=result["current"]["historyCursor"], historyLength=result["current"]["historyLength"])
            return await self._history_response(doc, result)
        except StoreConflict as error:
            code = "raw_history_save_id_reused" if error.code == "save_id_reused" else (
                "raw_history_revision_conflict" if error.code == "revision_conflict" else error.code)
            raise LightCraftError(code) from None
        except InvalidRawRecipe:
            raise LightCraftError("raw_history_invalid") from None
        except StoreUnavailable:
            raise LightCraftError("raw_history_save_failed") from None

    async def _history_wb(self, doc, pending, snapshot):
        verify = lambda: self._history_verify(doc)
        if 'wbExpected' in pending:
            if snapshot.settings == pending['wbExpected']:
                return snapshot
            if snapshot.settings != pending['selected']:
                raise LightCraftError('raw_history_readback_mismatch')
            # A serialized readback proved no application. An explicit retry may apply the frozen candidate once.
            return await self.raw.apply_wb_candidate(self._raw_handle, pending['selected'], pending['wbExpected'],
                                                     snapshot.revision, verify=verify)
        body = pending['request']
        if snapshot.revision != body['documentRevision'] or doc['settingsFingerprint'] != body['settingsFingerprint']:
            self._history_save = None
            raise LightCraftError('raw_wb_stale_result')
        pending['stage'] = 'estimating'

        def prepared(expected):
            verify()
            pending['wbExpected'] = expected
            pending['stage'] = 'applying'

        native_frame = None
        def verify_frame():
            verify()
            if body['kind'] != 'wbPick':
                return
            f = body['frame']
            mapping = self._wb_frames.get((f['kind'], f['quality'], f['maxSide'], f['geometryId']))
            if (not mapping or (f['kind'] == 'after' and mapping[0] != body['documentRevision'])
                    or f['kind'] == 'before' and mapping[1] != doc.get('beforeKey')):
                raise LightCraftError('raw_wb_geometry_mismatch')
            return {**f, 'geometryId': mapping[2]}

        try:
            native_frame = verify_frame()
            return await self.raw.estimate_white_balance(self._raw_handle, snapshot.revision, prepared=prepared, verify=verify_frame, frame=native_frame)
        except BaseException as error:
            if pending['stage'] != 'estimating':
                # A post-fence frame failure cannot certify that no mutation was sent.
                # Keep the candidate/readback recovery instead of publishing a safe-estimate 422.
                if getattr(error, 'code', '').startswith('raw_wb_'):
                    raise LightCraftError('raw_history_readback_mismatch') from None
                raise
            # Before the candidate fence nothing can have mutated. Do not trap a failed estimate as an unknown save.
            self._history_save = None
            if not isinstance(error, Exception):
                raise
            safe = getattr(error, 'code', '')
            if safe in {'lightcraft_timeout', 'lightcraft_busy_timeout', 'raw_operation_timeout', 'raw_busy_timeout'}:
                safe = 'raw_wb_timeout'
            elif safe in {'lightcraft_session_lost', 'raw_session_lost', 'lightcraft_closed', 'lightcraft_eof',
                          'lightcraft_read_failed', 'lightcraft_write_failed', 'lightcraft_not_ready'}:
                safe = 'raw_wb_connection_failed'
            elif safe in {'lightcraft_invalid_json', 'lightcraft_invalid_response', 'lightcraft_invalid_tool_response',
                          'lightcraft_truncated_response', 'lightcraft_response_too_large'}:
                safe = 'raw_wb_invalid_response'
            if safe in {'raw_revision_conflict', 'raw_not_active', 'raw_stale_handle'}:
                safe = 'raw_wb_stale_result'
            if safe not in {'raw_wb_no_valid_samples', 'raw_wb_invalid_response', 'raw_wb_settings_mismatch',
                            'raw_wb_source_unavailable', 'raw_wb_unsupported', 'raw_wb_stale_result',
                            'raw_wb_geometry_mismatch', 'raw_wb_point_outside_source', 'raw_wb_connection_failed', 'raw_wb_timeout'}:
                safe = 'raw_wb_estimation_failed'
            lightcraft_log('raw.wb.failed', level='error', generation=doc['generation'],
                           revision=doc['revision'], errorCode=safe)
            raise LightCraftError(safe) from None

    async def _history_recover(self, doc, body):
        # Explicitly discard an uncommitted native result only after consulting durable SQLite truth.
        if body["documentRevision"] != doc["revision"] or body["settingsFingerprint"] != doc["settingsFingerprint"]:
            raise LightCraftError("raw_revision_conflict")
        state = await self._history_load(doc)
        if not state["recipe"]:
            raise LightCraftError("raw_history_not_initialized")
        if state["revision"] != body["expectedRecipeRevision"]:
            raise LightCraftError("raw_history_revision_conflict")
        pending = self._history_save
        self._history_save = {"stage": "recovering", "request": {}, "action": "recover"}
        try:
            snapshot = await self.raw.get_settings(self._raw_handle)
            self._history_verify(doc)
            if self._fingerprint(snapshot.settings) != self._fingerprint(state["recipe"]["settings"]):
                snapshot = await self.raw.restore_persisted_settings(self._raw_handle, state["recipe"], snapshot.revision)
                self._history_verify(doc)
            # Recovery may read malformed geometry. Publish only the verified saved snapshot.
            self._confirmed(doc, snapshot)
            verified = await self._history_load(doc)
            if verified["revision"] != state["revision"]:
                raise LightCraftError("raw_history_revision_conflict")
            self._history_save = None
            self._geometry_gesture = None
            self._history_enabled = verified["initialized"]
            return await self._history_response(doc, None)
        except BaseException:
            self._history_save = pending or {"stage": "recovering", "request": {}, "action": "recover"}
            raise

    async def _history_checkpoint(self):
        self.raw.reserve_control()
        try:
            await self._history_checkpoint_reserved()
        finally:
            self.raw.release_control()

    async def _history_checkpoint_reserved(self):
        if self.document and self.document.get("recipeRecoveryPending") and not self._history_initialized:
            # No current History exists yet; releasing this Import session cannot alter the retained old tuple.
            return
        self._history_unsettled()
        if self.document is None or not self._history_initialized:
            return
        if self.raw.status().state != "synced":
            raise LightCraftError("raw_history_commit_required")
        if self._recipe_save and not self._recipe_save.get("settled", False):
            raise LightCraftError("raw_recipe_save_pending")
        state = await self._history_load(self.document)
        if state["revision"] != self.document["recipeRevision"]:
            raise LightCraftError("raw_history_revision_conflict")
        if self._fingerprint(state["recipe"]["settings"]) != self.document["settingsFingerprint"]:
            raise LightCraftError("raw_history_commit_required")

    async def _restore_document(self, handle, snapshot):
        # Persistence must bind only after Windows has selected its profile and initialized storage.
        from raw_recipe_store import InvalidRawRecipe, StoreUnavailable, lookup_raw_recipe, get_raw_history
        workspace, cache = self.workspace, self.cache
        identity = self.raw.recipe_identity(handle)
        epoch = self.raw.status().selection_epoch

        def verify():
            if self._closing or self.workspace != workspace or self.cache is not cache or \
                    self._workspace_state != "active" or self.document is not None or \
                    self.raw.status().selection_epoch != epoch:
                raise LightCraftError("raw_stale_handle")
            if self.raw.recipe_identity(handle) != identity:
                raise LightCraftError("raw_stale_handle")

        try:
            saved = await run_in_threadpool(lookup_raw_recipe, identity)
        except (StoreUnavailable, InvalidRawRecipe):
            raise LightCraftError("raw_recipe_unavailable") from None
        verify()
        self._recipe_recovery_baseline = None
        if saved["status"] == "source_mismatch":
            raise LightCraftError(f'raw_recipe_{saved["status"]}')
        if saved["status"] == "engine_incompatible":
            self._recipe_recovery_baseline = json.loads(_settings_json(snapshot.settings))
            lightcraft_log("raw.recipe.incompatible", level="warn", assetId=identity["assetId"],
                           generation=handle.generation, engineVersion=identity["engineVersion"])
            history = await run_in_threadpool(get_raw_history, identity)
            verify()
            self._history_identity = identity
            self._history_initialized = history["initialized"]
            if history["revision"] != 0 or history["initialized"]:
                raise LightCraftError("raw_history_revision_conflict")
            return snapshot, "incompatible", 0, True
        recipe_revision = saved.get("revision", 0) if saved["status"] == "matched" and all(
            saved["recipe"][key] == identity[key] for key in ("engineVersion", "engineCommit")) else 0
        try:
            history = await run_in_threadpool(get_raw_history, identity)
        except (StoreUnavailable, InvalidRawRecipe):
            raise LightCraftError("raw_history_unavailable") from None
        verify()
        if history["revision"] != recipe_revision:
            raise LightCraftError("raw_history_revision_conflict")
        self._history_identity = identity
        self._history_initialized = history["initialized"]
        if saved["status"] == "none":
            lightcraft_log("raw.recipe.none", level="debug", assetId=identity["assetId"])
            return snapshot, "none", 0, False
        snapshot = await self.raw.restore_persisted_settings(handle, saved["recipe"], snapshot.revision)
        verify()
        lightcraft_log("raw.recipe.restored", assetId=identity["assetId"],
                       generation=handle.generation, revision=snapshot.revision)
        return snapshot, "restored", recipe_revision, False

    async def _release(self, *, checkpoint_history=True):
        if self.workspace is None:
            return
        if checkpoint_history:
            await self._history_checkpoint()
        self.document = None
        self._region_geometry.clear()
        self._wb_frames.clear()
        self._recipe_save = None
        self._history_save = self._history_identity = None
        self._recipe_recovery_baseline = None
        self._geometry_gesture = None
        self._history_initialized = self._history_enabled = False
        self._workspace_state = "releasing"
        try:
            # A cleanup retry must not restart the Engine or admit new source references.
            if not self._native_released:
                # Response bodies retain their source/session owner until ASGI send completes.
                await self._images_idle.wait()
                await self.raw.reset_session(restore_active=False)
                self._native_released = True
            await self.cache.close()
        except BaseException:
            self._workspace_state = "cleanup_failed"
            lightcraft_log("raw.workspace.cleanupFailed", level="warn", errorCode="raw_workspace_cleanup_failed")
            raise
        self.cache = None
        self.workspace = None
        self._workspace_state = "empty"
        lightcraft_log("raw.workspace.released", generation=self.manager.status().generation)
        if self._lease_task and self._lease_task is not asyncio.current_task():
            self._lease_task.cancel()

    async def _reset_raw_edits(self, request, body):
        from raw_recipe_store import InvalidRawRecipe, StoreUnavailable, delete_raw_edits
        try:
            asset_id = str(UUID(request.path_params["asset_id"]))
        except (ValueError, TypeError, AttributeError):
            raise LightCraftError("raw_invalid_request") from None
        lightcraft_log("raw.editReset.started", level="info", assetId=asset_id)
        doc = self.document
        if doc is not None:
            required = {"workspaceId", "handle", "generation", "documentToken", "documentRevision"}
            status = self.manager.status()
            if (set(body) != required or doc["assetId"] != asset_id or body["workspaceId"] != self.workspace
                    or body["handle"] != doc["handle"] or body["generation"] != doc["generation"]
                    or body["documentToken"] != doc["documentToken"]
                    or type(body["documentRevision"]) is not int or body["documentRevision"] != doc["revision"]
                    or status.generation != doc["generation"]):
                raise LightCraftError("raw_stale_handle")
            self._reset_asset_id, self._reset_owner = asset_id, dict(doc)
        elif self._reset_asset_id is not None:
            if self._reset_asset_id != asset_id:
                raise LightCraftError("raw_workspace_conflict")
            if self._reset_owner is None:
                if body:
                    raise LightCraftError("raw_invalid_request")
            else:
                required = {"workspaceId", "handle", "generation", "documentToken", "documentRevision"}
                expected = {"workspaceId": self._reset_owner["workspaceId"], "handle": self._reset_owner["handle"],
                    "generation": self._reset_owner["generation"], "documentToken": self._reset_owner["documentToken"],
                    "documentRevision": self._reset_owner["revision"]}
                if (body and (set(body) != required or body != expected)) or (self.workspace is not None and not body):
                    raise LightCraftError("raw_stale_handle")
        elif body:
            raise LightCraftError("raw_invalid_request")
        if self.workspace is not None and self.document is None and self._reset_asset_id != asset_id:
            raise LightCraftError("raw_workspace_conflict")
        self._history_draining = True
        try:
            if self._reset_asset_id is None:
                self._reset_asset_id = asset_id
            if self.workspace is not None:
                try:
                    await self._release(checkpoint_history=False)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    lightcraft_log("raw.editReset.sessionCloseFailed", level="error", assetId=asset_id,
                                   errorCode="raw_edit_reset_session_failed")
                    raise LightCraftError("raw_edit_reset_session_failed") from None
            try:
                result = await mutate_raw_edits(self.thumbnail_scheduler(), asset_id, delete_raw_edits, asset_id)
            except (InvalidRawRecipe, StoreUnavailable):
                lightcraft_log("raw.editReset.databaseFailed", level="error", assetId=asset_id,
                               errorCode="raw_edit_reset_database_failed")
                raise LightCraftError("raw_edit_reset_database_failed") from None
            lightcraft_log("raw.editReset.completed", assetId=asset_id, **result)
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        finally:
            self._history_draining = False

    async def _expire(self):
        try:
            while self.workspace is not None:
                await asyncio.sleep(LEASE_POLL_SECONDS)
                async with self._lock:
                    if monotonic() - self._touched >= LEASE_SECONDS:
                        await self._release()
        except asyncio.CancelledError:
            pass
        except Exception:
            lightcraft_log("raw.lease.cleanupFailed", level="warn", errorCode="raw_cache_cleanup_failed")

    async def close(self):
        if self._close_task is None or self._close_task.done() and (self._close_task.cancelled() or self._close_task.exception() is not None):
            self._close_task = asyncio.create_task(self._close(), name="windows-raw-close")
        if await _await_task_resilient(self._close_task):
            raise asyncio.CancelledError()

    async def _close(self):
        if self._discard_task is not None:
            await asyncio.shield(self._discard_task)
        owner = self.raw
        owner.reserve_control()
        try:
            await self._close_reserved()
        finally:
            owner.release_control()

    async def _close_reserved(self):
        if self._history_initialized or self._history_save or self._history_tasks:
            self._history_draining = True
            try:
                # History native application and its DB acknowledgment own the session until settled.
                if self._tasks:
                    await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
                await self._history_checkpoint()
            finally:
                self._history_draining = False
        self._closing = True
        if self.workspace is not None:
            self._workspace_state = "releasing"
        if self.cache:
            # Only the download is cancellable; native import/render stays owned by Phase 1B.
            self.cache.stop_download()
        if self._lease_task:
            self._lease_task.cancel()
            await asyncio.gather(self._lease_task, return_exceptions=True)
        # Closing the RAW session releases in-flight native calls without cancelling HTTP owners.
        try:
            await self._images_idle.wait()
            await self.raw.close()
            if self._tasks:
                await asyncio.gather(*self._tasks, return_exceptions=True)
            if self._image_tasks:
                await asyncio.gather(*self._image_tasks, return_exceptions=True)
            if self.cache:
                await self.cache.close()
        except BaseException:
            if self.workspace is not None:
                self._workspace_state = "cleanup_failed"
            raise
        self.cache = None
        self.workspace = self.document = None
        self._region_geometry.clear()
        self._wb_frames.clear()
        self._recipe_save = None
        self._history_save = self._history_identity = None
        self._geometry_gesture = None
        self._history_initialized = self._history_enabled = False
        self._workspace_state = "empty"
