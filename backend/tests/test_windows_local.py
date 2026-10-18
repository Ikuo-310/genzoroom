import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from threading import Thread
from time import monotonic, sleep
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
import uvicorn

import edit_store
import main
import storage
from immich import ImmichThumbnail
from windows_local import FRONTEND_DIST, LocalHost, LocalServer, reserve_listener


@pytest.fixture
def local(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>GenzoRoom shell</title>")
    (dist / "assets").mkdir()
    (dist / "assets" / "app.js").write_text("console.log('asset')")
    root = tmp_path / "local-user" / "GenzoRoom" / "WindowsPoC"
    monkeypatch.setattr(storage, "STORAGE_ROOT", root)
    monkeypatch.setattr(storage, "DB_PATH", root / "data" / "genzoroom.db")
    monkeypatch.setattr(storage, "WINDOWS_STORAGE", True)
    monkeypatch.setattr(edit_store, "DB_PATH", storage.DB_PATH)
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    return LocalHost(main.app, dist=dist)


def client(host):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=host), base_url=host.origin)


async def authenticate(http, host):
    token = host.bootstrap_token
    response = await http.post("/__local/session", json={"token": token}, headers={"Origin": host.origin})
    assert response.status_code == 204
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    return token


@pytest.mark.parametrize("path", ["/", "/assets/app.js", "/api/health", "/api/export/queue",
                                 f"/api/assets/{uuid4()}/preview", f"/api/assets/{uuid4()}/original"])
def test_unauthenticated_content_is_blocked(local, path):
    async def exercise():
        async with client(local) as http:
            response = await http.get(path)
            assert response.status_code == 401
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["referrer-policy"] == "no-referrer"
    asyncio.run(exercise())


def test_session_is_one_time_and_images_need_no_custom_headers(local, monkeypatch):
    preview = AsyncMock(return_value=ImmichThumbnail(b"jpeg-preview", "image/jpeg"))
    monkeypatch.setattr(main, "get_asset_preview", preview)

    async def exercise():
        async with client(local) as http:
            token = await authenticate(http, local)
            assert (await http.get("/api/health")).json() == {"status": "ok"}
            response = await http.get(f"/api/assets/{uuid4()}/preview")
            assert response.content == b"jpeg-preview"
            assert response.headers["content-type"] == "image/jpeg"
            assert response.headers["cache-control"] == "no-store"
            assert (await http.post("/__local/session", json={"token": token},
                                    headers={"Origin": local.origin})).status_code == 403
        async with client(local) as fresh_browser:
            assert (await fresh_browser.get("/api/health")).status_code == 401
        restarted = LocalHost(main.app, dist=Path(local.application.routes[-1].app.directory))
        async with client(restarted) as next_start:
            next_start.cookies.set(local.cookie_name, local.session_token)
            assert (await next_start.get("/api/health")).status_code == 401
    asyncio.run(exercise())


