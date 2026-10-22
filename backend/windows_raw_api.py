"""Windows-only C1 RAW Preview API; no editing, persistence or Export commands."""

import asyncio
import json
import secrets
from time import monotonic
from uuid import UUID

from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from lightcraft_mcp import LightCraftError
from lightcraft_raw import MAX_IMAGE_BYTES, SUPERSEDED
from lightcraft_runtime import _await_task_resilient, lightcraft_log
from raw_source import RawSourceCache

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
        self.app = Starlette(routes=[
            Route("/capabilities", self.capabilities),
            Route("/workspaces", self.endpoint, methods=["POST"]),
            Route("/workspaces/{workspace}", self.endpoint, methods=["DELETE"]),
            Route("/documents", self.endpoint, methods=["POST"]),
            Route("/documents/{handle}", self.endpoint, methods=["GET", "DELETE"]),
            Route("/documents/{handle}/preview", self.endpoint, methods=["POST"]),
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
            body = await self._body(request) if request.method == "POST" else {}
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
                      400 if code == "raw_invalid_request" else
                      503 if code in {"raw_unavailable", "lightcraft_not_ready"} else
                      409 if code in {"raw_busy", "raw_workspace_conflict", "raw_stale_handle", "raw_revision_conflict",
                                      "raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending"} else 502)
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
                                 "raw_invalid_request", "raw_source_too_large", "raw_cache_capacity", "raw_disk_capacity"}
            rejection |= code in {"raw_workspace_releasing", "raw_workspace_cleanup_failed", "raw_cache_cleanup_pending"}
            lightcraft_log("raw.operation.failed", level="warn" if rejection else "error", errorCode=code)

    def _owner(self, workspace):
        if self.workspace is None or workspace != self.workspace:
            raise LightCraftError("raw_workspace_conflict")
        self._touched = monotonic()

    def _document(self, handle):
        self._ready()
        doc = self.document
        if doc is None or doc["handle"] != handle or doc["generation"] != self.manager.status().generation:
            raise LightCraftError("raw_stale_handle")
        if self.raw.status().state in {"lost", "desynchronized", "stopped", "closing"}:
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
            workspace = body.get("workspaceId") if method == "POST" else request.headers.get("x-raw-workspace")
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
                except BaseException:
                    # Import may have partially registered the source; reap before deleting it.
                    await self._release()
                    raise
                self.document = {"handle": secrets.token_hex(16), "assetId": str(asset_id),
                                 "generation": handle.generation, "documentToken": handle.document_token,
                                 "revision": snapshot.revision, "workspaceId": self.workspace}
                self._raw_handle = handle
                self._touched = monotonic()
                lightcraft_log("raw.document.ready", assetId=str(asset_id), generation=handle.generation,
                               revision=snapshot.revision)
                return JSONResponse(self.document)
            doc = self._document(request.path_params["handle"])
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

    async def _release(self):
        if self.workspace is None:
            return
        self.document = None
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
        self._workspace_state = "empty"
