"""Windows-owned LightCraft session, independent of JPEG and persistence services."""

import asyncio
from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
import sys
import threading
import shutil
import tempfile
import uuid

from backend_logging import backend_logger
from lightcraft_artifact import ENGINE_VERSION, verified_artifact
from lightcraft_mcp import LightCraftError, LightCraftMCP, MAX_PREVIEW_LINE_BYTES, MCPTransportError


@dataclass(frozen=True)
class LightCraftTimeouts:
    initialize: float = 10
    request: float = 5
    gpu: float = 15
    shutdown: float = 3
    kill: float = 2
    temp_io: float = 2


@dataclass(frozen=True)
class LightCraftStatus:
    state: str
    generation: int
    version: str | None
    executable_sha256: str | None
    error_code: str | None


@dataclass(frozen=True)
class GpuInfo:
    enabled: bool
    available: bool
    adapter: str | None
    reason: str | None
    last_fallback: str | None


@dataclass
class _Session:
    generation: int
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    process: object = None
    client: LightCraftMCP | None = None
    stderr_task: asyncio.Task | None = None
    wait_task: asyncio.Task | None = None
    reaped: bool = False
    temp_directory: Path | None = None
    temp_root: Path | None = None
    temp_lock: threading.Lock = field(default_factory=threading.Lock)
    before_preview: bool | None = None
    adaptive_preview: bool | None = None
    region_preview: bool | None = None


def lightcraft_log(event, *, level="info", **context):
    try:
        backend_logger.add(level=level, component="lightcraft", event=event, context=context)
    except Exception:
        pass


def child_environment(parent, *, gpu_backend="dx12", temp_directory=None):
    if gpu_backend not in ("dx12", "off"):
        raise ValueError("lightcraft_invalid_gpu_backend")
    # Copy only OS runtime locations; arbitrary inherited keys can contain credentials.
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA",
               "USERPROFILE", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
               "PROCESSOR_ARCHITECTURE"}
    result = {key.upper(): value for key, value in parent.items() if key.upper() in allowed}
    root = result.get("SYSTEMROOT") or result.get("WINDIR")
    if root:
        # Frozen Python's PATH and developer GPU/compiler overrides do not belong to the CLI.
        result["PATH"] = str(Path(root) / "System32") + os.pathsep + root
    result["LIGHTCRAFT_GPU_BACKEND"] = gpu_backend
    result["LIGHTCRAFT_LOG"] = "warn"
    if temp_directory is not None:
        result["TEMP"] = result["TMP"] = str(temp_directory)
    return result


def _check_temp(session):
    path = session.temp_directory
    if path is None or session.temp_root is None or path.parent != session.temp_root or \
            not path.name.startswith(f"genzoroom-lightcraft-{session.generation}-") or \
            path.is_symlink() or path.resolve() != path:
        raise LightCraftError("lightcraft_temp_cleanup_failed")
    return path


def _remove_temp(session):
    with session.temp_lock:
        path = _check_temp(session)
        if path.exists():
            # Never derive a recursive removal target from a child's response or an ambient TEMP.
            shutil.rmtree(path)


def _remove_preview_files(session):
    with session.temp_lock:
        path = _check_temp(session)
        pid = getattr(session.process, "pid", None)
        if pid is None:
            return
        for file in path.glob(f"lightcraft-mcp-{pid}-*-render.png"):
            if file.is_file() and not file.is_symlink():
                file.unlink(missing_ok=True)


def _trusted_temp_root(configured=None, *, windows=None):
    windows = os.name == "nt" if windows is None else windows
    configured = tempfile.gettempdir() if configured is None else configured
    # Check the raw spelling first because Path.resolve can normalize a UNC path unexpectedly.
    if windows:
        if str(configured).startswith(("\\\\", "//")):
            raise LightCraftError("lightcraft_temp_location_unsupported")
    root = Path(configured).resolve(strict=True)
    if windows:
        if str(root).startswith(("\\\\", "//")):
            raise LightCraftError("lightcraft_temp_location_unsupported")
        try:
            import ctypes
            get_drive_type = ctypes.windll.kernel32.GetDriveTypeW
            get_drive_type.argtypes = [ctypes.c_wchar_p]
            get_drive_type.restype = ctypes.c_uint
            drive_type = get_drive_type(root.anchor)
        except Exception:
            raise LightCraftError("lightcraft_temp_location_unverified") from None
        if drive_type != 3:  # DRIVE_FIXED; do not place RAW intermediates on removable/network storage.
            raise LightCraftError("lightcraft_temp_location_unsupported")
    if not root.is_dir():
        raise LightCraftError("lightcraft_temp_location_unavailable")
    return root


