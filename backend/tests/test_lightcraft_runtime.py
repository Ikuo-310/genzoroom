from lightcraft_artifact import ENGINE_VERSION
import asyncio
import hashlib
import json
import sys
import threading
import time

import pytest

from backend_logging import backend_logger
from lightcraft_mcp import LightCraftError, MCPTransportError, PROTOCOL_VERSION
from lightcraft_runtime import LightCraftManager, LightCraftTimeouts, child_environment
import lightcraft_runtime
from tests.test_lightcraft_mcp import PipeWriter, reply, until


GPU = {"enabled": True, "available": True, "adapter": "RX 580 (Dx12)", "reason": None, "lastFallback": None}
FAST = LightCraftTimeouts(initialize=.3, request=.1, gpu=.1, shutdown=.02, kill=.1)


class FakeProcess:
    def __init__(self, *, version=ENGINE_VERSION, gpu=None, stall=None, ignore_eof=False):
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
        assert status.version == ENGINE_VERSION and status.generation == 1
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


def test_close_during_executable_inspection_does_not_wait_for_worker(tmp_path, monkeypatch):
    async def run():
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original = lightcraft_runtime._executable_info
        def slow_inspection(value):
            entered.set()
            release.wait(2)
            try:
                return original(value)
            finally:
                finished.set()
        monkeypatch.setattr(lightcraft_runtime, "_executable_info", slow_inspection)
        manager, children, launches = make_manager(tmp_path)
        await manager.start()
        session = manager._session
        try:
            await until(entered.is_set)
            async with asyncio.timeout(.5):
                await manager.close()
            assert manager.status().state == "stopped"
            assert not children and not launches and session.reaped
        finally:
            release.set()
        await until(finished.is_set)
    asyncio.run(run())


def test_executable_inspection_deadline_fails_without_spawning(tmp_path, monkeypatch):
    async def run():
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original = lightcraft_runtime._executable_info
        def slow_inspection(value):
            entered.set()
            release.wait(2)
            try:
                return original(value)
            finally:
                finished.set()
        monkeypatch.setattr(lightcraft_runtime, "_executable_info", slow_inspection)
        manager, children, launches = make_manager(tmp_path)
        await manager.start()
        session = manager._session
        try:
            await until(entered.is_set)
            await session.task
            assert manager.status().state == "failed"
            assert manager.status().error_code == "lightcraft_startup_timeout"
            assert not children and not launches and session.reaped
        finally:
            release.set()
        await until(finished.is_set)
        await manager.close()
    asyncio.run(run())


def test_cancelling_owner_and_exit_watcher_still_kills_and_reaps_child(tmp_path):
    async def run():
        manager, children, _ = make_manager(tmp_path, process_options={"ignore_eof": True})
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        session = manager._session
        session.wait_task.cancel()
        session.task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await session.task
        assert session.reaped and children[0].kills == 1
        assert session.wait_task.done() and not session.wait_task.cancelled()
        assert session.client._reader_task.done() and session.stderr_task.done()
        assert manager._session is session
        await manager.close()
        assert manager.status().state == "stopped" and manager._session is None
        assert_reaped(session)
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


def test_temp_io_deadlines_bound_start_preview_and_shutdown(tmp_path, monkeypatch):
    async def run():
        timeouts = LightCraftTimeouts(initialize=.3, request=.1, gpu=.1, shutdown=.02, kill=.05, temp_io=.03)

        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original_create = lightcraft_runtime._create_temp_directory
        def stalled_create(session):
            entered.set()
            release.wait()
            try:
                return original_create(session)
            finally:
                finished.set()
        monkeypatch.setattr(lightcraft_runtime, "_create_temp_directory", stalled_create)
        (tmp_path / "startup").mkdir()
        manager, children, _ = make_manager(tmp_path / "startup", process_options=None)
        manager._timeouts = timeouts
        await manager.start()
        session = manager._session
        await asyncio.to_thread(entered.wait, 1)
        await asyncio.wait_for(session.task, .3)
        assert manager.status().state == "failed" and manager.status().error_code == "lightcraft_temp_io_timeout"
        assert not children
        release.set()
        await asyncio.to_thread(finished.wait, 1)
        await manager.close()

        monkeypatch.setattr(lightcraft_runtime, "_create_temp_directory", original_create)
        (tmp_path / "preview").mkdir()
        manager, children, _ = make_manager(tmp_path / "preview")
        manager._timeouts = timeouts
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        entered, release = threading.Event(), threading.Event()
        original_preview = lightcraft_runtime._remove_preview_files
        def stalled_preview(session):
            entered.set()
            release.wait()
            return original_preview(session)
        monkeypatch.setattr(lightcraft_runtime, "_remove_preview_files", stalled_preview)
        started = time.monotonic()
        await manager._raw_preview(manager.status().generation, 1, 1024, timeout=.1)
        assert time.monotonic() - started < .3 and manager.status().state == "ready"
        assert await asyncio.to_thread(entered.wait, 1)
        release.set()
        await manager.close()

        (tmp_path / "shutdown").mkdir()
        manager, children, _ = make_manager(tmp_path / "shutdown")
        manager._timeouts = timeouts
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        session = manager._session
        entered, release = threading.Event(), threading.Event()
        original_remove = lightcraft_runtime._remove_temp
        def stalled_remove(session):
            entered.set()
            release.wait()
            return original_remove(session)
        monkeypatch.setattr(lightcraft_runtime, "_remove_temp", stalled_remove)
        started = time.monotonic()
        with pytest.raises(LightCraftError, match="lightcraft_temp_cleanup_failed"):
            await manager.close()
        assert time.monotonic() - started < .5
        assert manager._session is session and session.reaped and session.temp_directory is not None
        assert await asyncio.to_thread(entered.wait, 1)
        with pytest.raises(LightCraftError, match="lightcraft_temp_cleanup_failed"):
            await manager.restart()
        assert len(children) == 1
        release.set()
        await manager.close()
        assert manager._session is None and session.temp_directory is None
    asyncio.run(run())


