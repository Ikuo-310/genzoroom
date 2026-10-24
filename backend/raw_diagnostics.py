"""Windows-local, read-only RAW trials with an exclusive diagnostic process owner."""

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import secrets
from time import monotonic
from uuid import UUID

from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from lightcraft_mcp import LightCraftError
from lightcraft_raw import LightCraftRawSession, SUPERSEDED, ENGINE_COMMIT
from lightcraft_runtime import _await_task_resilient, lightcraft_log
from raw_source import RawSourceCache

MAX_REPEATS = 5
MAX_RUN_SECONDS = 600
IDLE_SECONDS = 120


def trial_plan(config):
    if set(config) != {"assetId", "quality", "stageCache", "backend", "temperature", "repeats", "budgetBytes"}:
        raise LightCraftError("raw_invalid_request")
    try:
        asset = str(UUID(config["assetId"]))
    except (ValueError, TypeError, AttributeError):
        raise LightCraftError("raw_invalid_request") from None
    if config["quality"] not in ("draft", "full", "both") or config["stageCache"] not in ("off", "on", "both") or \
            config["backend"] not in ("cpu", "gpu") or config["temperature"] not in ("cold", "warm", "both") or \
            type(config["repeats"]) is not int or not 1 <= config["repeats"] <= MAX_REPEATS or \
            type(config["budgetBytes"]) is not int or not 1 <= config["budgetBytes"] <= 1024**3:
        raise LightCraftError("raw_invalid_request")
    config = {**config, "assetId": asset}
    rows = []
    for cache in ("off", "on") if config["stageCache"] == "both" else (config["stageCache"],):
        for quality in ("draft", "full") if config["quality"] == "both" else (config["quality"],):
            for temperature in ("cold", "warm") if config["temperature"] == "both" else (config["temperature"],):
                for repeat in range(config["repeats"]):
                    rows.append({"index": len(rows), "quality": quality, "stageCache": cache,
                        "temperature": temperature, "repeat": repeat + 1,
                        "group": f"{cache}:{quality}:{temperature}:{repeat if temperature == 'cold' else 0}"})
    return config, rows


class _TrialResponse(Response):
    async def __call__(self, scope, receive, send):
        try:
            async with asyncio.timeout(90):
                await super().__call__(scope, receive, send)
        finally:
            self.release()