def _create_temp_directory(session):
    # Resolve ambient TEMP only in the daemon worker; UNC and mapped network drives are rejected.
    root = _trusted_temp_root()
    with session.temp_lock:
        if session.stop.is_set():
            return
        path = root / f"genzoroom-lightcraft-{session.generation}-{uuid.uuid4().hex}"
        session.temp_root, session.temp_directory = root, path
        try:
            path.mkdir()
        except OSError:
            # mkdir is atomic; without success this candidate is not ours to remove later.
            session.temp_root = session.temp_directory = None
            raise
        # If close raced a slow mkdir, its cleanup worker follows this same lock and owned path.
        if session.stop.is_set():
            shutil.rmtree(path)


async def _bounded_temp_io(function, *args, timeout):
    """Bound slow filesystem calls without leaving a non-daemon executor worker behind."""
    loop = asyncio.get_running_loop()
    result = loop.create_future()

    def deliver(outcome):
        if not result.done():
            result.set_result(outcome)

    def run():
        try:
            outcome = (function(*args), None)
        except LightCraftError as error:
            outcome = (None, error.code)
        except Exception:
            outcome = (None, "lightcraft_temp_io_failed")
        try:
            loop.call_soon_threadsafe(deliver, outcome)
        except RuntimeError:
            pass

    threading.Thread(target=run, name="lightcraft-temp-io", daemon=True).start()
    try:
        async with asyncio.timeout(timeout):
            value, error = await asyncio.shield(result)
    except TimeoutError:
        raise LightCraftError("lightcraft_temp_io_timeout") from None
    if error:
        raise LightCraftError(error)
    return value


def _executable_info(value):
    path = Path(value)
    if not path.is_absolute():
        raise LightCraftError("lightcraft_invalid_path")
    if os.name == "nt" and str(path).startswith(("\\\\", "//")):
        raise LightCraftError("lightcraft_network_path_unsupported")
    try:
        if not path.is_file():
            raise LightCraftError("lightcraft_executable_missing")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
    except OSError:
        raise LightCraftError("lightcraft_executable_unreadable") from None
    return str(path), digest


async def _inspect_executable(value, stop, register_thread):
    """Run potentially stalled filesystem work outside the loop and beyond its executor shutdown."""
    loop = asyncio.get_running_loop()
    result = loop.create_future()

    def inspect():
        try:
            executable, digest = _executable_info(value)
            # Receipt I/O has the same bounded daemon owner as hashing, never the loop executor.
            artifact = verified_artifact(executable, digest, ENGINE_VERSION)
            outcome = ((executable, digest, artifact), None)
        except LightCraftError as error:
            outcome = (None, error.code)
        except Exception:
            outcome = (None, "lightcraft_executable_unreadable")
        try:
            loop.call_soon_threadsafe(_deliver, outcome)
        except RuntimeError:
            pass

    def _deliver(outcome):
        if not result.done():
            result.set_result(outcome)

    thread = threading.Thread(target=inspect, name="lightcraft-exe-inspection", daemon=True)
    register_thread(thread)
    thread.start()
    stop_task = asyncio.create_task(stop.wait())
    try:
        done, _ = await asyncio.wait((result, stop_task), return_when=asyncio.FIRST_COMPLETED)
        if stop_task in done:
            return None
        value, error_code = result.result()
        if error_code:
            raise LightCraftError(error_code)
        return value
    finally:
        stop_task.cancel()
        await asyncio.gather(stop_task, return_exceptions=True)


async def _await_task_resilient(task):
    """Finish owned cleanup even when the awaiting lifecycle task is cancelled."""
    cancelled = False
    current = asyncio.current_task()
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done() and task.cancelled() and current.cancelling() == 0:
                break
            cancelled = True
            current.uncancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    return cancelled


