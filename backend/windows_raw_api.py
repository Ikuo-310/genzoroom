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
from raw_source import RawSourceCache
from raw_controls import CONTROLS, controls_state, validate_controls, validate_history_operation

REGENERATE_AFTER_EDITS = 200
MAX_JSON_BYTES = 4096
MAX_HISTORY_RESPONSE_BYTES = 16 * 1024
HISTORY_PAGE_SIZE = 20
HISTORY_CONFLICTS = {"raw_history_save_pending", "raw_history_commit_required", "raw_history_client_required",
                     "raw_history_not_initialized", "raw_history_revision_conflict", "raw_history_save_id_reused",
                     "raw_history_target_missing", "raw_history_readback_mismatch", "raw_history_baseline_mismatch",
                     "raw_history_step_id_reused", "raw_recipe_save_pending", "raw_history_requires_operation"}
LEASE_SECONDS = 180
LEASE_POLL_SECONDS = 15


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
        self.cache = None
        self.workspace = self.document = None
        self._lock = asyncio.Lock()
        self._tasks = set()
        self._image_tasks = set()
        self._image_leases = set()
        self._lease_tickets = {}
        self._preview_latest = {}
        self._history_tasks = set()
        self._closing = False
        self._lease_task = None
        self._close_task = None
        self._touched = monotonic()
        self._workspace_state = "empty"
        self._native_released = False
        self._recipe_save = None
        self._history_save = None
        self._history_identity = None
        self._history_initialized = self._history_enabled = self._history_draining = False
        self.app = Starlette(routes=[
            Route("/capabilities", self.capabilities),
            Route("/workspaces", self.endpoint, methods=["POST"]),
            Route("/workspaces/{workspace}", self.endpoint, methods=["DELETE"]),
            Route("/documents", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}", self.endpoint, methods=["GET", "DELETE"]),
            Route("/documents/{handle}/preview", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/preview/cancel", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/settings", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/controls", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/recipe", self.endpoint, methods=["GET", "PUT"]),
            Route("/documents/{handle}/history", self.endpoint, methods=["GET"]),
            *[Route(f"/documents/{{handle}}/history/{action}", self.endpoint, methods=["POST"])
              for action in ("initialize", "commit", "undo", "redo", "jump", "recover", "operate")],
        ])

    def bind(self, raw, manager):
        self.raw, self.manager = raw, manager
        self._closing = False
        self._close_task = None

    def _ready(self):
        if self._closing or self.manager is None or self.manager.status().state != "ready":
            raise LightCraftError("raw_unavailable")

    async def capabilities(self, _request):
        status = self.manager.status() if self.manager else None
        return JSONResponse({"available": bool(status and status.state == "ready" and not self._closing),
                             "state": status.state if status else "disabled", "version": "0.10.0",
                             "workspaceState": self._workspace_state,
                             "cleanupPending": bool(self.cache and self.cache.cleanup_pending),
                             "maxSide": MAX_PREVIEW_SIDE, "maxImageBytes": MAX_IMAGE_BYTES}, headers={"Cache-Control": "no-store"})

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
        try:
            body = await self._body(request) if request.method in {"POST", "PUT"} else {}
            if request.url.path.endswith("/preview/cancel"):
                return self._cancel_preview(request, body)
            preview = request.url.path.endswith("/preview")
            if preview and not self._closing and not self._history_draining and len(self._image_leases) >= 3:
                self._replace_pending_image(request, body)
            if self._closing or self._history_draining or (len(self._image_leases) >= 3 if preview else len(self._tasks) >= 2):
                raise LightCraftError("raw_busy")
            # HTTP cancellation detaches the waiter, never a transmitted MCP operation.
            handler = self._preview if request.url.path.endswith("/preview") else self._execute
            lease = object() if preview else None
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
                        if isinstance(response, _ImageResponse):
                            response.release_lease = lambda: self._release_image_lease(lease)
                        else:
                            self._release_image_lease(lease)
                task.add_done_callback(image_done)
            else:
                self._tasks.add(task)
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
                    # A detached HTTP waiter cannot own a response body that will never be sent.
                    task.add_done_callback(lambda _: self._release_image_lease(lease))
                raise
        except (LightCraftError, TimeoutError) as error:
            code = error.code if isinstance(error, LightCraftError) else "raw_request_timeout"
            if code == "lightcraft_invalid_preview":
                code = "raw_invalid_preview"
            status = (413 if code in {"raw_request_too_large", "raw_source_too_large", "raw_preview_budget_exceeded"} else
                      400 if code in {"raw_invalid_preview_request", "raw_invalid_request", "raw_invalid_controls", "raw_wb_unavailable", "raw_recipe_invalid", "raw_history_invalid"} else
                      503 if code in {"raw_unavailable", "lightcraft_not_ready", "raw_recipe_unavailable", "raw_recipe_save_failed",
                                      "raw_history_unavailable", "raw_history_save_failed", "raw_preview_unsupported"} else
                      409 if code in HISTORY_CONFLICTS or code in {"raw_busy", "raw_workspace_conflict", "raw_stale_handle", "raw_revision_conflict",
                                      "raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending",
                                      "raw_recipe_source_mismatch", "raw_recipe_engine_incompatible",
                                      "raw_recipe_revision_conflict", "raw_recipe_save_id_reused"} else 502)
            return JSONResponse({"code": code}, status_code=status, headers={"Cache-Control": "no-store"})
        except Exception:
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
        self._lease_tickets.pop(lease, None)

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
        return (body.get("mode") == "whole" and type(body.get("maxSide")) is int and 16 <= body["maxSide"] <= MAX_PREVIEW_SIDE
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

    async def _execute(self, request, body):
        async with self._lock:
            path, method = request.url.path, request.method
            if method != "DELETE":
                self._ready()
            if method == "POST" and path.endswith("/workspaces"):
                if body or self.workspace is not None:
                    raise LightCraftError("raw_workspace_conflict")
                self.workspace = secrets.token_hex(16)
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
                    snapshot, recipe_status, recipe_revision = await self._restore_document(handle, snapshot)
                except BaseException:
                    # Import may have partially registered the source; reap before deleting it.
                    await self._release()
                    raise
                self._raw_handle = handle
                self._preview_latest.clear()
                self.document = {"handle": secrets.token_hex(16), "assetId": str(asset_id),
                                 "generation": handle.generation, "documentToken": handle.document_token,
                                 "revision": snapshot.revision, "workspaceId": self.workspace,
                                 "recipeStatus": recipe_status, "recipeRevision": recipe_revision}
                self.document.update(self._edit_budget())
                self.document["settingsFingerprint"] = self._fingerprint(snapshot.settings)
                self.document["recipeFingerprint"] = self.document["settingsFingerprint"]
                self._recipe_save = None
                self._history_save = None
                self._history_enabled = False
                self._wb_available = snapshot.wb_kelvin and snapshot.settings.get("wb", {}).get("scale") == "kelvin"
                self._touched = monotonic()
                lightcraft_log("raw.document.ready", assetId=str(asset_id), generation=handle.generation,
                               revision=snapshot.revision)
                return JSONResponse(self.document)
            settings_request = path.endswith("/settings")
            history_request = "/history" in path
            doc = self._document(request.path_params["handle"], resync=settings_request or history_request)
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
            handle = self._raw_handle
            options = {"kind": kind} if kind == "before" else {}
            if adaptive:
                supported = await self.manager._raw_preview_supported(doc["generation"])
                options.update(max_side=body["maxSide"], serial=body["serial"], view_generation=body["viewGeneration"],
                               geometry_id=body["geometryId"], quality=body["quality"] if supported else None)
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
            return self._preview_response(frame, doc, body, kind, handle)

    def _preview_response(self, frame, doc, body, kind, handle):
        if frame is SUPERSEDED:
            return Response(status_code=204)
        if self._document(doc["handle"]) is not doc or frame.handle != self._raw_handle \
                or frame.kind != kind or len(frame.data) > MAX_IMAGE_BYTES \
                or (kind == "after" and frame.revision != doc["revision"]) \
                or (kind == "before" and frame.frame is None and frame.key != self.raw.before_key(handle)):
            raise LightCraftError("raw_stale_handle")
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
                native_frame["geometryId"] = hashlib.sha256((f"{handle.source_key}:{handle.document_token}:"
                    f"{handle.generation}:{native_frame['geometryId']}").encode()).hexdigest()
                if body["geometryId"] is not None and body["geometryId"] != native_frame["geometryId"]:
                    return Response(status_code=204, headers={"X-Raw-Superseded-Reason": "replaced"})
                headers["X-Raw-Frame"] = json.dumps(native_frame, separators=(",", ":"), ensure_ascii=True)
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
                       "identity": self.raw.recipe_identity(self._raw_handle), "fingerprint": doc["settingsFingerprint"], "settled": False}
            self._recipe_save = pending
        try:
            result = await run_in_threadpool(put_raw_recipe, pending["identity"], body["expectedRecipeRevision"],
                                             body["saveId"], pending["settings"])
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

    def _history_unsettled(self):
        if self._history_save and self._history_save["stage"] != "complete":
            raise LightCraftError("raw_history_save_pending")

    def _history_verify(self, doc):
        if self._closing or self._document(doc["handle"], resync=True) is not doc:
            raise LightCraftError("raw_stale_handle")
        if self.raw.status().state == "synced" and self.raw.recipe_identity(self._raw_handle) != self._history_identity:
            raise LightCraftError("raw_stale_handle")

    def _confirmed(self, doc, snapshot):
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
        metadata = step["metadata"]
        if step["kind"] in ("control", "controlReset"):
            controls = (["wb.temp", "wb.tint"] if step["kind"] == "controlReset"
                        and metadata["control"].startswith("wb.") else [metadata["control"]])
        elif step["kind"] in ("sectionToggle", "sectionReset"):
            section = metadata["section"]
            controls = [control for control in CONTROLS if control.startswith(f"{section}.")
                        or section == "color" and control.startswith("wb.")]
        else:
            controls = list(CONTROLS)

        changes = []
        for control in controls:
            group, key = control.split(".", 1)
            before_group, after_group = before_settings.get(group), after_settings.get(group)
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
    def _history_json(payload, limit=MAX_JSON_BYTES):
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
        elif action == "jump":
            required.add("targetStepId")
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
        if action == "commit":
            from raw_controls import CONTROLS
            metadata = body["metadata"]
            if (body["kind"] != "control" or type(metadata) is not dict or set(metadata) != {"control"}
                    or type(metadata["control"]) is not str or metadata["control"] not in CONTROLS):
                raise LightCraftError("raw_invalid_request")
        elif action == "operate":
            validate_history_operation(body["kind"], body["metadata"])
            kind, metadata = body["kind"], body["metadata"]
            if not self._wb_available and (kind == "allReset" or kind == "sectionReset" and metadata["section"] == "color"
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
                if set(request.query_params) - {"offset", "limit"}:
                    raise ValueError()
                offset = int(request.query_params.get("offset", "0"))
                limit = int(request.query_params.get("limit", str(HISTORY_PAGE_SIZE)))
                if not 0 <= offset <= HISTORY_LIMIT or not 1 <= limit <= HISTORY_PAGE_SIZE:
                    raise ValueError()
            except ValueError:
                raise LightCraftError("raw_invalid_request") from None
            state = await self._history_load(doc)
            history = state["history"]
            steps = history["steps"] if history else []
            baseline = history["baselineSettings"] if history else None
            page_steps = []
            for index, step in enumerate(steps[offset:offset + limit], offset):
                before = baseline if index == 0 else steps[index - 1]["settings"]
                page_steps.append({key: step[key] for key in ("stepId", "kind", "metadata", "createdAt")}
                                  | {"changes": self._history_changes(step, before, step["settings"])})
            return self._history_json({**doc, **self._history_public(doc, state), "offset": offset,
                "limit": limit, "hasMore": offset + limit < len(steps), "steps": page_steps}, MAX_HISTORY_RESPONSE_BYTES)
        action = request.url.path.rsplit("/", 1)[1]
        body = self._history_body(body, doc, action)
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
                    self._history_enabled = True
                    lightcraft_log("raw.history.replayed", level="debug", assetId=doc["assetId"], saveId=body["saveId"],
                                   revision=replay["current"]["revision"], historyCursor=replay["current"]["historyCursor"])
                    return await self._history_response(doc, replay)
            if action == "recover":
                return await self._history_recover(doc, body)
            if not pending or pending["request"].get("saveId") != body["saveId"]:
                self._history_unsettled()
                if body["documentRevision"] != doc["revision"] or body["settingsFingerprint"] != doc["settingsFingerprint"]:
                    raise LightCraftError("raw_revision_conflict")
                state = await self._history_load(doc)
                if state["revision"] != body["expectedRecipeRevision"]:
                    raise LightCraftError("raw_history_revision_conflict")
                if action != "initialize" and not state["initialized"]:
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
                        selected = state["recipe"]["settings"]
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
                           "target": target, "selected": selected}
                self._history_save = pending
                lightcraft_log("raw.history.started", level="debug", assetId=doc["assetId"], saveId=body["saveId"],
                               generation=doc["generation"], revision=doc["revision"], phase=action)
            state = await self._history_load(doc)
            if state["revision"] != body["expectedRecipeRevision"]:
                raise LightCraftError("raw_history_revision_conflict")
            if pending["stage"] != "save":
                snapshot = await self.raw.get_settings(self._raw_handle)
                self._history_verify(doc)
                self._confirmed(doc, snapshot)
                if action in {"initialize", "commit"}:
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
                if action == "operate":
                    pending["stage"] = "applying"
                    snapshot = await self.raw.apply_history_operation(self._raw_handle, body["kind"], body["metadata"], snapshot.revision)
                    self._history_verify(doc)
                    self._confirmed(doc, snapshot)
                # Keep supported legacy omission of WB scale in saved snapshots; the adapter has
                # verified their complete normalized engine representation, as in C3-B restore.
                pending["settings"] = pending["selected"] if pending["selected"] is not None and action != "operate" else snapshot.settings
                pending["stage"] = "save"
            self._history_verify(doc)
            if self._fingerprint(pending["settings"]) != doc["settingsFingerprint"]:
                raise LightCraftError("raw_history_readback_mismatch")
            kwargs = {"request_fingerprint": pending["fingerprint"]}
            args = (pending["identity"], body["expectedRecipeRevision"], body["saveId"], pending["settings"])
            if action == "initialize":
                result = await run_in_threadpool(initialize_raw_history, *args, **kwargs)
            elif action in ("commit", "operate"):
                result = await run_in_threadpool(append_raw_history, *args, kind=body["kind"], metadata=body["metadata"], **kwargs)
            else:
                result = await run_in_threadpool(move_raw_history_cursor, *args, target_step_id=pending["target"], **kwargs)
            try:
                self._history_verify(doc)
            except LightCraftError:
                raise LightCraftError("raw_history_save_unknown") from None
            pending["stage"] = "complete"
            self._history_initialized = self._history_enabled = True
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
            self._confirmed(doc, snapshot)
            if self._fingerprint(snapshot.settings) != self._fingerprint(state["recipe"]["settings"]):
                snapshot = await self.raw.restore_persisted_settings(self._raw_handle, state["recipe"], snapshot.revision)
                self._history_verify(doc)
                self._confirmed(doc, snapshot)
            verified = await self._history_load(doc)
            if verified["revision"] != state["revision"]:
                raise LightCraftError("raw_history_revision_conflict")
            self._history_save = None
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
        if saved["status"] in {"source_mismatch", "engine_incompatible"}:
            raise LightCraftError(f'raw_recipe_{saved["status"]}')
        try:
            history = await run_in_threadpool(get_raw_history, identity)
        except (StoreUnavailable, InvalidRawRecipe):
            raise LightCraftError("raw_history_unavailable") from None
        verify()
        if history["revision"] != saved.get("revision", 0):
            raise LightCraftError("raw_history_revision_conflict")
        self._history_identity = identity
        self._history_initialized = history["initialized"]
        if saved["status"] == "none":
            lightcraft_log("raw.recipe.none", level="debug", assetId=identity["assetId"])
            return snapshot, "none", 0
        snapshot = await self.raw.restore_persisted_settings(handle, saved["recipe"], snapshot.revision)
        verify()
        lightcraft_log("raw.recipe.restored", assetId=identity["assetId"],
                       generation=handle.generation, revision=snapshot.revision)
        return snapshot, "restored", saved["revision"]

    async def _release(self):
        if self.workspace is None:
            return
        await self._history_checkpoint()
        self.document = None
        self._recipe_save = None
        self._history_save = self._history_identity = None
        self._history_initialized = self._history_enabled = False
        self._workspace_state = "releasing"
        try:
            # A cleanup retry must not restart the Engine or admit new source references.
            if not self._native_released:
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
        self.raw.reserve_control()
        try:
            await self._close_reserved()
        finally:
            self.raw.release_control()

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
        self._recipe_save = None
        self._history_save = self._history_identity = None
        self._history_initialized = self._history_enabled = False
        self._workspace_state = "empty"
