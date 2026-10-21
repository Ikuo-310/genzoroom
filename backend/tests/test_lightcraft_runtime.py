import asyncio
import hashlib
import json

import pytest

from backend_logging import backend_logger
from lightcraft_mcp import LightCraftError, MCPTransportError, PROTOCOL_VERSION
from lightcraft_runtime import LightCraftManager, LightCraftTimeouts, child_environment
from tests.test_lightcraft_mcp import PipeWriter, reply, until


GPU = {"enabled": True, "available": True, "adapter": "RX 580 (Dx12)", "reason": None, "lastFallback": None}
FAST = LightCraftTimeouts(initialize=.3, request=.1, gpu=.1, shutdown=.02, kill=.1)


class FakeProcess:
    def __init__(self, *, version="0.10.0", gpu=None, stall=None, ignore_eof=False):
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.returncode = None
        self.exited = asyncio.Event()
        self.version = version
        self.gpu = GPU if gpu is None else gpu
        self.stall = stall
        self.ignore_eof = ignore_eof
        self.kills = 0
        self.waits = 0
        self.stdin = PipeWriter(self.respond, self.close_input)

    def respond(self, message):
        method = message["method"]
        if "id" not in message or method == self.stall:
            return
        if method == "initialize":
            result = {"protocolVersion": PROTOCOL_VERSION, "serverInfo": {"name": "lightcraft", "version": self.version}}
        elif method == "ping":
            result = {}
        else:
            result = {"content": [], "isError": False, "structuredContent": self.gpu}
        reply(self.stdout, message, result)

    def close_input(self):
        if not self.ignore_eof:
            self.exit(0)

    def exit(self, code):
        if self.returncode is None:
            self.returncode = code
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            self.exited.set()

    async def wait(self):
        self.waits += 1
        await self.exited.wait()
        return self.returncode

    def kill(self):
        self.kills += 1
        self.exit(-9)


def make_manager(tmp_path, *, process_options=None, environment=None, spawn_gate=None):
    executable = tmp_path / "lightcraft-cli.exe"
    executable.write_bytes(b"fake executable")
    env = {"GENZOROOM_LIGHTCRAFT_EXE": str(executable), "SYSTEMROOT": "C:\\Windows"}
    env.update(environment or {})
    children, launches = [], []
    async def spawn(*args, **kwargs):
        launches.append((args, kwargs))
        if spawn_gate is not None:
            await spawn_gate.wait()
        process = FakeProcess(**(process_options or {}))
        children.append(process)
        return process
    return LightCraftManager(environment=env, platform="win32", spawn=spawn, timeouts=FAST), children, launches


def assert_reaped(session):
    assert session.task.done() and session.reaped
    if session.process is not None:
        assert session.process.returncode is not None
        assert session.wait_task.done() and session.stderr_task.done()
        assert session.client._reader_task.done() and not session.client._pending


def test_start_handshake_hash_gpu_and_idempotent_close(tmp_path):
    async def run():
        manager, children, launches = make_manager(tmp_path)
        await manager.start()
        assert manager.status().state == "starting"
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        status = manager.status()
        assert status.version == "0.10.0" and status.generation == 1
        assert status.executable_sha256 == hashlib.sha256(b"fake executable").hexdigest()
        assert len(children) == 1
        assert [m["method"] for m in children[0].stdin.messages] == ["initialize", "notifications/initialized", "ping"]
        args, kwargs = launches[0]
        assert args[1:] == ("mcp", "--headless", "--compact")
        assert kwargs["shell"] is False and kwargs["creationflags"] != 0
        assert kwargs["env"]["LIGHTCRAFT_GPU_BACKEND"] == "dx12"
        await manager.ping()
        gpu = await manager.get_gpu_info()
        assert gpu.available and gpu.adapter == GPU["adapter"]
        call = children[0].stdin.messages[-1]
        assert call["params"] == {"name": "command_run", "arguments": {"id": "app.gpu", "params": {}}}
        session = manager._session
        await manager.close()
        await manager.close()
        assert manager.status().state == "stopped"
        assert_reaped(session)
        assert children[0].kills == 0
    asyncio.run(run())


@pytest.mark.parametrize("platform,env", [("win32", {}), ("linux", {"GENZOROOM_LIGHTCRAFT_EXE": "/any.exe"})])
def test_disabled_never_spawns(platform, env):
    async def run():
        async def spawn(*args, **kwargs):
            pytest.fail("disabled runtime spawned")
        manager = LightCraftManager(platform=platform, environment=env, spawn=spawn)
        await manager.start()
        await manager.restart()
        await manager.close()
        assert manager.status().state == "disabled" and manager.status().generation == 0
        with pytest.raises(LightCraftError, match="lightcraft_not_ready"):
            await manager.ping()
    asyncio.run(run())


