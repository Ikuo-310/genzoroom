"""Opt-in native ownership checks; never contact an actual Immich server."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import secrets
import sqlite3
from queue import Queue, Empty
from threading import Thread
from time import monotonic
from uuid import uuid4
from unittest.mock import patch

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
        assert (tmp_path / "GenzoRoom/WindowsPoC/profiles/unconfigured/data/genzoroom.db").is_file()
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
        assert not (os.environ["IMMICH_API_KEY"] in result.stdout + result.stderr)
        assert not (tmp_path / "GenzoRoom/WindowsPoC/desktop-session.dpapi").exists()
        with reserve_listener(DEFAULT_PORT):
            pass
        for line in result.stdout.splitlines():
            if line.startswith(("GenzoRoom WebView2 smoke: {", "GenzoRoom keyboard smoke: {")):
                print(line)
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("change", ["key", "user", "server", "failure"])
def test_saved_connection_restart_isolates_database_queue_and_react_state(tmp_path, monkeypatch, change):
    import edit_store
    from tests.test_export_queue import A, snapshot
    from tests.windows_desktop_fixture import start
    from windows_connection import ConnectionStore
    from windows_credentials import CredentialVault
    with reserve_listener(DEFAULT_PORT):
        pass
    monkeypatch.setenv("IMMICH_URL", "")
    monkeypatch.setenv("IMMICH_API_KEY", "")
    first_server = start()
    first_url, first_key = os.environ["IMMICH_URL"], os.environ["IMMICH_API_KEY"]
    store = ConnectionStore(tmp_path / "GenzoRoom/WindowsPoC", CredentialVault())
    first = store.save(first_url, first_server.user_id, first_key)
    second_server = None
    parent = None
    try:
        parent = subprocess.Popen([str(NATIVE), "--restart-failure-smoke" if change == "failure" else "--restart-smoke"],
                                  env={**os.environ, "LOCALAPPDATA": str(tmp_path)},
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        lines = Queue()
        def read():
            for line in parent.stdout:
                lines.put(line)
        Thread(target=read, daemon=True).start()
        deadline = monotonic() + 35
        while monotonic() < deadline:
            try:
                if lines.get(timeout=.5).startswith("GenzoRoom restart smoke: ready"):
                    break
            except Empty:
                assert parent.poll() is None
        else:
            pytest.fail("Native restart preparation timed out")
        old_database = store.root / "profiles" / first["profile"] / "data/genzoroom.db"
        with patch.object(edit_store, "DB_PATH", old_database):
            state = snapshot(A)
            current_recipe = json.loads(json.dumps(state["currentRecipe"]))
            before_recipe = json.loads(json.dumps(current_recipe))
            before_recipe["adjustments"]["temperature"] = 0
            state["history"] = [{"kind": "temperature", "before": before_recipe, "after": current_recipe}]
            state["historyCursor"] = 1
            edit_store.put_edit_state(A, 0, uuid4(), state)
            edit_store.enqueue_export_assets([A])
        if change == "user":
            new_key, new_user = secrets.token_urlsafe(32), str(uuid4())
            first_server.users[new_key] = new_user
            second = store.save(first_url, new_user, new_key)
        elif change == "key":
            new_key = secrets.token_urlsafe(32)
            first_server.users[new_key] = first_server.user_id
            second = store.save(first_url, first_server.user_id, new_key)
        else:
            second_server = start()
            second = store.save(os.environ["IMMICH_URL"], second_server.user_id, os.environ["IMMICH_API_KEY"])
        new_database = store.root / "profiles" / second["profile"] / "data/genzoroom.db"
        if change == "failure":
            new_database.parent.mkdir(parents=True)
            with sqlite3.connect(new_database) as database:
                database.execute("PRAGMA user_version=999")
        parent.stdin.write("restart\n"); parent.stdin.flush()
        assert parent.wait(timeout=45) == 0
        output = "".join(list(lines.queue))
        assert '"documentFresh":true' in output and '"sessionCleared":true' in output
        if change == "failure":
            assert '"recoveryReady":true' in output and '"settingsAvailable":true' in output
        assert not (first_key in output)
        with sqlite3.connect(old_database) as database:
            assert database.execute("SELECT COUNT(*) FROM export_queue").fetchone()[0] == 1
        with sqlite3.connect(new_database) as database:
            if change == "failure":
                assert database.execute("PRAGMA user_version").fetchone()[0] == 999
                assert store.read()["selected"] == second
                assert (store.root / "profiles/unconfigured/data/genzoroom.db").is_file()
            elif change == "key":
                assert database.execute("SELECT COUNT(*) FROM export_queue").fetchone()[0] == 1
                row = database.execute("SELECT current_recipe_json, history_json, history_cursor FROM asset_edit_states").fetchone()
                assert row[2] == 1
                assert json.loads(row[0])["adjustments"]["temperature"] == 12
                assert len(json.loads(row[1])) == 1
            else:
                assert database.execute("SELECT COUNT(*) FROM export_queue").fetchone()[0] == 0
                assert database.execute("SELECT COUNT(*) FROM asset_edit_states").fetchone()[0] == 0
        assert (old_database == new_database) is (change == "key")
        assert not (store.root / "desktop-session.dpapi").exists()
        for line in output.splitlines():
            if line.startswith(("GenzoRoom restart smoke:", "GenzoRoom keyboard smoke:", "GenzoRoom recovery smoke:")):
                print(line)
        with reserve_listener(DEFAULT_PORT):
            pass
    finally:
        if parent is not None and parent.poll() is None:
            parent.kill(); parent.communicate(timeout=10)
        store.delete()
        first_server.shutdown(); first_server.server_close()
        if second_server:
            second_server.shutdown(); second_server.server_close()
