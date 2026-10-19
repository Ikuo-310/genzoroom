import asyncio
import threading
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from export_runtime import ExportRuntime
from export_runtime_store import RuntimeRejected, create_export_run, get_export_run, recoverable_export_run
from tests.test_export_queue import A, B, db
from tests.test_export_runtime import Family, Registrar, Source, queued
from windows_managed import ManagedControl, read_launch


@pytest.mark.parametrize("value", ['{}', '[]', 'null', '{"launchId":"secret"}',
                                  '{"launchId":"' + 'a' * 64 + '","extra":true}'])
def test_invalid_launch_is_redacted(value):
    with pytest.raises(RuntimeError, match="^managed_launch_invalid$"):
        read_launch(StringIO(value))


def test_launch_identifier():
    assert read_launch(StringIO('{"launchId":"' + 'a' * 64 + '"}\n')) == 'a' * 64


def test_shutdown_persists_stop_waits_current_and_does_not_dispatch_next(db):
    queued(A, B)

    async def scenario():
        gate = asyncio.Event()
        source, registrar = Source(), Registrar(gate=gate)
        runtime = ExportRuntime(source=source, family=Family(), registrar=registrar)
        run_id = await runtime.start([A, B])
        for _ in range(200):
            if registrar.calls:
                break
            await asyncio.sleep(.005)
        assert len(registrar.calls) == 1
        events = []
        server = SimpleNamespace(should_exit=False, local_host=SimpleNamespace(
            backend=SimpleNamespace(state=SimpleNamespace(export_runtime=runtime))))
        control = ManagedControl(server, report=lambda event, **data: events.append((event, data)))
        request = {"requestId": "b" * 64, "command": "prepare"}
        await control.execute(request)
        assert events[-1][0] == "prepared"
        assert recoverable_export_run().stop_requested
        with pytest.raises(RuntimeRejected, match="run_active"):
            await runtime.start([B])
        stopping = asyncio.create_task(control.execute({**request, "command": "shutdown"}))
        await asyncio.sleep(.02)
        assert not stopping.done() and not server.should_exit
        gate.set()
        await stopping
        assert server.should_exit
        assert events[-1][0] == "drained"
        assert source.started == [A]
        assert get_export_run(run_id).status == "stopped"
        await runtime.resume_after_shutdown_cancelled()
        await runtime.start([B])
        await runtime.wait()
        assert source.started == [A, B]

    asyncio.run(scenario())


def test_shutdown_failure_does_not_exit_or_expose_exception(db):
    class BrokenRuntime:
        async def stop_for_shutdown(self):
            raise RuntimeError("private API key")

    events = []
    server = SimpleNamespace(should_exit=False, local_host=SimpleNamespace(
        backend=SimpleNamespace(state=SimpleNamespace(export_runtime=BrokenRuntime()))))
    asyncio.run(ManagedControl(server, report=lambda event, **data: events.append((event, data)))
                .execute({"command": "shutdown", "requestId": "a" * 64}))
    assert not server.should_exit
    assert events == [("failed", {"request_id": "a" * 64, "error_code": "backend_shutdown_failed"})]


def test_stop_waits_for_inflight_start_transaction_before_observing_run(db):
    queued(A, B)
    entered, release = threading.Event(), threading.Event()

    def delayed_create(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return create_export_run(*args, **kwargs)

    async def scenario():
        gate = asyncio.Event()
        runtime = ExportRuntime(source=Source(gate=gate), family=Family(), registrar=Registrar())
        starting = asyncio.create_task(runtime.start([A, B]))
        try:
            for _ in range(200):
                if entered.is_set():
                    break
                await asyncio.sleep(.005)
            assert entered.is_set()
            stopping = asyncio.create_task(runtime.stop_for_shutdown())
            await asyncio.sleep(.02)
            assert not stopping.done()
            release.set()
            await starting
            await stopping
            assert recoverable_export_run().stop_requested
        finally:
            release.set()
            gate.set()
            await runtime.wait()
        assert recoverable_export_run() is None

    with patch("export_runtime.create_export_run", delayed_create):
        asyncio.run(scenario())
