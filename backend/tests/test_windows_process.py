"""Opt-in native ownership checks; never contact an actual Immich server."""
import ctypes
import os
from pathlib import Path
import subprocess
import sys

import pytest

from windows_local import DEFAULT_PORT, reserve_listener

NATIVE = Path(__file__).resolve().parents[2] / "desktop/target/debug/genzoroom-desktop.exe"
pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or os.environ.get("GENZOROOM_WEBVIEW_SMOKE") != "1" or not NATIVE.is_file(),
    reason="Opt-in Windows native smoke build required")


def environment(tmp_path):
    return {**os.environ, "LOCALAPPDATA": str(tmp_path), "IMMICH_URL": "", "IMMICH_API_KEY": ""}


def wait_gone(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if handle:
        try:
            assert kernel.WaitForSingleObject(handle, 10000) == 0
        finally:
            kernel.CloseHandle(handle)


@pytest.mark.parametrize("abnormal", [False, True])
def test_owned_child_normal_and_abnormal_teardown(tmp_path, abnormal):
    with reserve_listener(DEFAULT_PORT):
        pass
    parent = subprocess.Popen([str(NATIVE), "--process-smoke"], env=environment(tmp_path),
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = parent.stdout.readline()
        assert line.startswith("GenzoRoom process smoke: ready "), line + parent.stderr.read() if parent.poll() is not None else line
        pid = int(line.split()[-1])
        assert (tmp_path / "GenzoRoom/WindowsPoC/data/genzoroom.db").is_file()
        if abnormal:
            parent.kill()
            parent.communicate(timeout=15)
        else:
            _, stderr = parent.communicate("close\n", timeout=20)
            assert parent.returncode == 0, stderr
            assert not (tmp_path / "GenzoRoom/WindowsPoC/desktop-session.dpapi").exists()
        wait_gone(pid)
        with reserve_listener(DEFAULT_PORT):
            pass
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.communicate(timeout=10)


def test_conflict_never_reuses_or_stops_foreign_listener(tmp_path):
    with reserve_listener(DEFAULT_PORT) as listener:
        result = subprocess.run([str(NATIVE), "--process-smoke"], env=environment(tmp_path),
                                capture_output=True, text=True, timeout=20)
        assert result.returncode == 1
        assert "local_port_unavailable" in result.stderr
        assert listener.getsockname()[1] == DEFAULT_PORT
        assert not (tmp_path / "GenzoRoom").exists()


def test_automatic_webview_authentication_and_graceful_exit(tmp_path, monkeypatch):
    from tests.windows_desktop_fixture import start
    with reserve_listener(DEFAULT_PORT):
        pass
    monkeypatch.setenv("IMMICH_URL", "")
    monkeypatch.setenv("IMMICH_API_KEY", "")
    server = start()
    try:
        result = subprocess.run([str(NATIVE), "--auto-smoke"],
                                env={**os.environ, "LOCALAPPDATA": str(tmp_path)},
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        assert '"sharedCookie":true' in result.stdout
        assert '"image":true' in result.stdout
        assert 'GenzoRoom keyboard smoke: ' in result.stdout
        for field in ("domDown", "domUp", "documentEvents", "keyCode", "modifiers", "targetFocus", "simpleShortcut", "inputGuard"):
            assert f'"{field}":true' in result.stdout
        assert "native-smoke-fixture" not in result.stdout + result.stderr
        assert not (tmp_path / "GenzoRoom/WindowsPoC/desktop-session.dpapi").exists()
        with reserve_listener(DEFAULT_PORT):
            pass
        for line in result.stdout.splitlines():
            if line.startswith(("GenzoRoom WebView2 smoke: {", "GenzoRoom keyboard smoke: {")):
                print(line)
    finally:
        server.shutdown()
        server.server_close()