def test_untrusted_windows_temp_roots_are_rejected():
    from lightcraft_runtime import _trusted_temp_root
    with pytest.raises(LightCraftError, match="lightcraft_temp_location_unsupported"):
        _trusted_temp_root(r"\\server\share\temp", windows=True)


def test_real_subprocess_stderr_keeps_draining_after_failed_reap(tmp_path):
    async def run():
        executable = tmp_path / "lightcraft-cli.exe"
        executable.write_bytes(b"test executable")
        script = (
            "import json,sys,threading,time\n"
            "def flood():\n"
            "  block=b'x'*8192\n"
            "  for _ in range(3072): sys.stderr.buffer.write(block)\n"
            "  sys.stderr.buffer.flush()\n"
            "threading.Thread(target=flood,daemon=True).start()\n"
            "for line in sys.stdin:\n"
            "  m=json.loads(line)\n"
            "  if 'id' not in m: continue\n"
            f"  r={{'protocolVersion':{PROTOCOL_VERSION!r},'serverInfo':{{'name':'lightcraft','version':{ENGINE_VERSION!r}}},'capabilities':{{}}}} if m['method']=='initialize' else {{}}\n"
            "  sys.stdout.write(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r})+'\\n'); sys.stdout.flush()\n"
            "while True: time.sleep(1)\n"
        )
        async def spawn(*args, **kwargs):
            return await asyncio.create_subprocess_exec(sys.executable, "-u", "-c", script,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=kwargs["limit"])
        manager = LightCraftManager(environment={"GENZOROOM_LIGHTCRAFT_EXE": str(executable)},
                                    platform="win32", spawn=spawn,
                                    timeouts=LightCraftTimeouts(initialize=1, request=.2, gpu=.2,
                                                                shutdown=.02, kill=.1, temp_io=.5))
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        session = manager._session
        process = session.process
        original_kill = process.kill
        process.kill = lambda: None
        with pytest.raises(LightCraftError, match="lightcraft_cleanup_failed"):
            await manager.restart()
        assert session.stderr_task is not None and not session.stderr_task.done()
        process.kill = original_kill
        await manager.close()
        assert session.reaped and session.stderr_task.done()
    asyncio.run(run())


def test_private_temp_and_internal_cpu_setting_reaped_across_generations(tmp_path):
    from lightcraft_mcp import MAX_PREVIEW_LINE_BYTES
    async def run():
        manager, children, launches = make_manager(tmp_path)
        manager._gpu_backend = "off"
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        session = manager._session
        path = session.temp_directory
        try:
            env = launches[0][1]["env"]
            assert env["TEMP"] == env["TMP"] == str(path)
            assert env["LIGHTCRAFT_GPU_BACKEND"] == "off"
            assert launches[0][1]["limit"] == MAX_PREVIEW_LINE_BYTES
            children[0].pid = 999
            (path / "lightcraft-mcp-999-0-render.png").write_bytes(b"orphan")
            (path / "other-owner.png").write_bytes(b"keep during operation")
            from lightcraft_runtime import _remove_preview_files
            _remove_preview_files(session)
            assert not (path / "lightcraft-mcp-999-0-render.png").exists()
            assert (path / "other-owner.png").exists()
            await manager.restart()
            await until(lambda: manager.status().state == "ready")
            assert not path.exists() and manager._session.temp_directory != path
            new_path = manager._session.temp_directory
            assert_reaped(session)
        finally:
            await manager.close()
        assert not new_path.exists()
    asyncio.run(run())


def test_temp_cleanup_never_follows_an_unowned_target(tmp_path):
    from lightcraft_runtime import _Session, _remove_temp, child_environment
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "sentinel").write_bytes(b"keep")
    session = _Session(1, temp_directory=outside, temp_root=tmp_path / "different-root")
    with pytest.raises(LightCraftError, match="lightcraft_temp_cleanup_failed"):
        _remove_temp(session)
    assert (outside / "sentinel").read_bytes() == b"keep"
    with pytest.raises(ValueError, match="lightcraft_invalid_gpu_backend"):
        LightCraftManager(gpu_backend="vulkan")
    with pytest.raises(ValueError):
        child_environment({}, gpu_backend="vulkan")


def test_generation_guard_rejects_old_raw_commands_without_sending(tmp_path):
    async def run():
        manager, children, _ = make_manager(tmp_path)
        await manager.start()
        await until(lambda: manager.status().state == "ready")
        await manager.restart()
        await until(lambda: manager.status().state == "ready")
        sent = len(children[1].stdin.messages)
        try:
            with pytest.raises(MCPTransportError, match="lightcraft_session_lost"):
                await manager._raw_command(1, "develop.get", {"id": 1}, timeout=1)
            assert len(children[1].stdin.messages) == sent
        finally:
            await manager.close()
    asyncio.run(run())