@pytest.mark.parametrize("headers", [
    {"Host": "localhost:3191"}, {"Host": "evil.example:3191"},
    {"Host": "127.0.0.1:8000"}, {"Origin": "null"}, {"Origin": "http://evil.example"},
    {"Origin": "http://127.0.0.1:8000"}, {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"},
    [("Host", "127.0.0.1:3191"), ("Host", "evil.example")],
    [("Origin", "http://127.0.0.1:3191"), ("Origin", "http://evil.example")],
])
def test_host_origin_and_cross_site_requests_are_blocked_even_with_cookie(local, headers):
    async def exercise():
        async with client(local) as http:
            await authenticate(http, local)
            for path in ("/api/health", "/", "/__local/bootstrap"):
                assert (await http.get(path, headers=headers)).status_code == 403
    asyncio.run(exercise())


@pytest.mark.parametrize("payload", [{"token": "wrong"}, {"token": "日本語"}, {"token": None}, [], None])
def test_invalid_bootstrap_does_not_consume_session(local, payload):
    async def exercise():
        async with client(local) as http:
            response = await http.post("/__local/session", json=payload, headers={"Origin": local.origin})
            assert response.status_code == 403
            await authenticate(http, local)
    asyncio.run(exercise())


def test_bootstrap_requires_same_origin_json_and_bounds_body(local):
    async def exercise():
        async with client(local) as http:
            token = local.bootstrap_token
            assert (await http.get("/__local/session")).status_code == 403
            assert (await http.post("/__local/session", json={"token": token})).status_code == 403
            assert (await http.post("/__local/session", content=token,
                                    headers={"Origin": local.origin, "Content-Type": "text/plain"})).status_code == 403
            assert (await http.post("/__local/session", content="{", headers={
                "Origin": local.origin, "Content-Type": "application/json"})).status_code == 403
            assert (await http.post("/__local/session", json={"token": "x" * 2048},
                                    headers={"Origin": local.origin})).status_code == 413
            bootstrap = await http.get("/__local/bootstrap")
            assert bootstrap.status_code == 200 and token not in bootstrap.text
            script = await http.get("/__local/bootstrap.js")
            assert "history.replaceState" in script.text and token not in script.text
            await authenticate(http, local)
    asyncio.run(exercise())


def test_api_errors_assets_and_spa_navigation_are_distinct(local):
    async def exercise():
        async with client(local) as http:
            await authenticate(http, local)
            for path in ("/", "/developer", f"/anshitsu/{uuid4()}", "/stack"):
                response = await http.get(path, headers={"Accept": "text/html"})
                assert response.status_code == 200 and "GenzoRoom shell" in response.text
            for path, status in (("/api/not-present", 404), ("/api/assets/not-a-uuid/preview", 422)):
                response = await http.get(path, headers={"Accept": "text/html"})
                assert response.status_code == status
                assert response.headers["content-type"] == "application/json"
            root = await http.get("/api", headers={"Accept": "text/html"}, follow_redirects=True)
            assert root.status_code == 404 and root.headers["content-type"] == "application/json"
            assert (await http.get("/assets/app.js")).status_code == 200
            assert (await http.get("/assets/missing.js", headers={"Accept": "text/html"})).status_code == 404
            assert (await http.post("/developer")).status_code == 405
            assert (await http.head("/developer", headers={"Accept": "text/html"})).status_code == 200
    asyncio.run(exercise())


def test_mounted_lifespan_initializes_one_windows_db_and_cache(local):
    async def exercise():
        async with local.application.router.lifespan_context(local.application):
            assert storage.DB_PATH.is_file()
            assert (storage.STORAGE_ROOT / "cache" / "thumbnails").is_dir()
            assert main.app.state.thumbnail_cache.root == storage.STORAGE_ROOT / "cache" / "thumbnails"
            assert edit_store.list_export_queue() == []
            assert main.app.state.export_runtime._task is None
        storage.validate_existing_database()
        assert list(storage.STORAGE_ROOT.rglob("genzoroom.db")) == [storage.DB_PATH]
    asyncio.run(exercise())


def test_windows_configuration_happens_before_consumer_imports(tmp_path):
    env = {**os.environ, "LOCALAPPDATA": str(tmp_path), "IMMICH_URL": "", "IMMICH_API_KEY": ""}
    result = subprocess.run([sys.executable, "-c", """
import storage
storage.configure_windows_storage()
import edit_store
from thumbnail_cache import ThumbnailCache
assert storage.WINDOWS_STORAGE
assert storage.DB_PATH == edit_store.DB_PATH
assert ThumbnailCache().root == storage.STORAGE_ROOT / 'cache' / 'thumbnails'
assert storage.STORAGE_ROOT.parts[-2:] == ('GenzoRoom', 'WindowsPoC')
storage.initialize_storage()
edit_store.initialize_database()
storage.validate_existing_database()
try:
    storage.configure_windows_storage()
except RuntimeError as error:
    assert str(error) == 'windows_storage_configuration_too_late'
else:
    raise AssertionError('late configuration accepted')
"""], env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("base", ["", "relative", "\\\\server\\share"])
def test_invalid_windows_storage_never_falls_back(base):
    env = {**os.environ, "LOCALAPPDATA": base}
    result = subprocess.run([sys.executable, "-c", """
import storage
try:
    storage.configure_windows_storage()
except storage.StorageInitializationError as error:
    assert error.code == 'windows_storage_location_invalid'
else:
    raise AssertionError('invalid storage accepted')
"""], env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_port_conflict_is_explicit():
    with reserve_listener(0) as occupied:
        with pytest.raises(RuntimeError, match="local_port_unavailable"):
            reserve_listener(occupied.getsockname()[1])


def test_frontend_build_required(tmp_path):
    with pytest.raises(RuntimeError, match="frontend_build_missing"):
        LocalHost(main.app, dist=tmp_path)


def test_diagnostics_never_record_bootstrap_or_session_and_failure_is_optional(local, monkeypatch):
    import windows_local
    entries = []
    monkeypatch.setattr(windows_local.backend_logger, "add", lambda **entry: entries.append(entry))
    bootstrap, session = local.bootstrap_token, local.session_token

    async def exercise():
        async with client(local) as http:
            await http.post("/__local/session", json={"token": "secret-invalid-token"},
                            headers={"Origin": local.origin})
            await authenticate(http, local)
            assert (await http.get("/api/health")).status_code == 200
    asyncio.run(exercise())
    assert [entry["event"] for entry in entries] == ["authentication.rejected", "authentication.completed"]
    assert all(secret not in repr(entries) for secret in (bootstrap, session, "secret-invalid-token"))

    def broken_logger(**_entry):
        raise RuntimeError("optional logger failure")
    monkeypatch.setattr(windows_local.backend_logger, "add", broken_logger)
    local.bootstrap_token = "another-token"
    asyncio.run(exercise())


def test_built_react_shell_and_static_assets_use_same_authenticated_origin(local):
    if not (FRONTEND_DIST / "index.html").is_file():
        pytest.skip("Build frontend before running built-artifact integration")
    import re
    host = LocalHost(main.app)

    async def exercise():
        async with client(host) as http:
            await authenticate(http, host)
            shell = await http.get(f"/anshitsu/{uuid4()}", headers={"Accept": "text/html"})
            assert shell.status_code == 200 and '<div id="root">' in shell.text
            assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', shell.text)
            assert assets
            for path in assets:
                response = await http.get(path)
                assert response.status_code == 200
                assert "text/html" not in response.headers["content-type"]
    asyncio.run(exercise())


def test_browser_only_opens_after_successful_startup(local, monkeypatch):
    import windows_local
    opened = []
    monkeypatch.setattr(windows_local.webbrowser, "open", lambda url: opened.append(url) or True)
    server = LocalServer(uvicorn.Config(local, log_config=None, access_log=False), local)
    async def startup(_self, sockets=None):
        _self.started = True
    monkeypatch.setattr(uvicorn.Server, "startup", startup)
    expected = local.bootstrap_url
    asyncio.run(server.startup())
    assert opened == [expected]


def test_real_windows_http_listener_initializes_and_stops(local):
    # Exercise real Uvicorn transport and the real API lifespan without touching Immich.
    with reserve_listener(0) as listener:
        port = listener.getsockname()[1]
        host = LocalHost(main.app, port=port, dist=Path(local.application.routes[-1].app.directory))
        server = LocalServer(uvicorn.Config(host, host="127.0.0.1", port=port,
                                           proxy_headers=False, access_log=False, log_config=None),
                             host, open_browser=False)
        thread = Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            deadline = monotonic() + 10
            while not server.started and thread.is_alive() and monotonic() < deadline:
                sleep(0.02)
            assert server.started
            with httpx.Client(base_url=host.origin, trust_env=False, timeout=5) as http:
                assert http.get("/api/health").status_code == 401
                assert http.post("/__local/session", json={"token": host.bootstrap_token},
                                 headers={"Origin": host.origin}).status_code == 204
                assert http.get("/api/health").json() == {"status": "ok"}
                assert http.get("/api/export/queue").status_code == 200
                assert http.get("/anshitsu/example", headers={"Accept": "text/html"}).status_code == 200
                assert http.get("/api/missing").status_code == 404
                assert http.get("/api/health", headers={"Host": "evil.example"}).status_code == 403
                assert storage.DB_PATH.is_file()
                assert (storage.STORAGE_ROOT / "cache" / "thumbnails").is_dir()
        finally:
            server.should_exit = True
            thread.join(timeout=10)
        assert not thread.is_alive()


def test_cli_port_conflict_does_not_initialize_storage(tmp_path):
    if sys.platform != "win32":
        pytest.skip("Windows entry point")
    with reserve_listener(0) as occupied:
        result = subprocess.run([sys.executable, "windows_local.py", "--no-browser", "--port",
                                 str(occupied.getsockname()[1])],
                                env={**os.environ, "LOCALAPPDATA": str(tmp_path)},
                                capture_output=True, text=True, timeout=20)
    assert result.returncode == 1
    assert "local_port_unavailable" in result.stderr
    assert not (tmp_path / "GenzoRoom").exists()


@pytest.mark.parametrize("mode", ["--no-browser", "--desktop"])
def test_windows_cli_build_startup_and_graceful_shutdown(tmp_path, mode):
    if sys.platform != "win32" or not (FRONTEND_DIST / "index.html").is_file():
        pytest.skip("Windows and built frontend required")
    with reserve_listener(0) as probe:
        port = probe.getsockname()[1]
    # A no-op outer handler permits observing Uvicorn's completed SIGBREAK drain and exit code.
    command = """
import os, signal, sys
signal.signal(signal.SIGBREAK, lambda *_: None)
if os.environ.get('GENZOROOM_WEBVIEW_SMOKE') == '1':
    from tests.windows_desktop_fixture import start
    start()
from windows_local import main
raise SystemExit(main([sys.argv[2], '--port', sys.argv[1]]))
"""
    process = subprocess.Popen([sys.executable, "-c", command, str(port), mode],
                               env={**os.environ, "LOCALAPPDATA": str(tmp_path),
                                    "IMMICH_URL": "", "IMMICH_API_KEY": ""},
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = monotonic() + 15
        ready = False
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=0.5) as http:
            while monotonic() < deadline and process.poll() is None:
                try:
                    ready = http.get("/api/health").status_code == 401
                except httpx.TransportError:
                    pass
                if ready:
                    break
                sleep(0.05)
        assert ready
        root = tmp_path / "GenzoRoom" / "WindowsPoC"
        assert (root / "data" / "genzoroom.db").is_file()
        assert (root / "cache" / "thumbnails").is_dir()
        if mode == "--desktop":
            from windows_desktop_handoff import protect_for_current_user
            encrypted = (root / "desktop-session.dpapi").read_bytes()
            payload = json.loads(protect_for_current_user(encrypted, decrypt=True))
            assert set(payload) == {"version", "port", "bootstrapToken", "probeKey"}
            assert payload["port"] == port
            assert payload["bootstrapToken"].encode() not in encrypted
            assert payload["probeKey"].encode() not in encrypted
            native = Path(__file__).resolve().parents[2] / "desktop" / "target" / "debug" / "genzoroom-desktop.exe"
            if native.is_file():
                check = subprocess.run([str(native), "--check-backend"],
                                       env={**os.environ, "LOCALAPPDATA": str(tmp_path)},
                                       capture_output=True, text=True, timeout=15)
                assert check.returncode == 0, check.stderr
                assert "backend_verified" in check.stdout
                assert payload["bootstrapToken"] not in check.stdout + check.stderr
                if os.environ.get("GENZOROOM_WEBVIEW_SMOKE") == "1":
                    smoke = subprocess.run([str(native), "--webview-smoke"],
                                           env={**os.environ, "LOCALAPPDATA": str(tmp_path)},
                                           capture_output=True, text=True, timeout=50)
                    assert smoke.returncode == 0, smoke.stdout + smoke.stderr
                    assert '"sharedCookie":true' in smoke.stdout
                    assert '"image":true' in smoke.stdout
                    assert payload["bootstrapToken"] not in smoke.stdout + smoke.stderr
                    assert payload["probeKey"] not in smoke.stdout + smoke.stderr
                    for line in smoke.stdout.splitlines():
                        if line.startswith("GenzoRoom WebView2 smoke: {"):
                            print(line)
                    # The WebView performed the normal one-time exchange; this test must not replay it.
                    payload["bootstrapToken"] = None
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=2) as http:
                proof = http.get("/__local/desktop-ready", params={"challenge": "01" * 32})
                expected = hmac.new(bytes.fromhex(payload["probeKey"]),
                                    b"GenzoRoom desktop probe v1:" + b"01" * 32, hashlib.sha256).hexdigest()
                if payload["bootstrapToken"] is None:
                    assert proof.status_code == 409
                else:
                    assert proof.json() == {"version": 1, "proof": expected}
                assert http.get("/api/health").status_code == 401
                if payload["bootstrapToken"] is not None:
                    assert http.post("/__local/session", json={"token": payload["bootstrapToken"]},
                                     headers={"Origin": str(http.base_url).rstrip("/")}).status_code == 204
                    assert http.get("/api/health").json() == {"status": "ok"}
        process.send_signal(signal.CTRL_BREAK_EVENT)
        stdout, stderr = process.communicate(timeout=15)
        assert process.returncode == 0, stderr
        assert "Windows PoC ready" in stdout
        assert "/__local/bootstrap#" not in stdout
        assert not (root / "desktop-session.dpapi").exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
    # The process did not leave a child server or a reserved listener behind.
    with reserve_listener(port):
        pass


def test_desktop_probe_proves_instance_without_consuming_bootstrap(local):
    local.desktop_probe_key = "ab" * 32
    token = local.bootstrap_token

    async def exercise():
        async with client(local) as http:
            for challenge in ("01" * 32, "02" * 32):
                response = await http.get("/__local/desktop-ready", params={"challenge": challenge})
                assert response.status_code == 200
                expected = hmac.new(bytes.fromhex(local.desktop_probe_key),
                                    b"GenzoRoom desktop probe v1:" + challenge.encode(), hashlib.sha256).hexdigest()
                assert response.json() == {"version": 1, "proof": expected}
                assert token not in response.text and local.desktop_probe_key not in response.text
            assert local.bootstrap_token == token
            assert (await http.get("/api/health")).status_code == 401
            assert (await http.get("/__local/desktop-ready?challenge=wrong")).status_code == 400
            assert (await http.get("/__local/desktop-ready", params={"challenge": "01" * 32},
                                   headers={"Origin": "http://evil.example"})).status_code == 403
            await authenticate(http, local)
            assert (await http.get("/__local/desktop-ready", params={"challenge": "01" * 32})).status_code == 409
    asyncio.run(exercise())


@pytest.mark.skipif(sys.platform != "win32", reason="Windows DPAPI")
def test_desktop_handoff_is_encrypted_atomic_and_owned(tmp_path):
    from windows_desktop_handoff import DesktopHandoff, protect_for_current_user
    first = DesktopHandoff(tmp_path)
    first.publish(port=3191, bootstrap_token="bootstrap-secret", probe_key="probe-secret")
    content = first.path.read_bytes()
    assert b"bootstrap-secret" not in content and b"probe-secret" not in content
    assert json.loads(protect_for_current_user(content, decrypt=True))["bootstrapToken"] == "bootstrap-secret"
    corrupt = bytearray(content)
    corrupt[-1] ^= 1
    with pytest.raises(RuntimeError, match="desktop_handoff_crypto_failed"):
        protect_for_current_user(bytes(corrupt), decrypt=True)
    second = DesktopHandoff(tmp_path)
    second.publish(port=3192, bootstrap_token="new-secret", probe_key="new-probe")
    first.close()
    assert second.path.is_file()
    second.close()
    assert not second.path.exists()
    assert list(tmp_path.glob("desktop-session-*.tmp")) == []
