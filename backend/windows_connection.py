"""Windows-only connection settings, isolated profiles and authenticated connection checks."""
import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import tempfile
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx
from starlette.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from windows_credentials import ConnectionSettingsError, CredentialVault
from backend_logging import backend_logger


def connection_log(event, *, method=None, error=None):
    try:
        context = {"method": method} if method else {}
        if error:
            context["errorCode"] = error
        backend_logger.add(level="error" if error else "info", component="windows_connection", event=event, context=context)
    except Exception:
        pass


def user_root():
    from windows_runtime import data_root
    try:
        return data_root()
    except ValueError:
        raise ConnectionSettingsError("settings_location_invalid")


def normalize_url(value):
    try:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value.strip()):
            raise ValueError()
        url = urlsplit(value.strip())
        if url.scheme not in ("http", "https") or not url.hostname or url.username is not None \
                or url.password is not None or url.query or url.fragment or "\\" in value:
            raise ValueError()
        host = url.hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = "[" + host + "]"
        port = url.port
        if port == 0:
            raise ValueError()
        authority = host + (f":{port}" if port and port != (80 if url.scheme == "http" else 443) else "")
        path = url.path.rstrip("/")
        if path.endswith("/api"):
            path = path[:-4]
        if any(segment in (".", "..") for segment in path.split("/")) or "%" in path:
            raise ValueError()
        return urlunsplit((url.scheme, authority, path, "", ""))
    except (ValueError, UnicodeError, AttributeError):
        raise ConnectionSettingsError("url_invalid") from None


async def identify(url, key, *, transport=None):
    url = normalize_url(url)
    if not isinstance(key, str) or not key.strip() or len(key.encode("utf-8")) > 2560 \
            or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise ConnectionSettingsError("key_invalid")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=3), follow_redirects=False,
                                     trust_env=False, transport=transport) as client:
            response = await client.get(url + "/api/users/me", headers={"x-api-key": key, "Accept": "application/json"})
        if response.status_code in (401, 403):
            raise ConnectionSettingsError("authentication_failed" if response.status_code == 401 else "permission_denied")
        if response.status_code != 200:
            raise ConnectionSettingsError("unexpected_response")
        identity = str(UUID(response.json()["id"]))
        return url, identity
    except httpx.TimeoutException:
        raise ConnectionSettingsError("connection_timeout") from None
    except httpx.RequestError as error:
        cause = error
        while cause is not None:
            if isinstance(cause, ssl.SSLCertVerificationError):
                raise ConnectionSettingsError("tls_certificate_error") from None
            cause = cause.__cause__
        raise ConnectionSettingsError("unreachable") from None
    except (ValueError, KeyError, TypeError):
        raise ConnectionSettingsError("identity_unavailable") from None


class ConnectionStore:
    def __init__(self, root=None, vault=None):
        self.root = root if root is not None else user_root()
        self.path = self.root / "connection.json"
        self.vault = vault if vault is not None else CredentialVault()

    def read(self):
        try:
            if not self.path.exists():
                return {"version": 1, "selected": None, "cleanup": []}
            if self.path.stat().st_size > 32768:
                raise ValueError()
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if set(data) != {"version", "selected", "cleanup"} or data["version"] != 1:
                raise ValueError()
            selected = data["selected"]
            if selected is not None:
                if set(selected) != {"url", "userId", "profile", "credential"} \
                        or normalize_url(selected["url"]) != selected["url"] \
                        or str(UUID(selected["userId"])) != selected["userId"]:
                    raise ValueError()
                for name in ("profile", "credential"):
                    if not re.fullmatch(r"[0-9a-f]{64}", selected[name]):
                        raise ValueError()
            if not isinstance(data["cleanup"], list) or len(data["cleanup"]) > 100 \
                    or any(not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v) for v in data["cleanup"]) \
                    or (selected and selected["credential"] in data["cleanup"]):
                raise ValueError()
            return data
        except (OSError, ValueError, TypeError, KeyError, ConnectionSettingsError):
            raise ConnectionSettingsError("settings_read_failed") from None

    def write(self, data):
        temporary = None
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=self.root, prefix="connection-", suffix=".tmp", delete=False) as output:
                temporary = Path(output.name)
                output.write(json.dumps(data, separators=(",", ":")).encode())
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise ConnectionSettingsError("settings_write_failed") from None
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    # This non-secret temporary file must not hide the atomic-publication error.
                    pass

    def cleanup(self, data):
        # Journal identifiers before vault mutation so interruption never loses cleanup ownership.
        for identifier in list(data["cleanup"]):
            self.vault.delete(identifier)
            data["cleanup"].remove(identifier)
            self.write(data)

    def save(self, url, user_id, key):
        data = self.read()
        self.cleanup(data)
        old = data["selected"]
        same_identity = old is not None and old["url"] == url and old["userId"] == user_id
        if same_identity:
            old_key = self.vault.get(old["credential"])
            if old_key is not None and secrets.compare_digest(old_key, key):
                return old

        identifier = secrets.token_hex(32)
        data["cleanup"].append(identifier)
        self.write(data)
        self.vault.put(identifier, key)
        profile = old["profile"] if same_identity else secrets.token_hex(32)
        data["selected"] = {"url": url, "userId": user_id, "profile": profile, "credential": identifier}
        data["cleanup"].remove(identifier)
        if old:
            data["cleanup"].append(old["credential"])
        self.write(data)
        self.cleanup(data)
        return data["selected"]

    def delete(self):
        data = self.read()
        if data["selected"]:
            data["cleanup"].append(data["selected"]["credential"])
            data["selected"] = None
            self.write(data)
        self.cleanup(data)