@pytest.mark.parametrize("value,code", [("relative.exe", "lightcraft_invalid_path"), ("missing", "lightcraft_executable_missing")])
def test_path_failure_never_spawns(tmp_path, value, code):
    async def run():
        manager, children, launches = make_manager(tmp_path)
        manager._executable = str(tmp_path / "missing.exe") if value == "missing" else value
        await manager.start()
        await until(lambda: manager.status().state == "failed")
        assert manager.status().error_code == code
        await manager.start()
        assert not children and not launches
        await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize("options,code", [
    ({"version": "0.9.1"}, "lightcraft_version_mismatch"),
    ({"stall": "initialize"}, "lightcraft_startup_timeout"),
])
def test_startup_failure_reaps_child(tmp_path, options, code):
    async def run():
        manager, children, _ = make_manager(tmp_path, process_options=options)
        await manager.start()
        session = manager._session
        await session.task
        assert manager.status().state == "failed"
        # The outer handshake deadline can expire before the per-request deadline.
        assert manager.status().error_code in (code, "lightcraft_timeout")
        assert_reaped(session)
        assert children[0].stdin.closed
        await manager.close()
    asyncio.run(run())


def test_spawn_exception_is_redacted_and_logged(tmp_path, monkeypatch):
    async def run():
        entries = []
        monkeypatch.setattr(backend_logger, "add", lambda **entry: entries.append(entry))
        manager, _, _ = make_manager(tmp_path)
        async def broken(*args, **kwargs):
            raise OSError("API_KEY=secret C:/private/photo.raw")
        manager._spawn = broken
        await manager.start()
        session = manager._session
        await session.task
        assert manager.status().error_code == "lightcraft_start_failed"
        assert_reaped(session)
        assert "secret" not in json.dumps(entries) and "photo.raw" not in json.dumps(entries)
        await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize("mode", ["abrupt_exit", "stdout_eof", "invalid_json", "timeout"])
def test_runtime_failure_reaps_without_restart_or_resend(tmp_path, mode):
    async def run():
        manager, children, _ = make_manager(tmp_path)
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        child, session = children[0], manager._session
        if mode == "abrupt_exit":
            child.exit(23)
        elif mode == "stdout_eof":
            child.stdout.feed_eof()
        elif mode == "invalid_json":
            child.stdout.feed_data(b"stdout contamination\n")
        else:
            child.stall = "ping"
            with pytest.raises(MCPTransportError, match="lightcraft_timeout"):
                await manager.ping()
        await session.task
        assert manager.status().state == "failed"
        assert_reaped(session)
        await manager.start()
        assert len(children) == 1 and manager.status().generation == 1
        if mode == "timeout":
            assert len(child.stdin.messages) == 4
        await manager.close()
    asyncio.run(run())


def test_gpu_unavailable_preserves_ready_and_stderr_is_not_logged(tmp_path, monkeypatch):
    async def run():
        entries = []
        monkeypatch.setattr(backend_logger, "add", lambda **entry: entries.append(entry))
        manager, children, _ = make_manager(tmp_path, process_options={
            "gpu": {**GPU, "available": False, "adapter": None, "reason": "private path or driver text"}},
            environment={"IMMICH_API_KEY": "secret", "AWS_SECRET_ACCESS_KEY": "secret"})
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        session = manager._session
        children[0].stderr.feed_data(b"secret C:/private/photo.raw\n" * 20000)
        assert not (await manager.get_gpu_info()).available
        assert manager.status().state == "ready"
        await manager.close()
        assert_reaped(session)
        logged = json.dumps(entries)
        assert all(text not in logged for text in ("secret", "photo.raw", "private path", str(tmp_path)))
        assert any(e["event"] == "gpu.unavailable" and e["level"] == "warn" for e in entries)
        assert any(e["event"] == "process.stderrDrained" and e["context"]["stderrBytes"] > 0 for e in entries)
    asyncio.run(run())


def test_environment_is_allowlisted_and_parent_is_unchanged():
    parent = {"SystemRoot": "C:\\Windows", "LOCALAPPDATA": "C:\\Users\\test", "TEMP": "C:\\Temp",
              "IMMICH_API_KEY": "secret", "CUSTOM_PASSWORD": "secret", "PATH": "private python path",
              "LIGHTCRAFT_GPU": "0", "LIGHTCRAFT_GPU_ADAPTER": "wrong", "LIGHTCRAFT_GPU_BACKEND": "vulkan",
              "WGPU_DX12_COMPILER": "dxc", "RUST_LOG": "trace", "PYTHONPATH": "private"}
    before = dict(parent)
    env = child_environment(parent)
    assert parent == before
    assert set(env) == {"SYSTEMROOT", "LOCALAPPDATA", "TEMP", "PATH", "LIGHTCRAFT_GPU_BACKEND", "LIGHTCRAFT_LOG"}
    assert env["LIGHTCRAFT_GPU_BACKEND"] == "dx12"
    assert "private" not in json.dumps(env) and "secret" not in json.dumps(env)


