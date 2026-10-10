import importlib.util
import signal
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_release_nginx_preserves_all_routing_and_limits():
    development = (ROOT / "frontend/nginx.conf").read_text()
    release = (ROOT / "release/nginx.conf").read_text()
    expected = development.replace("        resolver 127.0.0.11 valid=10s ipv6=off;\n", "")
    expected = expected.replace("server backend:8000 resolve;", "server 127.0.0.1:8000;")
    assert release == expected


@pytest.fixture
def supervisor(monkeypatch):
    spec = importlib.util.spec_from_file_location("release_supervisor", ROOT / "release/supervisor.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    handlers = {}
    monkeypatch.setattr(module.signal, "signal", lambda sig, handler: handlers.update({sig: handler}))
    monkeypatch.setattr(module.signal, "SIGKILL", 9, raising=False)
    return module, handlers


@pytest.mark.parametrize("mode", ["term", "backend_exit", "nginx_exit", "startup_failure", "timeout"])
def test_supervisor_stops_and_reaps_both_services(supervisor, monkeypatch, mode):
    module, handlers = supervisor
    children, signals = [], []

    def spawn(command, **kwargs):
        assert kwargs == {"start_new_session": True}
        if mode == "startup_failure" and children:
            raise OSError("private information must not be logged")
        process = SimpleNamespace(pid=len(children) + 10, returncode=None, waited=False)
        process.poll = lambda: process.returncode
        def wait():
            assert process.returncode is not None
            process.waited = True
        process.wait = wait
        children.append(process)
        if len(children) == 2:
            if mode in ("term", "timeout"):
                handlers[signal.SIGTERM](signal.SIGTERM, None)
            else:
                children[0 if mode == "backend_exit" else 1].returncode = 0
        return process

    def killpg(pid, sig):
        signals.append((pid, sig))
        if mode != "timeout" or sig == 9:
            next(child for child in children if child.pid == pid).returncode = -sig

    clock = iter([0, 61])
    monkeypatch.setattr(module.subprocess, "Popen", spawn)
    monkeypatch.setattr(module.os, "killpg", killpg, raising=False)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    assert module.main() == (0 if mode == "term" else 1)
    assert all(child.waited for child in children)
    assert signals
    if mode == "timeout":
        assert {(pid, sig) for pid, sig in signals if sig == 9} == {(10, 9), (11, 9)}