class WindowsConnection:
    def __init__(self, store, *, source="saved", active=None, error=None, managed=False):
        self.store, self.source, self.active, self.error, self.managed = store, source, active, error, managed
        self.lock = asyncio.Lock()

    async def key_for(self, payload):
        url = normalize_url(payload.get("url"))
        key = payload.get("apiKey")
        if key == "" or key is None:
            selected = await run_in_threadpool(self.store.read)
            selected = selected["selected"]
            if not selected or url != selected["url"]:
                raise ConnectionSettingsError("key_required")
            key = await run_in_threadpool(self.store.vault.get, selected["credential"])
            if key is None:
                raise ConnectionSettingsError("credential_read_failed")
        return url, key

    def metadata(self):
        if self.source == "environment":
            try:
                active_url = normalize_url(os.environ.get("IMMICH_URL", ""))
            except ConnectionSettingsError:
                active_url = ""
            return {"url": active_url, "keyConfigured": bool(os.environ.get("IMMICH_API_KEY")),
                    "source": self.source, "error": self.error, "managed": self.managed,
                    "pendingRestart": False, "cleanupPending": False}
        data = self.store.read()
        selected = data["selected"]
        return {"url": selected["url"] if selected else "", "keyConfigured": selected is not None,
                "source": self.source, "error": self.error, "managed": self.managed,
                "pendingRestart": selected != self.active, "cleanupPending": bool(data["cleanup"])}

    async def endpoint(self, request):
        try:
            async with self.lock:
                if request.method == "GET":
                    return JSONResponse(await run_in_threadpool(self.metadata))
                if request.headers.getlist("origin") != [f"http://{request.headers.get('host')}"]:
                    raise ConnectionSettingsError("request_invalid")
                if not self.managed or self.source == "environment":
                    raise ConnectionSettingsError("managed_mode_required")
                if request.method == "DELETE":
                    await run_in_threadpool(self.store.delete)
                    connection_log("settings.removed", method="DELETE")
                    return JSONResponse(await run_in_threadpool(self.metadata))
                if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                    raise ConnectionSettingsError("request_invalid")
                content = bytearray()
                async for chunk in request.stream():
                    content.extend(chunk)
                    if len(content) > 8192:
                        raise ConnectionSettingsError("request_invalid")
                payload = json.loads(content)
                if not isinstance(payload, dict) or set(payload) - {"url", "apiKey"}:
                    raise ConnectionSettingsError("request_invalid")
                url, key = await self.key_for(payload)
                url, user_id = await identify(url, key)
                if request.method == "PUT":
                    await run_in_threadpool(self.store.save, url, user_id, key)
                connection_log("settings.saved" if request.method == "PUT" else "connection.tested", method=request.method)
                return JSONResponse({**await run_in_threadpool(self.metadata), "tested": "user.read"})
        except ConnectionSettingsError as error:
            connection_log("operation.failed", method=request.method, error=str(error))
            return JSONResponse({"error": str(error)}, status_code=400)
        except (ValueError, TypeError, UnicodeError):
            return JSONResponse({"error": "request_invalid"}, status_code=400)


async def load_windows_connection(*, environment=False, recovery=False, managed=False, store=None):
    store = store if store is not None else ConnectionStore()
    if environment:
        # Diagnostic environment mode never shares either legacy or saved-profile data.
        return WindowsConnection(store, source="environment", managed=managed), "environment", None
    os.environ.pop("IMMICH_URL", None)
    os.environ.pop("IMMICH_API_KEY", None)
    selected = None
    error = "restart_failed" if recovery else None
    try:
        if not recovery:
            selected = store.read()["selected"]
            if selected:
                key = store.vault.get(selected["credential"])
                if key is None:
                    raise ConnectionSettingsError("credential_read_failed")
                _, identity = await identify(selected["url"], key)
                if identity != selected["userId"]:
                    raise ConnectionSettingsError("identity_changed")
                os.environ["IMMICH_URL"], os.environ["IMMICH_API_KEY"] = selected["url"], key
    except ConnectionSettingsError as failure:
        selected = None
        error = str(failure)
        connection_log("startup.recovery", error=error)
    connection = WindowsConnection(store, source="recovery" if error else "saved", active=selected, error=error, managed=managed)
    return connection, selected["profile"] if selected else "unconfigured", error