class LightCraftManager:
    def __init__(self, *, environment=None, platform=None, spawn=None, timeouts=None, gpu_backend="dx12"):
        if gpu_backend not in ("dx12", "off"):
            raise ValueError("lightcraft_invalid_gpu_backend")
        self._gpu_backend = gpu_backend
        self._environment = dict(os.environ if environment is None else environment)
        self._platform = sys.platform if platform is None else platform
        self._executable = self._environment.get("GENZOROOM_LIGHTCRAFT_EXE", "").strip()
        self._spawn = spawn if spawn is not None else asyncio.create_subprocess_exec
        self._timeouts = timeouts or LightCraftTimeouts()
        self._lock = asyncio.Lock()
        self._session = None
        self._inspection_thread = None
        self._generation = 0
        self._state = "stopped" if self._platform == "win32" and self._executable else "disabled"
        self._version = self._sha256 = self._error = None
        self._artifact = None

    def artifact_info(self):
        # A restart invalidates this generation's attestation before another response can use it.
        status = self.status()
        return dict(self._artifact) if status.state == 'ready' and self._artifact else None

    def status(self):
        return LightCraftStatus(self._state, self._generation, self._version, self._sha256, self._error)

    def diagnostic_manager(self, gpu_backend):
        # Copy trusted startup configuration, never the editing process or its native state.
        return LightCraftManager(environment=self._environment, platform=self._platform, spawn=self._spawn,
                                timeouts=self._timeouts, gpu_backend=gpu_backend)

    async def start(self):
        async with self._lock:
            self._start_locked()

    def _start_locked(self):
        # A failed session requires explicit restart; repeated start must never retry work.
        if self._state != "stopped" or self._session is not None:
            return
        self._generation += 1
        self._version = self._sha256 = self._error = None
        self._artifact = None
        session = _Session(self._generation)
        self._session = session
        self._state = "starting"
        lightcraft_log("process.starting", generation=session.generation)
        session.task = asyncio.create_task(self._run(session), name=f"lightcraft-owner-{session.generation}")

    def _current(self, session):
        return self._session is session and self._generation == session.generation

    def _register_inspection(self, thread):
        if self._inspection_thread is not None and self._inspection_thread.is_alive():
            raise LightCraftError("lightcraft_inspection_busy")
        self._inspection_thread = thread

    def _failed(self, session, code):
        if self._current(session) and not session.stop.is_set():
            self._state, self._error = "failed", code
            lightcraft_log("operation.failed", level="error", generation=session.generation, errorCode=code)

    async def _run(self, session):
        stop_task = None
        cancelled = False
        try:
            async with asyncio.timeout(self._timeouts.initialize):
                inspected = await _inspect_executable(self._executable, session.stop, self._register_inspection)
                if inspected is None:
                    return
                executable, digest, artifact = inspected
            if session.stop.is_set():
                return
            if self._current(session):
                self._sha256 = digest
            lightcraft_log("process.artifact", generation=session.generation, sha256=digest,
                           managedArtifact=bool(artifact))
            await _bounded_temp_io(_create_temp_directory, session, timeout=self._timeouts.temp_io)
            if session.stop.is_set():
                return
            # Never cancel this owner from close: even an in-flight spawn must return its child
            # to the same owner before shutdown can release lifecycle ownership.
            async with asyncio.timeout(self._timeouts.initialize):
                session.process = await self._spawn(
                    executable, "mcp", "--headless", "--compact", stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    limit=MAX_PREVIEW_LINE_BYTES, env=child_environment(self._environment,
                        gpu_backend=self._gpu_backend, temp_directory=session.temp_directory),
                    creationflags=0x08000000, shell=False,  # CREATE_NO_WINDOW; no Job breakaway.
                )
            process = session.process
            session.wait_task = asyncio.create_task(process.wait(), name=f"lightcraft-exit-{session.generation}")
            session.stderr_task = asyncio.create_task(self._drain_stderr(session), name=f"lightcraft-stderr-{session.generation}")
            session.client = LightCraftMCP(process.stdout, process.stdin, session.generation)
            if session.stop.is_set():
                return
            if self._current(session):
                self._state = "initializing"
            from build_info import BUILD_INFO
            # The complete handshake has a bound, including both writes and ping.
            async with asyncio.timeout(self._timeouts.initialize):
                version = await session.client.initialize(BUILD_INFO["version"], timeout=self._timeouts.initialize)
                await session.client.ping(timeout=self._timeouts.request)
            if session.stop.is_set():
                return
            if self._current(session):
                self._artifact = artifact if artifact and artifact['version'] == version else None
                self._state, self._version = "ready", version
                lightcraft_log("process.ready", generation=session.generation, version=version)
            stop_task = asyncio.create_task(session.stop.wait(), name=f"lightcraft-stop-{session.generation}")
            await asyncio.wait((stop_task, session.wait_task, session.client.failure), return_when=asyncio.FIRST_COMPLETED)
            if not session.stop.is_set():
                if session.wait_task.done():
                    lightcraft_log("process.exited", level="debug", generation=session.generation,
                                   exitCode=process.returncode)
                    raise MCPTransportError("lightcraft_process_exited")
                raise MCPTransportError(session.client.failure.result())
        except LightCraftError as error:
            self._failed(session, error.code)
        except TimeoutError:
            self._failed(session, "lightcraft_startup_timeout")
        except asyncio.CancelledError:
            cancelled = True
            session.stop.set()
        except Exception:
            self._failed(session, "lightcraft_start_failed")
        finally:
            if stop_task is not None:
                stop_task.cancel()
                await asyncio.gather(stop_task, return_exceptions=True)
            cleanup_task = asyncio.create_task(self._cleanup(session), name=f"lightcraft-cleanup-{session.generation}")
            cancelled = await _await_task_resilient(cleanup_task) or cancelled
        if cancelled:
            raise asyncio.CancelledError()

    async def _drain_stderr(self, session):
        count = 0
        try:
            while chunk := await session.process.stderr.read(8192):
                count += len(chunk)
        except asyncio.CancelledError:
            raise
        except Exception:
            if session.client is not None:
                session.client.abort("lightcraft_stderr_failed")
        finally:
            # Discard raw bytes even at debug; paths and secrets can occur in any log line.
            lightcraft_log("process.stderrDrained", level="debug", generation=session.generation, stderrBytes=count)

    async def _cleanup(self, session):
        if session.client is not None:
            await session.client.close(drain_stdout=True)
        process = session.process
        if process is not None and session.client is None and process.stdin is not None:
            # Even a failure before client construction must deliver EOF to the owned child.
            try:
                process.stdin.close()
            except (OSError, RuntimeError):
                pass
        reaped = process is None
        if process is not None:
            if session.stderr_task is None or session.stderr_task.done():
                session.stderr_task = asyncio.create_task(
                    self._drain_stderr(session), name=f"lightcraft-stderr-{session.generation}")
            if session.wait_task is None or session.wait_task.cancelled():
                # asyncio.run may cancel the monitor while the subprocess transport still owns the child.
                session.wait_task = asyncio.create_task(process.wait(), name=f"lightcraft-reap-{session.generation}")
            try:
                await asyncio.wait_for(asyncio.shield(session.wait_task), self._timeouts.shutdown)
                reaped = True
            except (asyncio.CancelledError, Exception):
                lightcraft_log("process.killRequired", level="warn", generation=session.generation)
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                except OSError:
                    pass
                if session.wait_task.cancelled() or (
                        session.wait_task.done() and session.wait_task.exception() is not None):
                    session.wait_task = asyncio.create_task(process.wait(), name=f"lightcraft-reap-{session.generation}")
                try:
                    await asyncio.wait_for(asyncio.shield(session.wait_task), self._timeouts.kill)
                    reaped = True
                except (asyncio.CancelledError, Exception):
                    # Retain the session: restart must not launch another unowned process.
                    if self._current(session):
                        self._state, self._error = "failed", "lightcraft_cleanup_failed"
                    lightcraft_log("process.cleanupFailed", level="error", generation=session.generation,
                                   errorCode="lightcraft_cleanup_failed")
            if reaped:
                lightcraft_log("process.reaped", level="debug", generation=session.generation,
                               exitCode=process.returncode)
        if reaped and session.client is not None:
            await session.client.close(wait_stdout=True)
        if reaped and session.stderr_task is not None:
            session.stderr_task.cancel()
            await asyncio.gather(session.stderr_task, return_exceptions=True)
        session.reaped = reaped
        if reaped and session.temp_directory is not None:
            try:
                await _bounded_temp_io(_remove_temp, session, timeout=self._timeouts.temp_io)
                session.temp_directory = None
            except LightCraftError as error:
                lightcraft_log("process.tempCleanupFailed", level="warn", generation=session.generation,
                               errorCode=error.code)

    async def _stop_locked(self):
        session = self._session
        if session is None:
            return
        self._state = "stopping"
        session.stop.set()
        if session.client is not None:
            session.client.abort()
        # Shield cleanup against caller cancellation; lifecycle ownership outlives the caller.
        cancelled = await _await_task_resilient(session.task)
        if not session.reaped or session.temp_directory is not None:
            cleanup_task = asyncio.create_task(self._cleanup(session), name=f"lightcraft-cleanup-{session.generation}")
            cancelled = await _await_task_resilient(cleanup_task) or cancelled
        if not session.reaped:
            raise LightCraftError("lightcraft_cleanup_failed")
        if session.temp_directory is not None:
            raise LightCraftError("lightcraft_temp_cleanup_failed")
        self._session = None
        self._state, self._error = "stopped", None
        lightcraft_log("process.stopped", generation=session.generation)
        if cancelled:
            raise asyncio.CancelledError()

    async def close(self):
        async with self._lock:
            await self._stop_locked()

    async def restart(self):
        async with self._lock:
            await self._stop_locked()
            self._start_locked()

    def _ready_client(self):
        session = self._session
        if self._state != "ready" or session is None or session.client is None:
            raise LightCraftError("lightcraft_not_ready")
        return session.client

    async def ping(self):
        await self._ready_client().ping(timeout=self._timeouts.request)

    async def get_gpu_info(self):
        client = self._ready_client()
        value = await client.call_tool("command_run", {"id": "app.gpu", "params": {}}, timeout=self._timeouts.gpu)
        if not isinstance(value, dict) or any(type(value.get(key)) is not bool for key in ("enabled", "available")) or \
                any(key not in value or (value[key] is not None and
                    (not isinstance(value[key], str) or len(value[key]) > 4096))
                    for key in ("adapter", "reason", "lastFallback")):
            client.abort("lightcraft_invalid_gpu_response")
            raise MCPTransportError("lightcraft_invalid_gpu_response")
        if not value["available"]:
            lightcraft_log("gpu.unavailable", level="warn", generation=client.generation,
                           enabled=value["enabled"], available=False)
        return GpuInfo(value["enabled"], value["available"], value["adapter"], value["reason"], value["lastFallback"])

    def _raw_session(self, generation):
        client = self._ready_client()
        session = self._session
        if client.generation != generation or client.failure.done():
            raise MCPTransportError("lightcraft_session_lost")
        return session

    def _check_raw_session(self, session):
        if not self._current(session) or self._state != "ready" or session.client.failure.done():
            raise MCPTransportError("lightcraft_session_lost")

    def _abort_raw(self, generation, code):
        session = self._session
        if session is not None and session.generation == generation and session.client is not None:
            session.client.abort(code)
            self._failed(session, code)

    async def _raw_command(self, generation, command, params, *, timeout):
        if command not in {"library.import", "library.select", "photo.inspect", "develop.get", "develop.set",
                           "develop.merge", "develop.reset", "develop.sectionEnabled", "develop.resetControl",
                           "develop.resetSection", "develop.wb", "beforeAfter.setBefore", "app.memoryBudget", "library.memory"}:
            raise LightCraftError("lightcraft_unsupported_raw_command")
        session = self._raw_session(generation)
        result = await session.client.call_tool("command_run", {"id": command, "params": params}, timeout=timeout)
        self._check_raw_session(session)
        return result

    async def _raw_before_supported(self, generation):
        session = self._raw_session(generation)
        if session.before_preview is None:
            result = await session.client.request("tools/list", timeout=self._timeouts.request)
            self._check_raw_session(session)
            tools = result.get("tools", []) if isinstance(result, dict) else []
            def supports(tool):
                if not isinstance(tool, dict) or tool.get("name") != "render_preview":
                    return False
                schema = tool.get("inputSchema")
                properties = schema.get("properties") if isinstance(schema, dict) else None
                before = properties.get("before") if isinstance(properties, dict) else None
                return isinstance(before, dict) and before.get("type") == "boolean"
            session.before_preview = isinstance(tools, list) and any(supports(tool) for tool in tools)
        return session.before_preview

    async def _raw_preview_supported(self, generation):
        session = self._raw_session(generation)
        if session.adaptive_preview is None:
            result = await session.client.request("tools/list", timeout=self._timeouts.request)
            self._check_raw_session(session)
            tools = result.get("tools", []) if isinstance(result, dict) else []
            session.adaptive_preview = False
            for tool in tools if isinstance(tools, list) else []:
                if not isinstance(tool, dict) or tool.get("name") != "render_preview":
                    continue
                schema = tool.get("inputSchema")
                props = schema.get("properties") if isinstance(schema, dict) else None
                if not isinstance(props, dict) or not all(isinstance(props.get(k), dict) for k in
                        ("quality", "preview_contract", "stage_cache", "stage_cache_budget_bytes")):
                    continue
                session.adaptive_preview = (props["quality"].get("type") == "string"
                    and props["quality"].get("enum") == ["draft", "full"]
                    and props["preview_contract"].get("type") == "integer"
                    and props["preview_contract"].get("enum") == [1]
                    and props["stage_cache"].get("type") == "string"
                    and props["stage_cache"].get("enum") == ["off", "on"]
                    and props["stage_cache_budget_bytes"].get("type") == "integer")
        return session.adaptive_preview

    async def _raw_region_supported(self, generation):
        from raw_region import supports_region
        session = self._raw_session(generation)
        if session.region_preview is None:
            tools = await session.client.request('tools/list', timeout=self._timeouts.request)
            self._check_raw_session(session)
            session.region_preview = supports_region(tools)
            items = tools.get('tools') if isinstance(tools, dict) else None
            region_tools = [tool for tool in items if isinstance(tool, dict) and tool.get('name') == 'render_region_preview'] if isinstance(items, list) else []
            metadata = region_tools[0].get('_meta', {}) if len(region_tools) == 1 else {}
            descriptor = metadata.get('genzoroom.geometryDescriptorContract') if isinstance(metadata, dict) else None
            lightcraft_log('region.capability', level='debug', generation=generation, supported=session.region_preview,
                geometryDescriptorContract=descriptor if type(descriptor) is int and descriptor in (1, 2) else None)
        return session.region_preview

    async def _raw_region(self, generation, photo_id, operation, target, *, timeout, stage_cache='off', stage_cache_budget_bytes=None):
        from raw_region import validate_target
        validate_target(target, operation)
        session = self._raw_session(generation)
        if not await self._raw_region_supported(generation):
            raise LightCraftError('raw_region_unsupported')
        args = {'id':str(photo_id), 'region_contract':1, 'operation':operation, 'target':target, 'stage_cache':stage_cache}
        if stage_cache == 'on':
            args['stage_cache_budget_bytes'] = stage_cache_budget_bytes
        try:
            result = await session.client.call_tool_result('render_region_preview', args, timeout=timeout)
            self._check_raw_session(session)
            return result
        finally:
            if self._current(session) and self._state == 'ready' and not session.client.failure.done():
                try:
                    await _bounded_temp_io(_remove_preview_files, session, timeout=self._timeouts.temp_io)
                except LightCraftError as error:
                    lightcraft_log('region.tempCleanupFailed', level='warn', generation=generation, errorCode=error.code)

    async def _raw_preview(self, generation, photo_id, max_side, *, timeout, before=False,
                           quality=None, stage_cache="off", stage_cache_budget_bytes=None):
        session = self._raw_session(generation)
        if before and not await self._raw_before_supported(generation):
            raise LightCraftError("raw_before_unsupported")
        options = {}
        if quality is not None:
            if not await self._raw_preview_supported(generation):
                raise LightCraftError("raw_preview_unsupported")
            options = {"quality": quality, "preview_contract": 1, "stage_cache": stage_cache}
            if stage_cache == "on":
                options["stage_cache_budget_bytes"] = stage_cache_budget_bytes
        try:
            result = await session.client.call_tool_result("render_preview", {
                "id": photo_id, "max_side": max_side, "format": "png", **options,
                **({"before": True} if before else {})}, timeout=timeout)
            self._check_raw_session(session)
            return result
        finally:
            # A completed reply means the synchronous helper stopped writing its temporary PNG.
            # On disconnect only the process owner may remove files, after reaping the child.
            if self._current(session) and self._state == "ready" and not session.client.failure.done():
                try:
                    await _bounded_temp_io(_remove_preview_files, session, timeout=self._timeouts.temp_io)
                except LightCraftError as error:
                    lightcraft_log("preview.tempCleanupFailed", level="warn", generation=generation,
                                   errorCode=error.code)
