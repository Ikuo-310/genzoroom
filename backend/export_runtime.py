"""Request-independent serial worker; production Start awaits Phase 5E boundaries."""

import asyncio
import threading
from dataclasses import dataclass
from typing import Protocol, Sequence
from uuid import UUID, uuid4

from starlette.concurrency import run_in_threadpool

from edit_store import StoreUnavailable
from export_artifact import ExportArtifact, create_export_artifact
from export_runtime_store import (
    ExportRunItem, FAILURE_CODES, RuntimeRejected, complete_export_item, create_export_run,
    fail_export_item, recoverable_export_run, runtime_log, transition_export_item,
    begin_export_item, reclaim_export_run, request_export_stop,
)
from immich import AssetDetail, ImmichOriginal, get_asset_detail, get_asset_original
from jpeg_codec import JpegCodecError, decode_jpeg
from jpeg_renderer import JpegRenderer


# One coordinator may execute in this process, even across different event loops/instances.
_process_worker_lock = threading.Lock()


@dataclass(frozen=True)
class RegistrationContext:
    run_id: UUID
    asset_id: UUID
    position: int
    frozen_revision: int
    recipe_version: int
    processing_version: str


@dataclass(frozen=True)
class RegistrationResult:
    registered_asset_id: UUID


class ExportRegistrar(Protocol):
    async def register(self, source: AssetDetail, artifact: ExportArtifact,
                       context: RegistrationContext) -> RegistrationResult: ...


class FamilyFilenameProvider(Protocol):
    async def filenames(self, source: AssetDetail, context: RegistrationContext) -> Sequence[str]: ...


class ExportSource(Protocol):
    async def detail(self, asset_id: UUID) -> AssetDetail: ...
    async def original(self, asset_id: UUID) -> ImmichOriginal: ...


class _RuntimeStoreFailure(Exception):
    def __init__(self, code):
        self.code = code


async def _persist(operation, *args):
    try:
        return await run_in_threadpool(operation, *args)
    except (StoreUnavailable, RuntimeRejected) as error:
        # Only our DB operations halt the worker; provider/registrar errors fail that item.
        raise _RuntimeStoreFailure(error.code) from None


class ImmichExportSource:
    def __init__(self, url: str | None, api_key: str | None, *, transport=None):
        self._url, self._api_key, self._transport = url, api_key, transport

    async def detail(self, asset_id: UUID) -> AssetDetail:
        return await get_asset_detail(self._url, self._api_key, asset_id, transport=self._transport)

    async def original(self, asset_id: UUID) -> ImmichOriginal:
        return await get_asset_original(self._url, self._api_key, asset_id, transport=self._transport)


def _artifact(source: bytearray, filename: str, family: Sequence[str], recipe: dict) -> ExportArtifact:
    try:
        image = decode_jpeg(source)
        rendered = JpegRenderer().render(image, recipe)
        image = None
        return create_export_artifact(source, filename, family, rendered)
    finally:
        # No source/render buffers survive the threadpool call or enter the registrar context.
        source.clear()


