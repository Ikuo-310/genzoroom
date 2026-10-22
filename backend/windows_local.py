"""Windows PoC host: same-origin UI/API, per-start browser authentication, one worker."""

import argparse
import asyncio
from contextlib import asynccontextmanager
from http.cookies import CookieError, SimpleCookie
import json
import hashlib
import hmac
import secrets
import socket
import sys
from pathlib import Path
import webbrowser

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
import uvicorn

from backend_logging import backend_logger
from lightcraft_runtime import LightCraftManager
from lightcraft_raw import LightCraftRawSession
from windows_raw_api import RawPreviewApi

DEFAULT_PORT = 3191
FRONTEND_DIST = (Path(__file__).resolve().parent / "frontend" / "dist" if getattr(sys, "frozen", False)
                 else Path(__file__).resolve().parent.parent / "frontend" / "dist")

BOOTSTRAP_HTML = """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="referrer" content="no-referrer"><title>GenzoRoom</title>
<p id="status">Opening GenzoRoom…</p><script src="/__local/bootstrap.js"></script></html>"""
BOOTSTRAP_JS = """(async () => {
  const token = location.hash.slice(1);
  history.replaceState(null, '', '/__local/bootstrap');
  try {
    const response = await fetch('/__local/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), credentials: 'same-origin'
    });
    if (!response.ok) throw new Error();
    location.replace('/');
  } catch {
    document.getElementById('status').textContent =
      'Session unavailable. Restart the Windows PoC to open a new session.';
  }
})();"""


def local_log(event, *, level="info", **context):
    try:
        backend_logger.add(level=level, component="windows_local", event=event, context=context)
    except Exception:
        # Optional diagnostics must never affect authentication or process lifetime.
        pass


class SpaFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as error:
            # Only navigations get the SPA shell; missing assets keep real 404 responses.
            if error.status_code != 404 or scope["method"] not in ("GET", "HEAD") \
                    or Path(path).suffix or "text/html" not in Request(scope).headers.get("accept", ""):
                raise
            return await super().get_response("index.html", scope)