class RawDiagnosticsApi:
    def __init__(self, editing):
        self.editing = editing
        self.editing.diagnostics_busy = lambda: self.run is not None
        self.run = self.raw = self.manager = self.cache = None
        self._op = self._lease = self._watcher = None
        self._stop = False
        self._closing = False
        self._close_task = None
        self.app = Starlette(routes=[
            Route("/start", self.endpoint, methods=["POST"]),
            Route("/status", self.endpoint, methods=["POST"]),
            Route("/prepare", self.endpoint, methods=["POST"]),
            Route("/render", self.endpoint, methods=["POST"]),
            Route("/stop", self.endpoint, methods=["POST"]),
        ])

    async def endpoint(self, request):
        try:
            body = await self.editing._body(request)
            action = request.url.path.rsplit("/", 1)[-1]
            if action == "start":
                return await self._start(body)
            if not self.run and action in ("status", "stop") and set(body) == {"runId"}:
                return JSONResponse(self._status())
            if not self.run or body.get("runId") != self.run["id"]:
                raise LightCraftError("raw_stale_handle")
            if action in ("status", "stop"):
                if set(body) != {"runId"}:
                    raise LightCraftError("raw_invalid_request")
                if action == "stop":
                    self._stop = True
                    if self.cache:
                        self.cache.stop_download()
                    if not self._op:
                        self._launch(self._cleanup(), cleanup_on_stop=False)
                return JSONResponse(self._status())
            if set(body) != {"runId", "index"} or type(body["index"]) is not int or body["index"] != self.run["next"]:
                raise LightCraftError("raw_invalid_request")
            if self._op or self._lease or self._stop or self._closing:
                raise LightCraftError("raw_busy")
            self._check_deadline()
            if action == "prepare":
                task = self._launch(self._prepare())
            else:
                if not self.run["prepared"]:
                    raise LightCraftError("raw_invalid_request")
                task = self._launch(self._render())
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                # A detached waiter still owns a transmitted native call until its reply is collected.
                self._stop = True
                task.add_done_callback(lambda done: self._detach_response(done))
                raise
        except LightCraftError as error:
            code = error.code
            if not code.startswith(("raw_", "lightcraft_")):
                code = "raw_diagnostic_failed"
            status = 400 if code == "raw_invalid_request" else 409 if code in ("raw_busy", "raw_stale_handle") else 503 if code == "raw_preview_unsupported" else 502
            return JSONResponse({"code": code}, status_code=status)
        except Exception:
            lightcraft_log("raw.diagnostic.failed", level="error", errorCode="raw_diagnostic_failed")
            return JSONResponse({"code": "raw_diagnostic_failed"}, status_code=502)

    async def _start(self, body):
        config, plan = trial_plan(body)
        # The editing API checks the same event-loop flag while holding this lock.
        async with self.editing._lock:
            if self._closing or self.run or self._op or self._lease or self.editing.workspace is not None or self.editing._tasks or self.editing._image_leases:
                raise LightCraftError("raw_busy")
            if not self.editing.manager or self.editing.manager.status().state != "ready":
                raise LightCraftError("raw_preview_unsupported")
            self._stop = False
            self.run = {"id": secrets.token_hex(16), "config": config, "plan": plan, "next": 0,
                "prepared": False, "group": None, "settings": None, "binary": None,
                "started": monotonic(), "touched": monotonic(), "state": "ready", "error": None}
            self.cache = RawSourceCache()
            self._watcher = asyncio.create_task(self._watch(self.run), name="raw-diagnostic-deadline")
            self._watcher.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            lightcraft_log("raw.diagnostic.started", backend=config["backend"], trialCount=len(plan))
            return JSONResponse({"runId": self.run["id"], "plan": plan, "maxSide": 1024,
                "maxSeconds": MAX_RUN_SECONDS, "maxRepeats": MAX_REPEATS})

    def _status(self):
        return {"state": self.run["state"] if self.run else "closed", "nextIndex": self.run["next"] if self.run else None,
                "errorCode": self.run["error"] if self.run else None, "stopping": self._stop}

    def _check_deadline(self):
        if monotonic() - self.run["started"] > MAX_RUN_SECONDS:
            self._stop = True
        if self._stop:
            raise LightCraftError("raw_diagnostic_cancelled")
        self.run["touched"] = monotonic()

    def _launch(self, action, *, cleanup_on_stop=True):
        async def owned():
            try:
                return await action
            except asyncio.CancelledError:
                if not self._stop:
                    raise
                raise LightCraftError("raw_diagnostic_cancelled") from None
            except Exception as error:
                self._stop = True
                if self.run:
                    self.run["error"] = error.code if isinstance(error, LightCraftError) else "raw_diagnostic_failed"
                lightcraft_log("raw.diagnostic.operationFailed", level="info" if isinstance(error, LightCraftError) and error.code == "raw_diagnostic_cancelled" else "error",
                    errorCode=error.code if isinstance(error, LightCraftError) else "raw_diagnostic_failed")
                raise
            finally:
                if self._stop and cleanup_on_stop:
                    await self._cleanup()
        task = asyncio.create_task(owned(), name="raw-diagnostic-operation")
        self._op = task
        def complete(done):
            if self._op is done:
                self._op = None
            if not done.cancelled():
                done.exception()
        task.add_done_callback(complete)
        return task

    def _detach_response(self, task):
        if not task.cancelled() and task.exception() is None:
            response = task.result()
            if isinstance(response, _TrialResponse):
                response.release()

    async def _prepare(self):
        run = self.run
        self._check_deadline()
        if run["next"] >= len(run["plan"]):
            raise LightCraftError("raw_invalid_request")
        trial = run["plan"][run["next"]]
        if trial["group"] != run["group"]:
            await self._close_native()
            self._check_deadline()
            if "source" not in run:
                run["source"] = await self.cache.download(UUID(run["config"]["assetId"]))
            self._check_deadline()
            self.manager = self.editing.manager.diagnostic_manager("off" if run["config"]["backend"] == "cpu" else "dx12")
            self.raw = LightCraftRawSession(self.manager, stage_cache=trial["stageCache"],
                stage_cache_budget_bytes=run["config"]["budgetBytes"] if trial["stageCache"] == "on" else None, diagnostics=True)
            await self.manager.start()
            async with asyncio.timeout(35):
                while self.manager.status().state in ("starting", "initializing"):
                    await asyncio.sleep(.02)
            if self.manager.status().state != "ready":
                raise LightCraftError("raw_diagnostic_start_failed")
            if not await self.manager._raw_preview_supported(self.manager.status().generation):
                raise LightCraftError("raw_preview_unsupported")
            binary = self.manager.status().executable_sha256
            if run["binary"] is not None and run["binary"] != binary:
                raise LightCraftError("raw_diagnostic_binary_changed")
            run["binary"] = binary
            self._check_deadline()
            handle, snapshot = await self.raw.open_raw(run["config"]["assetId"], str(run["source"]))
            run["handle"] = handle
            fingerprint = hashlib.sha256(snapshot._json.encode()).hexdigest()
            if run["settings"] is not None and run["settings"] != fingerprint:
                raise LightCraftError("raw_diagnostic_settings_changed")
            run["settings"] = fingerprint
            photo = self.raw._photos[handle.source_key]
            run["sourceMetadata"] = {"width": photo.source_size[0], "height": photo.source_size[1],
                "format": run["source"].suffix.lstrip(".").upper(),
                "identity": hashlib.sha256(photo.content_hash.encode()).hexdigest()}
            run["group"] = trial["group"]
            if trial["temperature"] == "warm":
                await self._frame(trial)
            self._check_deadline()
        run["prepared"] = True
        return JSONResponse({"preparedIndex": run["next"]})

    async def _frame(self, trial):
        snapshot = await self.raw.get_settings(self.run["handle"])
        if hashlib.sha256(snapshot._json.encode()).hexdigest() != self.run["settings"]:
            raise LightCraftError("raw_diagnostic_settings_changed")
        frame = await self.raw.request_preview(snapshot.handle, snapshot.revision, 1024,
            quality=trial["quality"], serial=trial["index"] + 1)
        if frame is SUPERSEDED:
            raise LightCraftError("raw_diagnostic_settings_changed")
        return frame

    async def _render(self):
        self._check_deadline()
        run = self.run
        trial = run["plan"][run["next"]]
        gpu_before = await self.manager.get_gpu_info()
        self._check_deadline()
        frame = await self._frame(trial)
        gpu_after = await self.manager.get_gpu_info()
        self._check_deadline()
        cpu = run["config"]["backend"] == "cpu" and not gpu_before.enabled and not gpu_after.enabled
        metadata = {"trial": trial, "measuredAt": datetime.now(timezone.utc).isoformat(),
            "contract": {"lightcraftVersion": "0.10.0", "engineCommit": ENGINE_COMMIT,
                "previewContract": 1, "binarySha256": run["binary"]},
            "source": run["sourceMetadata"], "settingsFingerprint": run["settings"], "frame": frame.frame,
            "backend": {"configured": run["config"]["backend"], "execution": "cpu" if cpu else "unconfirmed",
                "gpuAvailable": gpu_after.available, "fallbackReported": bool(gpu_before.last_fallback or gpu_after.last_fallback)},
            "width": frame.width, "height": frame.height, "payloadBytes": len(frame.data),
            "metrics": frame.metrics, "rssBytes": None, "vramBytes": None}
        execution = frame.metrics.get("execution") if frame.metrics else None
        if execution:
            # A process-wide lastFallback can describe an earlier render; prefer this result's evidence.
            metadata["backend"]["execution"] = execution["backend"]
            metadata["backend"]["fallbackReported"] = execution["outcome"] == "cpu_fallback"
        encoded = json.dumps(metadata, separators=(",", ":"), allow_nan=False)
        if len(encoded) > 16 * 1024:
            raise LightCraftError("raw_diagnostic_failed")
        lease = object()
        self._lease = lease
        def release():
            if self._lease is lease:
                self._lease = None
        response = _TrialResponse(frame.data, media_type="image/png", headers={"X-Raw-Diagnostic": encoded})
        response.release = release
        run["next"] += 1
        run["prepared"] = False
        run["touched"] = monotonic()
        return response

    async def _close_native(self):
        if self.raw:
            await self.raw.close()
            self.raw = None
        if self.manager:
            await self.manager.close()
            self.manager = None

    async def _cleanup(self):
        try:
            await self._close_native()
            if self.cache:
                await self.cache.close()
                self.cache = None
            self.run = None
        except BaseException:
            if self.run:
                self.run["state"], self.run["error"] = "cleanup_failed", "raw_diagnostic_cleanup_failed"
            raise

    async def _watch(self, owner):
        while self.run is owner and not self._closing:
            await asyncio.sleep(1)
            if self.run is not owner:
                break
            if monotonic() - owner["started"] > MAX_RUN_SECONDS or not self._op and monotonic() - owner["touched"] > IDLE_SECONDS:
                self._stop = True
                if self.cache:
                    self.cache.stop_download()
                if not self._op:
                    await self._launch(self._cleanup(), cleanup_on_stop=False)

    async def close(self):
        if self._close_task is None or self._close_task.done() and self._close_task.exception() is not None:
            self._close_task = asyncio.create_task(self._close(), name="raw-diagnostic-close")
        if await _await_task_resilient(self._close_task):
            raise asyncio.CancelledError()

    async def _close(self):
        self._closing = self._stop = True
        if self.cache:
            self.cache.stop_download()
        if self._op:
            try:
                await _await_task_resilient(self._op)
            except Exception:
                pass  # The operation failure is reported separately; cleanup below remains mandatory.
        await self._cleanup()
        if self._watcher:
            self._watcher.cancel()
            await asyncio.gather(self._watcher, return_exceptions=True)