class ExportRuntime:
    def __init__(self, *, source: ExportSource | None = None,
                 family: FamilyFilenameProvider | None = None, registrar: ExportRegistrar | None = None):
        self._source, self._family, self._registrar = source, family, registrar
        self._start_lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    async def inspect_recovery(self):
        run = await run_in_threadpool(recoverable_export_run)
        if run is not None:
            runtime_log("run.recoveryIdentified", level="warn", runId=str(run.run_id),
                        targetCount=len(run.items), activeCount=sum(item.status in ("waiting", "encoding", "registering")
                                                                  for item in run.items))
        return run

    async def start(self, asset_ids: Sequence[UUID]) -> UUID:
        if self._source is None or self._family is None or self._registrar is None:
            # Production family/registration adapters remain unavailable until Phase 5E.
            raise RuntimeRejected("runtime_not_configured")
        ids = list(asset_ids)
        async with self._start_lock:
            if self._task is not None and not self._task.done():
                raise RuntimeRejected("run_active")
            ready = asyncio.get_running_loop().create_future()
            # Retrieve errors even if a disconnected caller no longer awaits the ready signal.
            ready.add_done_callback(lambda result: None if result.cancelled() else result.exception())
            self._task = asyncio.create_task(self._serve(ids, ready))
        # Creation + dispatch are owned by the coordinator, including cancellation at commit.
        return await asyncio.shield(ready)

    async def recover(self) -> UUID | None:
        run = await self.inspect_recovery()
        if run is None:
            return None
        if self._source is None or self._family is None or self._registrar is None:
            runtime_log("recovery.deferred", runId=str(run.run_id), errorCode="runtime_not_configured")
            return None
        async with self._start_lock:
            if self._task is not None and not self._task.done():
                raise RuntimeRejected("run_active")
            ready = asyncio.get_running_loop().create_future()
            ready.add_done_callback(lambda result: None if result.cancelled() else result.exception())
            self._task = asyncio.create_task(self._serve(None, ready, recovery=run))
        return await asyncio.shield(ready)

    async def stop(self, run_id: UUID):
        # Stop is a durable intent; it never cancels the asyncio worker or a JPEG thread.
        return await run_in_threadpool(request_export_stop, run_id)

    async def wait(self):
        if self._task is not None:
            await asyncio.shield(self._task)

    async def _serve(self, ids, ready, recovery=None):
        run = None
        acquired = False
        try:
            acquired = _process_worker_lock.acquire(blocking=False)
            if not acquired:
                raise RuntimeRejected("run_active")
            if recovery is None:
                run = await run_in_threadpool(create_export_run, ids, worker_id=uuid4())
            else:
                runtime_log("recovery.started", runId=str(recovery.run_id))
                run = await run_in_threadpool(reclaim_export_run, recovery.run_id, recovery.worker_id, uuid4())
            item = await _persist(begin_export_item, run.run_id, run.worker_id)
            ready.set_result(run.run_id)
            while True:
                if item is None:
                    break
                await self._process_item(run.run_id, run.worker_id, item)
                item = await _persist(begin_export_item, run.run_id, run.worker_id)
            if recovery is not None:
                runtime_log("recovery.completed", runId=str(run.run_id))
        except asyncio.CancelledError:
            # Process shutdown preserves checkpoints; browser cancellation never reaches this task.
            if not ready.done():
                ready.set_exception(RuntimeRejected("worker_interrupted"))
            runtime_log("run.interrupted", level="warn", runId=str(run.run_id) if run else None)
            raise
        except Exception as error:
            # Store/ownership failures leave active work recoverable, rather than guessing a reset.
            code = error.code if isinstance(error, (StoreUnavailable, RuntimeRejected, _RuntimeStoreFailure)) else "worker_failed"
            if not ready.done():
                ready.set_exception(error if isinstance(error, (StoreUnavailable, RuntimeRejected))
                                    else RuntimeRejected("worker_failed"))
            runtime_log("run.workerFailed", level="error", runId=str(run.run_id) if run else None, errorCode=code)
            if recovery is not None:
                runtime_log("recovery.failed", level="error", runId=str(recovery.run_id), errorCode=code)
        finally:
            if acquired:
                _process_worker_lock.release()

    async def _process_item(self, run_id: UUID, worker_id: UUID, item: ExportRunItem):
        context = RegistrationContext(run_id, item.asset_id, item.position, item.frozen_revision,
                                      item.recipe_version, item.processing_version)
        source = bytearray()
        original = artifact = detail = family = None
        status, phase = "waiting", "source"
        runtime_log("item.started", runId=str(run_id), assetId=str(item.asset_id),
                    position=item.position, frozenRevision=item.frozen_revision)
        try:
            runtime_log("acquisition.started", level="debug", runId=str(run_id), assetId=str(item.asset_id))
            detail = await self._source.detail(item.asset_id)
            if detail.id != item.asset_id or detail.format != "JPEG" or detail.is_raw:
                await _persist(fail_export_item, run_id, item.asset_id, worker_id, status, "source_not_jpeg")
                return
            try:
                original = await self._source.original(item.asset_id)
                async for chunk in original.chunks():
                    source.extend(chunk)
            finally:
                if original is not None:
                    await original.close()
                    original = None
            runtime_log("acquisition.completed", level="debug", runId=str(run_id), assetId=str(item.asset_id),
                        sourceBytes=len(source))
            phase = "family"
            family = await self._family.filenames(detail, context)
            if not isinstance(family, (list, tuple)) or any(type(name) is not str for name in family):
                raise ValueError("invalid_family_context")
            await _persist(transition_export_item, run_id, item.asset_id, worker_id, "waiting", "encoding")
            status, phase = "encoding", "encoding"
            runtime_log("encoding.started", level="debug", runId=str(run_id), assetId=str(item.asset_id))
            artifact = await run_in_threadpool(_artifact, source, detail.filename, family, item.recipe)
            runtime_log("encoding.completed", runId=str(run_id), assetId=str(item.asset_id), artifactBytes=len(artifact.jpeg))
            await _persist(transition_export_item, run_id, item.asset_id, worker_id, "encoding", "registering")
            status, phase = "registering", "registration"
            runtime_log("registration.boundaryReached", runId=str(run_id), assetId=str(item.asset_id))
            result = await self._registrar.register(detail, artifact, context)
            if not isinstance(result, RegistrationResult) or type(result.registered_asset_id) is not UUID:
                code = "invalid_registration_result"
                await _persist(fail_export_item, run_id, item.asset_id, worker_id, status, code)
                return
            await _persist(complete_export_item, run_id, item.asset_id, worker_id, result.registered_asset_id)
        except _RuntimeStoreFailure:
            raise
        except Exception as error:
            code = {"source": "source_fetch_failed", "family": "family_context_failed",
                    "encoding": "encoding_failed", "registration": "registration_failed"}[phase]
            if isinstance(error, JpegCodecError) and error.code in FAILURE_CODES:
                code = error.code
            # An item failure continues the run; explicit Retry creates fresh Queue intent later.
            await _persist(fail_export_item, run_id, item.asset_id, worker_id, status, code)
        finally:
            source.clear()
            original = artifact = detail = family = None
