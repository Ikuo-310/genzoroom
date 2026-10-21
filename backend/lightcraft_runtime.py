"""Windows-owned LightCraft session, independent of JPEG and persistence services."""

import asyncio
from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
import sys

from backend_logging import backend_logger
from lightcraft_mcp import LightCraftError, LightCraftMCP, MAX_LINE_BYTES, MCPTransportError


@dataclass(frozen=True)
class LightCraftTimeouts:
    initialize: float = 10
    request: float = 5
    gpu: float = 15
    shutdown: float = 3
    kill: float = 2


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


def lightcraft_log(event, *, level="info", **context):
    try:
        backend_logger.add(level=level, component="lightcraft", event=event, context=context)
    except Exception:
        pass


def child_environment(parent):
    # Copy only OS runtime locations; arbitrary inherited keys can contain credentials.
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA",
               "USERPROFILE", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
               "PROCESSOR_ARCHITECTURE"}
    result = {key.upper(): value for key, value in parent.items() if key.upper() in allowed}
    root = result.get("SYSTEMROOT") or result.get("WINDIR")
    if root:
        # Frozen Python's PATH and developer GPU/compiler overrides do not belong to the CLI.
        result["PATH"] = str(Path(root) / "System32") + os.pathsep + root
    result["LIGHTCRAFT_GPU_BACKEND"] = "dx12"
    result["LIGHTCRAFT_LOG"] = "warn"
    return result


def _executable_info(value):
    path = Path(value)
    if not path.is_absolute():
        raise LightCraftError("lightcraft_invalid_path")
    try:
        if not path.is_file():
            raise LightCraftError("lightcraft_executable_missing")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
    except OSError:
        raise LightCraftError("lightcraft_executable_unreadable") from None
    return str(path), digest


class LightCraftManager:
    def __init__(self, *, environment=None, platform=None, spawn=None, timeouts=None):
        self._environment = dict(os.environ if environment is None else environment)
        self._platform = sys.platform if platform is None else platform
        self._executable = self._environment.get("GENZOROOM_LIGHTCRAFT_EXE", "").strip()
        self._spawn = spawn if spawn is not None else asyncio.create_subprocess_exec
        self._timeouts = timeouts or LightCraftTimeouts()
        self._lock = asyncio.Lock()
        self._session = None
        self._generation = 0
        self._state = "stopped" if self._platform == "win32" and self._executable else "disabled"
        self._version = self._sha256 = self._error = None

    def status(self):
        return LightCraftStatus(self._state, self._generation, self._version, self._sha256, self._error)

    async def start(self):
        async with self._lock:
            self._start_locked()

    def _start_locked(self):
        # A failed session requires explicit restart; repeated start must never retry work.
        if self._state != "stopped" or self._session is not None:
            return
        self._generation += 1
        self._version = self._sha256 = self._error = None
        session = _Session(self._generation)
        self._session = session
        self._state = "starting"
        lightcraft_log("process.starting", generation=session.generation)
        session.task = asyncio.create_task(self._run(session), name=f"lightcraft-owner-{session.generation}")

    def _current(self, session):
        return self._session is session and self._generation == session.generation

    def _failed(self, session, code):
        if self._current(session) and not session.stop.is_set():
            self._state, self._error = "failed", code
            lightcraft_log("operation.failed", level="error", generation=session.generation, errorCode=code)

    async def _run(self, session):
        stop_task = None
        try:
            executable, digest = await asyncio.to_thread(_executable_info, self._executable)
            if session.stop.is_set():
                return
            if self._current(session):
                self._sha256 = digest
            lightcraft_log("process.artifact", generation=session.generation, sha256=digest)
            # Never cancel this owner from close: even an in-flight spawn must return its child
            # to the same owner before shutdown can release lifecycle ownership.
            session.process = await asyncio.wait_for(self._spawn(
                executable, "mcp", "--headless", "--compact", stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=MAX_LINE_BYTES, env=child_environment(self._environment),
                creationflags=0x08000000, shell=False,  # CREATE_NO_WINDOW; no Job breakaway.
            ), self._timeouts.initialize)
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
        except Exception:
            self._failed(session, "lightcraft_start_failed")
        finally:
            if stop_task is not None:
                stop_task.cancel()
                await asyncio.gather(stop_task, return_exceptions=True)
            await self._cleanup(session)

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
            await session.client.close()
        process = session.process
        if process is not None and session.client is None and process.stdin is not None:
            # Even a failure before client construction must deliver EOF to the owned child.
            try:
                process.stdin.close()
            except (OSError, RuntimeError):
                pass
        reaped = process is None
        if process is not None:
            if session.wait_task is None:
                session.wait_task = asyncio.create_task(process.wait())
            try:
                await asyncio.wait_for(asyncio.shield(session.wait_task), self._timeouts.shutdown)
                reaped = True
            except (TimeoutError, OSError):
                lightcraft_log("process.killRequired", level="warn", generation=session.generation)
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                except OSError:
                    pass
                try:
                    await asyncio.wait_for(asyncio.shield(session.wait_task), self._timeouts.kill)
                    reaped = True
                except (TimeoutError, OSError):
                    # Retain the session: restart must not launch another unowned process.
                    if self._current(session):
                        self._state, self._error = "failed", "lightcraft_cleanup_failed"
                    lightcraft_log("process.cleanupFailed", level="error", generation=session.generation,
                                   errorCode="lightcraft_cleanup_failed")
            if reaped:
                lightcraft_log("process.reaped", level="debug", generation=session.generation,
                               exitCode=process.returncode)
        if session.stderr_task is not None:
            session.stderr_task.cancel()
            await asyncio.gather(session.stderr_task, return_exceptions=True)
        session.reaped = reaped

    async def _stop_locked(self):
        session = self._session
        if session is None:
            return
        self._state = "stopping"
        session.stop.set()
        if session.client is not None:
            session.client.abort()
        # Shield cleanup against caller cancellation; lifecycle ownership outlives the caller.
        cancelled = False
        try:
            await asyncio.shield(session.task)
        except asyncio.CancelledError:
            cancelled = True
            await asyncio.shield(session.task)
        if not session.reaped:
            await self._cleanup(session)
        if not session.reaped:
            raise LightCraftError("lightcraft_cleanup_failed")
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
