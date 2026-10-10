"""Bounded two-service supervision; tini owns PID 1 and reaps orphaned children."""

import os
import signal
import subprocess
import time


SHUTDOWN_SECONDS = 60
COMMANDS = (
    ("backend", ["uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000",
                 "--workers", "1", "--no-proxy-headers"], signal.SIGTERM),
    ("nginx", ["nginx", "-g", "daemon off;"], getattr(signal, "SIGQUIT", signal.SIGTERM)),
)


def send_group(process, sig):
    # A failed master can leave workers alive in its group even after poll() reaps it.
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def main():
    stopping = False
    children = []
    result = 0

    def request_stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        for name, command, stop_signal in COMMANDS:
            if stopping:
                break
            children.append((name, subprocess.Popen(command, start_new_session=True), stop_signal))
        while not stopping:
            for name, process, _ in children:
                if process.poll() is not None:
                    # Even an unsolicited zero exit leaves an incomplete application.
                    print(f"release: {name} exited; stopping container", flush=True)
                    result = 1
                    stopping = True
                    break
            if not stopping:
                time.sleep(0.1)
    except Exception:
        # Do not print exception text: inherited environment may contain credentials.
        print("release: process supervision failed", flush=True)
        result = 1
    finally:
        for _, process, stop_signal in reversed(children):
            send_group(process, stop_signal)
        deadline = time.monotonic() + SHUTDOWN_SECONDS
        while any(process.poll() is None for _, process, _ in children):
            if time.monotonic() >= deadline:
                # Lifespan waits for Export Runtime; forced exit leaves DB checkpoints for recovery.
                print("release: shutdown deadline exceeded", flush=True)
                result = 1
                for _, process, _ in children:
                    send_group(process, signal.SIGKILL)
                break
            time.sleep(0.1)
        for _, process, _ in children:
            process.wait()
    return result


if __name__ == "__main__":
    raise SystemExit(main())
