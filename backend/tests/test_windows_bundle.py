"""Opt-in tests of the actual onedir artifact, not a mocked frozen interpreter."""
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
from queue import Queue
import secrets
import subprocess
from threading import Thread

import httpx
import pytest

from windows_desktop_handoff import protect_for_current_user

APPLICATION = os.environ.get("GENZOROOM_BUNDLED_APPLICATION")
pytestmark = pytest.mark.skipif(not APPLICATION or os.name != "nt", reason="Opt-in onedir artifact required")


@contextmanager
def backend(tmp_path):
    executable = Path(APPLICATION) / "backend/genzoroom-backend.exe"
    # Only Windows system tools remain visible; the child must ignore developer Python settings.
    environment = {**os.environ, "LOCALAPPDATA": str(tmp_path), "PATH": os.path.join(os.environ["SystemRoot"], "System32"),
                   "PYTHONHOME": str(tmp_path / "missing-python"), "PYTHONPATH": str(tmp_path / "missing-modules"),
                   "IMMICH_URL": "", "IMMICH_API_KEY": ""}
    child = subprocess.Popen([str(executable), "--desktop", "--managed"], cwd=tmp_path, env=environment,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    lines = Queue()
    Thread(target=lambda: [lines.put(line) for line in child.stdout], daemon=True).start()
    launch = secrets.token_hex(32)
    child.stdin.write(json.dumps({"launchId": launch}) + "\n"); child.stdin.flush()
    try:
        while " ready on " not in lines.get(timeout=25):
            assert child.poll() is None
        root = tmp_path / "GenzoRoom"
        handoff = json.loads(protect_for_current_user((root / "desktop-session.dpapi").read_bytes(), decrypt=True))
        assert handoff["launchId"] == launch
        origin = "http://127.0.0.1:3191"
        with httpx.Client(base_url=origin, trust_env=False, headers={"Origin": origin}) as client:
            challenge = secrets.token_hex(32)
            proof = client.get("/__local/desktop-ready", params={"challenge": challenge}).json()["proof"]
            assert proof == hmac.new(bytes.fromhex(handoff["probeKey"]), b"GenzoRoom desktop probe v1:" + challenge.encode(), hashlib.sha256).hexdigest()
            assert client.get("/api/health").status_code == 401
            assert client.get("/api/assets/00000000-0000-0000-0000-000000000001/preview").status_code == 401
            assert client.post("/__local/session", json={"token": handoff["bootstrapToken"]}).status_code == 204
            yield child, client, root
        child.stdin.write(json.dumps({"command": "shutdown", "requestId": secrets.token_hex(32)}) + "\n")
        child.stdin.flush()
        assert child.wait(timeout=20) == 0
        assert not (root / "desktop-session.dpapi").exists()
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)


def test_frozen_protocol_ui_and_formal_storage_outside_repository(tmp_path):
    assert not Path(APPLICATION).resolve().is_relative_to(Path(__file__).resolve().parents[2])
    poc = tmp_path / "GenzoRoom/WindowsPoC"
    poc.mkdir(parents=True)
    sentinel = poc / "connection.json"
    sentinel.write_text("never migrated")
    with backend(tmp_path) as (_child, client, root):
        assert client.get("/api/health").status_code == 200
        html = client.get("/")
        assert html.status_code == 200 and "text/html" in html.headers["content-type"]
        assert client.get("/edit/example", headers={"Accept": "text/html"}).text == html.text
        assert client.get("/api/not-a-route", headers={"Accept": "text/html"}).status_code == 404
        assert (root / "profiles/unconfigured/data/genzoroom.db").is_file()
        assert sentinel.read_text() == "never migrated"


def test_frozen_native_runtime_selfcheck(tmp_path):
    result = subprocess.run([str(Path(APPLICATION) / "backend/genzoroom-backend.exe"), "--check-runtime"],
                            cwd=tmp_path, env={**os.environ, "LOCALAPPDATA": str(tmp_path)}, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["jpegIccNumpy"]
    assert not list(tmp_path.iterdir())


@pytest.mark.skipif(os.environ.get("GENZOROOM_BUNDLED_SMOKE") != "1", reason="Needs smoke host to suppress native error dialog")
def test_missing_backend_fails_without_development_fallback(tmp_path):
    import shutil
    host = tmp_path / "application/genzoroom-desktop.exe"
    host.parent.mkdir()
    shutil.copyfile(Path(APPLICATION) / host.name, host)
    result = subprocess.run([str(host), "--process-smoke"], cwd=tmp_path,
                            env={**os.environ, "LOCALAPPDATA": str(tmp_path / "user")},
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 1 and "backend_bundle_missing" in result.stderr
    log = tmp_path / "user/GenzoRoom/logs/host.jsonl"
    assert json.loads(log.read_text()) == {"event": "startup_failed", "errorCode": "backend_bundle_missing"}
    assert not list((tmp_path / "user").rglob("*.db"))


@pytest.mark.skipif(os.environ.get("GENZOROOM_BUNDLED_SMOKE") == "1", reason="Checks the non-smoke production entry")
def test_normal_distribution_window_closes_owned_backend(tmp_path):
    import ctypes
    from ctypes import wintypes
    from time import monotonic, sleep
    from windows_local import DEFAULT_PORT, reserve_listener
    with reserve_listener(DEFAULT_PORT):
        pass
    host = subprocess.Popen([str(Path(APPLICATION) / "genzoroom-desktop.exe")], cwd=tmp_path,
                            env={**os.environ, "LOCALAPPDATA": str(tmp_path), "IMMICH_URL": "", "IMMICH_API_KEY": "",
                                 "PATH": os.path.join(os.environ["SystemRoot"], "System32")})
    user = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    windows = []

    @callback_type
    def find_window(window, _parameter):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(pid))
        title = ctypes.create_unicode_buffer(256)
        user.GetWindowTextW(window, title, len(title))
        if pid.value == host.pid and title.value == "GenzoRoom":
            windows.append(window)
        return True

    try:
        # Poll observable native state; shutdown itself still uses the real host lifecycle.
        deadline = monotonic() + 35
        authenticated = False
        while monotonic() < deadline:
            assert host.poll() is None
            if not windows:
                user.EnumWindows(find_window, 0)
            try:
                with httpx.Client(trust_env=False, timeout=.5) as client:
                    authenticated = client.get("http://127.0.0.1:3191/__local/desktop-ready",
                                               params={"challenge": secrets.token_hex(32)}).status_code == 409
            except httpx.HTTPError:
                pass
            if windows and authenticated:
                break
            sleep(.05)
        assert windows and authenticated
        assert (tmp_path / "GenzoRoom/profiles/unconfigured/data/genzoroom.db").is_file()
        assert user.PostMessageW(windows[0], 0x0010, 0, 0)  # WM_CLOSE
        assert host.wait(timeout=25) == 0
        assert not (tmp_path / "GenzoRoom/desktop-session.dpapi").exists()
        with reserve_listener(DEFAULT_PORT):
            pass
    finally:
        if host.poll() is None:
            host.kill(); host.wait(timeout=10)
