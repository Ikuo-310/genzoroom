"""Windows-only RAW editing and durable recipes; no RAW History or Export."""

import asyncio
import hashlib
import json
import secrets
from time import monotonic
from uuid import UUID

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from lightcraft_mcp import LightCraftError
from lightcraft_raw import MAX_EDITS, MAX_IMAGE_BYTES, SUPERSEDED, _settings_json
from lightcraft_runtime import _await_task_resilient, lightcraft_log
from raw_source import RawSourceCache
from raw_controls import controls_state, validate_controls

REGENERATE_AFTER_EDITS = 200
MAX_JSON_BYTES = 4096
LEASE_SECONDS = 180
LEASE_POLL_SECONDS = 15


class RawPreviewApi:
    def __init__(self):
        self.raw = self.manager = None
        self.cache = None
        self.workspace = self.document = None
        self._lock = asyncio.Lock()
        self._tasks = set()
        self._closing = False
        self._lease_task = None
        self._close_task = None
        self._touched = monotonic()
        self._workspace_state = "empty"
        self._native_released = False
        self._recipe_save = None
        self.app = Starlette(routes=[
            Route("/capabilities", self.capabilities),
            Route("/workspaces", self.endpoint, methods=["POST"]),
            Route("/workspaces/{workspace}", self.endpoint, methods=["DELETE"]),
            Route("/documents", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}", self.endpoint, methods=["GET", "DELETE"]),
            Route("/documents/{handle}/preview", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/settings", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/controls", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}/recipe", self.endpoint, methods=["GET", "PUT"]),
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
                             "maxSide": 1024, "maxImageBytes": MAX_IMAGE_BYTES}, headers={"Cache-Control": "no-store"})

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
            if self._closing or len(self._tasks) >= 2:
                raise LightCraftError("raw_busy")
            # HTTP cancellation detaches the waiter, never a transmitted MCP operation.
            task = asyncio.create_task(self._execute(request, body), name="windows-raw-request")
            self._tasks.add(task)
            task.add_done_callback(self._done)
            return await asyncio.shield(task)
        except (LightCraftError, TimeoutError) as error:
            code = error.code if isinstance(error, LightCraftError) else "raw_request_timeout"
            status = (413 if code in {"raw_request_too_large", "raw_source_too_large"} else
                      400 if code in {"raw_invalid_request", "raw_invalid_controls", "raw_wb_unavailable", "raw_recipe_invalid"} else
                      503 if code in {"raw_unavailable", "lightcraft_not_ready", "raw_recipe_unavailable", "raw_recipe_save_failed"} else
                      409 if code in {"raw_busy", "raw_workspace_conflict", "raw_stale_handle", "raw_revision_conflict",
                                      "raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending",
                                      "raw_recipe_source_mismatch", "raw_recipe_engine_incompatible",
                                      "raw_recipe_revision_conflict", "raw_recipe_save_id_reused"} else 502)
            return JSONResponse({"code": code}, status_code=status, headers={"Cache-Control": "no-store"})
        except Exception:
            lightcraft_log("raw.http.failed", level="error", errorCode="raw_operation_failed")
            return JSONResponse({"code": "raw_operation_failed"}, status_code=502,
                                headers={"Cache-Control": "no-store"})

    def _done(self, task):
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            error = task.exception()
            code = error.code if isinstance(error, LightCraftError) else "raw_operation_failed"
            rejection = code in {"raw_busy", "raw_workspace_conflict", "raw_stale_handle", "raw_revision_conflict",
                                 "raw_invalid_request", "raw_invalid_controls", "raw_wb_unavailable",
                                 "raw_source_too_large", "raw_cache_capacity", "raw_disk_capacity"}
            rejection |= code in {"raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending"}
            lightcraft_log("raw.operation.failed", level="warn" if rejection else "error", errorCode=code)

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
                self.document = {"handle": secrets.token_hex(16), "assetId": str(asset_id),
                                 "generation": handle.generation, "documentToken": handle.document_token,
                                 "revision": snapshot.revision, "workspaceId": self.workspace,
                                 "recipeStatus": recipe_status, "recipeRevision": recipe_revision}
                self.document.update(self._edit_budget())
                self.document["settingsFingerprint"] = self._fingerprint(snapshot.settings)
                self.document["recipeFingerprint"] = self.document["settingsFingerprint"]
                self._recipe_save = None
                self._raw_handle = handle
                self._wb_available = snapshot.wb_kelvin and snapshot.settings.get("wb", {}).get("scale") == "kelvin"
                self._touched = monotonic()
                lightcraft_log("raw.document.ready", assetId=str(asset_id), generation=handle.generation,
                               revision=snapshot.revision)
                return JSONResponse(self.document)
            settings_request = path.endswith("/settings")
            doc = self._document(request.path_params["handle"], resync=settings_request)
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
            if set(body) != {"workspaceId", "generation", "documentToken", "revision", "serial"} \
                    or any(type(body.get(key)) is not int for key in ("generation", "revision")) \
                    or any(body.get(key) != doc[key] for key in ("generation", "documentToken", "revision")) \
                    or type(body.get("serial")) is not int or not 0 <= body["serial"] <= 2**31 - 1:
                raise LightCraftError("raw_revision_conflict")
            frame = await self.raw.request_preview(self._raw_handle, doc["revision"])
            if frame is SUPERSEDED:
                return Response(status_code=204)
            if self._document(doc["handle"]) is not doc or frame.handle != self._raw_handle \
                    or frame.revision != doc["revision"] or len(frame.data) > MAX_IMAGE_BYTES:
                raise LightCraftError("raw_stale_handle")
            headers = {"X-Raw-Generation": str(frame.handle.generation), "X-Raw-Token": frame.handle.document_token,
                       "X-Raw-Revision": str(frame.revision), "X-Raw-Epoch": str(frame.selection_epoch),
                       "X-Raw-Sequence": str(frame.sequence), "X-Raw-Serial": str(body["serial"]),
                       "X-Raw-Width": str(frame.width), "X-Raw-Height": str(frame.height),
                       "Cache-Control": "no-store"}
            lightcraft_log("raw.preview.complete", level="debug", assetId=doc["assetId"],
                           generation=frame.handle.generation, revision=frame.revision, bytes=len(frame.data))
            self._touched = monotonic()
            return Response(frame.data, media_type="image/png", headers=headers)

    def _edit_budget(self):
        # The soft boundary leaves 56 attempts for final flush, resync and failed readbacks.
        return {"mutationAttempts": self.raw.status().edits, "mutationLimit": MAX_EDITS,
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
                       "identity": self.raw.recipe_identity(self._raw_handle), "fingerprint": doc["settingsFingerprint"]}
            self._recipe_save = pending
        try:
            result = await run_in_threadpool(put_raw_recipe, pending["identity"], body["expectedRecipeRevision"],
                                             body["saveId"], pending["settings"])
        except StoreConflict as error:
            raise LightCraftError("raw_recipe_save_id_reused" if error.code == "save_id_reused"
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
        lightcraft_log("raw.recipe.saved", level="debug", assetId=doc["assetId"], revision=result["revision"])
        return JSONResponse({**{key: doc[key] for key in ("workspaceId", "handle", "assetId", "generation", "documentToken")},
            "documentRevision": body["documentRevision"], "settingsFingerprint": pending["fingerprint"],
            "recipeRevision": result["revision"], "saveId": result["lastSaveId"], "updatedAt": result["updatedAt"]})

    async def _restore_document(self, handle, snapshot):
        # Persistence must bind only after Windows has selected its profile and initialized storage.
        from raw_recipe_store import InvalidRawRecipe, StoreUnavailable, lookup_raw_recipe
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
        self.document = None
        self._recipe_save = None
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
            if self.cache:
                await self.cache.close()
        except BaseException:
            if self.workspace is not None:
                self._workspace_state = "cleanup_failed"
            raise
        self.cache = None
        self.workspace = self.document = None
        self._recipe_save = None
        self._workspace_state = "empty"