def test_close_during_spawn_waits_for_ownership_then_reaps(tmp_path):
    async def run():
        gate = asyncio.Event()
        manager, children, launches = make_manager(tmp_path, spawn_gate=gate)
        await manager.start()
        session = manager._session
        await until(lambda: bool(launches))
        closing = asyncio.create_task(manager.close())
        await until(session.stop.is_set)
        assert not closing.done()
        gate.set()
        await closing
        assert len(children) == 1 and not children[0].stdin.messages
        assert_reaped(session)
        assert manager.status().state == "stopped"
    asyncio.run(run())


def test_close_during_initialize_and_kill_after_eof_deadline(tmp_path):
    async def run():
        manager, children, _ = make_manager(tmp_path, process_options={"stall": "initialize", "ignore_eof": True})
        await manager.start()
        session = manager._session
        await until(lambda: bool(children) and bool(children[0].stdin.messages))
        await manager.close()
        assert children[0].kills == 1
        assert_reaped(session)
    asyncio.run(run())


def test_restart_and_close_are_serial_and_old_generation_is_inert(tmp_path):
    async def run():
        manager, children, _ = make_manager(tmp_path)
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        old = manager._session
        await manager.restart()
        await until(lambda: manager.status().state == "ready")
        assert manager.status().generation == 2 and len(children) == 2
        assert_reaped(old)
        manager._failed(old, "old_failure")
        old.client.abort("old_reader_error")
        assert manager.status().state == "ready" and manager.status().error_code is None
        current = manager._session
        await asyncio.gather(manager.close(), manager.close(), manager.start())
        # start may follow a completed close; either way every spawned session is owned.
        await manager.close()
        assert_reaped(current)
        assert all(p.returncode is not None for p in children)
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and t.get_name().startswith("lightcraft-")]
    asyncio.run(run())


def test_cancelling_close_does_not_abandon_child(tmp_path):
    async def run():
        gate = asyncio.Event()
        manager, children, launches = make_manager(tmp_path, spawn_gate=gate)
        await manager.start()
        session = manager._session
        await until(lambda: bool(launches))
        closing = asyncio.create_task(manager.close())
        await until(session.stop.is_set)
        closing.cancel()
        gate.set()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert_reaped(session)
        assert manager.status().state == "stopped"
        await manager.close()
        assert children[0].returncode is not None
    asyncio.run(run())


def test_invalid_gpu_response_fails_connection(tmp_path):
    async def run():
        manager, children, _ = make_manager(tmp_path, process_options={"gpu": {"enabled": 1}})
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        session = manager._session
        with pytest.raises(MCPTransportError, match="lightcraft_invalid_gpu_response"):
            await manager.get_gpu_info()
        await session.task
        assert manager.status().state == "failed"
        assert_reaped(session)
        await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize("operation", ["close", "restart"])
def test_lifecycle_releases_active_and_queued_requests(tmp_path, operation):
    async def run():
        manager, children, _ = make_manager(tmp_path)
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        old = manager._session
        children[0].stall = "ping"
        active = asyncio.create_task(manager.ping())
        await until(lambda: len(children[0].stdin.messages) == 4)
        queued = asyncio.create_task(manager.ping())
        await getattr(manager, operation)()
        results = await asyncio.gather(active, queued, return_exceptions=True)
        assert all(isinstance(r, LightCraftError) for r in results)
        assert_reaped(old)
        if operation == "restart":
            await until(lambda: manager.status().state == "ready")
            assert manager.status().generation == 2
            await manager.ping()
        await manager.close()
    asyncio.run(run())


def test_spawn_timeout_is_bounded(tmp_path):
    async def run():
        manager, _, _ = make_manager(tmp_path, spawn_gate=asyncio.Event())
        await manager.start()
        session = manager._session
        await session.task
        assert manager.status().error_code == "lightcraft_startup_timeout"
        assert_reaped(session)
        await manager.close()
    asyncio.run(run())


def test_optional_logging_failure_does_not_fail_start_or_close(tmp_path, monkeypatch):
    def broken(**kwargs):
        raise RuntimeError("logger unavailable")
    monkeypatch.setattr(backend_logger, "add", broken)
    async def run():
        manager, _, _ = make_manager(tmp_path)
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        await manager.ping()
        await manager.close()
        assert manager.status().state == "stopped"
    asyncio.run(run())


def test_failed_kill_retains_ownership_and_blocks_restart(tmp_path):
    async def run():
        manager, children, _ = make_manager(tmp_path, process_options={"ignore_eof": True})
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        child, session = children[0], manager._session
        original_kill = child.kill
        child.kill = lambda: None
        with pytest.raises(LightCraftError, match="lightcraft_cleanup_failed"):
            await manager.restart()
        assert manager._session is session and len(children) == 1
        assert manager.status().state == "failed" and not session.wait_task.done()
        child.kill = original_kill
        await manager.close()
        assert_reaped(session)
    asyncio.run(run())
