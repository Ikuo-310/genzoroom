"""Private inherited-pipe lifecycle for an explicitly owned Windows Backend."""

import asyncio
import json
import re
import sys
from threading import Thread

from starlette.concurrency import run_in_threadpool

IDENTIFIER = re.compile(r"[0-9a-f]{64}")


def read_launch(stream):
    try:
        data = json.loads(stream.readline(4097))
        launch = data["launchId"]
        if set(data) != {"launchId"} or not isinstance(launch, str) or not IDENTIFIER.fullmatch(launch):
            raise ValueError()
        return launch
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("managed_launch_invalid") from None


def emit(event, *, request_id=None, error_code=None):
    data = {"event": event}
    if request_id is not None:
        data["requestId"] = request_id
    if error_code is not None:
        data["errorCode"] = error_code
    # This is a private control protocol, not captured stdlib/HTTP logs.
    print("GENZOROOM_CONTROL " + json.dumps(data, separators=(",", ":")), flush=True)


class ManagedControl:
    def __init__(self, server, stream=None, report=emit):
        self.server = server
        self.stream = stream if stream is not None else sys.stdin
        self.report = report

    async def execute(self, message):
        from export_runtime_store import recoverable_export_run
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not IDENTIFIER.fullmatch(request_id):
            return
        runtime = self.server.local_host.backend.state.export_runtime
        try:
            command = message.get("command")
            if command == "prepare":
                await runtime.stop_for_shutdown()
                self.report("prepared", request_id=request_id)
            elif command == "resume":
                await runtime.resume_after_shutdown_cancelled()
            elif command == "shutdown":
                await runtime.stop_for_shutdown()
                await runtime.wait()
                if await run_in_threadpool(recoverable_export_run) is not None:
                    raise RuntimeError("export_stop_incomplete")
                # Uvicorn owns lifespan shutdown; no signal or task cancellation interrupts encoding.
                self.server.should_exit = True
                self.report("drained", request_id=request_id)
        except Exception:
            self.report("failed", request_id=request_id, error_code="backend_shutdown_failed")

    def start(self):
        loop = asyncio.get_running_loop()

        def read():
            while True:
                line = self.stream.readline(4097)
                if not line:
                    return
                try:
                    message = json.loads(line)
                    if not isinstance(message, dict) or set(message) != {"command", "requestId"}:
                        continue
                    asyncio.run_coroutine_threadsafe(self.execute(message), loop).result()
                except (ValueError, RuntimeError):
                    return

        Thread(target=read, daemon=True, name="desktop-control").start()