class LocalHost:
    def __init__(self, backend, *, port=DEFAULT_PORT, dist=FRONTEND_DIST, connection=None):
        if not (dist / "index.html").is_file():
            raise RuntimeError("frontend_build_missing")
        self.authority = f"127.0.0.1:{port}"
        self.origin = f"http://{self.authority}"
        self.bootstrap_token = secrets.token_urlsafe(32)
        self.session_token = secrets.token_urlsafe(32)
        self.cookie_name = f"genzoroom_local_{port}"
        self.desktop_probe_key = None
        self.backend = backend
        self.connection = connection
        self.raw_api = RawPreviewApi()

        @asynccontextmanager
        async def lifespan(_app):
            # Mounted ASGI apps do not run their lifespan automatically.
            async with backend.router.lifespan_context(backend):
                manager = LightCraftManager()
                backend.state.lightcraft = manager
                raw = LightCraftRawSession(manager)
                backend.state.lightcraft_raw = raw
                self.raw_api.bind(raw, manager)
                try:
                    # RAW availability must not delay JPEG readiness or the desktop handoff.
                    await manager.start()
                    yield
                finally:
                    try:
                        await self.raw_api.close()
                    finally:
                        await manager.close()

        async def api_root(_request):
            # A root static mount otherwise swallows /api before Starlette's slash redirect.
            return RedirectResponse("/api/")

        routes = []
        if connection is not None:
            routes.append(Route("/__local/connection", endpoint=connection.endpoint, methods=["GET", "POST", "PUT", "DELETE"]))
        self.application = Starlette(routes=[*routes,
            Route("/api", endpoint=api_root, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
            Mount("/api/raw", app=self.raw_api.app),
            Mount("/api", app=backend),
            Mount("/", app=SpaFiles(directory=dist, html=True)),
        ], lifespan=lifespan)

    @property
    def bootstrap_url(self):
        # A fragment never enters the HTTP request target or access logs.
        return f"{self.origin}/__local/bootstrap#{self.bootstrap_token}"

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.application(scope, receive, send)
        if scope["type"] != "http":
            return
        request = Request(scope, receive)

        async def protected_send(message):
            if message["type"] == "http.response.start":
                # HTML, image and API responses share the same privacy boundary.
                headers = [(key, value) for key, value in message.get("headers", [])
                           if key.lower() not in (b"cache-control", b"referrer-policy")]
                message = {**message, "headers": headers + [
                    (b"cache-control", b"no-store"), (b"referrer-policy", b"no-referrer"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"content-security-policy", b"default-src 'self'; script-src 'self'; "
                     b"style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
                     b"worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
                     b"base-uri 'none'; form-action 'none'"),
                ]}
            await send(message)

        hosts = request.headers.getlist("host")
        origins = request.headers.getlist("origin")
        if hosts != [self.authority] or scope.get("scheme") != "http":
            response = JSONResponse({"error": "invalid_host"}, status_code=403)
        elif (origins and origins != [self.origin]) \
                or request.headers.get("sec-fetch-site") in ("cross-site", "same-site"):
            response = JSONResponse({"error": "invalid_origin"}, status_code=403)
        elif request.url.path == "/__local/bootstrap" and request.method == "GET":
            response = HTMLResponse(BOOTSTRAP_HTML)
        elif request.url.path == "/__local/bootstrap.js" and request.method == "GET":
            response = Response(BOOTSTRAP_JS, media_type="application/javascript")
        elif request.url.path == "/__local/session":
            response = await self.authenticate(request)
        elif request.url.path == "/__local/desktop-ready" and self.desktop_probe_key is not None:
            response = self.desktop_ready(request)
        elif not self.authenticated(request):
            response = JSONResponse({"error": "local_session_required"}, status_code=401)
        else:
            return await self.application(scope, receive, protected_send)
        await response(scope, receive, protected_send)

    def desktop_ready(self, request):
        challenge = request.query_params.get("challenge", "")
        if request.method != "GET" or len(challenge) != 64 \
                or any(character not in "0123456789abcdef" for character in challenge):
            return JSONResponse({"error": "invalid_desktop_probe"}, status_code=400)
        if self.bootstrap_token is None:
            return JSONResponse({"error": "desktop_session_already_used"}, status_code=409)
        # Prove instance identity before the desktop sends any bootstrap credential over HTTP.
        proof = hmac.new(bytes.fromhex(self.desktop_probe_key),
                         b"GenzoRoom desktop probe v1:" + challenge.encode("ascii"), hashlib.sha256).hexdigest()
        return JSONResponse({"version": 1, "proof": proof})

    def authenticated(self, request):
        cookie = SimpleCookie()
        try:
            cookie.load(request.headers.get("cookie", ""))
            value = cookie.get(self.cookie_name)
            return value is not None and value.value.isascii() and secrets.compare_digest(value.value, self.session_token)
        except (CookieError, TypeError):
            return False

    async def authenticate(self, request):
        if request.method != "POST" or request.headers.getlist("origin") != [self.origin] \
                or request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
            return JSONResponse({"error": "invalid_session_request"}, status_code=403)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 1024:
                return JSONResponse({"error": "invalid_session_request"}, status_code=413)
        try:
            payload = json.loads(body)
            token = payload.get("token") if isinstance(payload, dict) else None
        except (ValueError, UnicodeError):
            token = None
        # No await between checking and consuming: concurrent exchanges cannot reuse a token.
        if not isinstance(token, str) or not token.isascii() or not self.bootstrap_token \
                or not secrets.compare_digest(token, self.bootstrap_token):
            local_log("authentication.rejected", level="warn", errorCode="invalid_bootstrap")
            return JSONResponse({"error": "invalid_session"}, status_code=403)
        self.bootstrap_token = None
        response = Response(status_code=204)
        response.set_cookie(self.cookie_name, self.session_token, httponly=True, samesite="strict", path="/")
        local_log("authentication.completed")
        return response


def reserve_listener(port):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        # Bind before persistence/recovery; never fall back to another origin or reuse a listener.
        listener.bind(("127.0.0.1", port))
        listener.listen(128)
        return listener
    except OSError:
        listener.close()
        raise RuntimeError("local_port_unavailable") from None


class LocalServer(uvicorn.Server):
    def __init__(self, config, host, *, open_browser=True, desktop=False, launch_id=None):
        super().__init__(config)
        self.local_host, self.open_browser = host, open_browser
        self.desktop = desktop
        self.handoff = None
        self.launch_id = launch_id

    async def startup(self, sockets=None):
        await super().startup(sockets=sockets)
        if self.started:
            if self.desktop:
                from windows_desktop_handoff import DesktopHandoff
                from windows_connection import user_root
                self.handoff = DesktopHandoff(user_root())
                self.local_host.desktop_probe_key = secrets.token_hex(32)
                try:
                    self.handoff.publish(port=self.config.port, bootstrap_token=self.local_host.bootstrap_token,
                                         probe_key=self.local_host.desktop_probe_key, launch_id=self.launch_id)
                except Exception:
                    await self.shutdown(sockets=sockets)
                    raise RuntimeError("desktop_handoff_failed") from None
            if self.launch_id is not None:
                from windows_managed import ManagedControl
                ManagedControl(self).start()
            local_log("server.started", port=self.config.port)
            print(f"GenzoRoom Windows PoC ready on {self.local_host.origin}", flush=True)
            if self.open_browser:
                try:
                    if not webbrowser.open(self.local_host.bootstrap_url):
                        raise RuntimeError()
                except Exception:
                    local_log("browser.openFailed", level="warn", errorCode="browser_open_failed")
                    print("Browser could not open. Configure the default browser and restart.", flush=True)

    async def shutdown(self, sockets=None):
        try:
            await super().shutdown(sockets=sockets)
        finally:
            if self.handoff is not None:
                try:
                    self.handoff.close()
                except OSError:
                    local_log("handoff.cleanupFailed", level="warn", errorCode="desktop_handoff_cleanup_failed")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start the Windows local GenzoRoom PoC")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--no-browser", action="store_true", help="Headless startup check; no interactive session")
    mode.add_argument("--desktop", action="store_true", help="Publish an encrypted handoff for the manual Tauri host")
    parser.add_argument("--managed", action="store_true", help="Use the private inherited desktop control pipe")
    parser.add_argument("--environment", action="store_true", help="Explicit diagnostic environment connection; isolated temporary profile")
    parser.add_argument("--connection-recovery", action="store_true", help="Open unconfigured Settings after failed restart")
    parser.add_argument("--check-runtime", action="store_true", help="Offline native-library check; does not open user data")
    args = parser.parse_args(argv)
    if sys.platform != "win32":
        parser.error("This entry point is for Windows only")
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    listener = None
    try:
        launch_id = None
        from windows_runtime import apply_build_info
        apply_build_info()
        if args.check_runtime:
            from windows_runtime_check import check_runtime
            print(json.dumps(check_runtime()), flush=True)
            return 0
        if args.managed:
            if not args.desktop:
                raise RuntimeError("managed_launch_invalid")
            from windows_managed import read_launch
            launch_id = read_launch(sys.stdin)
        listener = reserve_listener(args.port)
        if not (FRONTEND_DIST / "index.html").is_file():
            raise RuntimeError("frontend_build_missing")
        from windows_connection import load_windows_connection
        connection, profile, _ = asyncio.run(load_windows_connection(
            environment=args.environment or not args.managed, recovery=args.connection_recovery, managed=args.managed))
        if profile == "environment":
            profile = "environment-" + secrets.token_hex(32)
        from storage import configure_windows_storage
        configure_windows_storage(profile)
        # Configure paths before imports bind DB_PATH; Docker continues to import main directly.
        from main import app
        host = LocalHost(app, port=args.port, connection=connection)
        config = uvicorn.Config(host, host="127.0.0.1", port=args.port, workers=1,
                                proxy_headers=False, access_log=False, log_config=None)
        server = LocalServer(config, host, open_browser=not (args.no_browser or args.desktop),
                             desktop=args.desktop, launch_id=launch_id)
        server.run(sockets=[listener])
        if not server.started:
            raise RuntimeError("local_startup_failed")
        local_log("server.stopped")
        return 0
    except KeyboardInterrupt:
        # Uvicorn replays SIGINT only after its graceful shutdown has completed.
        local_log("server.stopped")
        return 0
    except Exception as error:
        from storage import StorageInitializationError
        known = {"frontend_build_missing", "local_port_unavailable", "local_startup_failed",
                 "windows_storage_configuration_too_late", "desktop_handoff_failed", "managed_launch_invalid",
                 "backend_build_info_invalid"}
        code = error.code if isinstance(error, StorageInitializationError) else \
            str(error) if isinstance(error, RuntimeError) and str(error) in known else "local_startup_failed"
        local_log("server.failed", level="error", errorCode=code)
        print(f"GenzoRoom Windows PoC failed: {code}", file=sys.stderr)
        if args.managed:
            from windows_managed import emit
            emit("startup_failed", error_code=code)
        return 1
    finally:
        if listener is not None:
            listener.close()


if __name__ == "__main__":
    raise SystemExit(main())
