"""Windows-only connection settings, isolated profiles and authenticated connection checks."""
import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
from uuid import UUID
from starlette.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from windows_credentials import ConnectionSettingsError, CredentialVault
from backend_logging import backend_logger
from connection_identity import ConnectionIdentityError, identify as identify_connection, normalize_url as canonical_url, profile_id


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
        return canonical_url(value)
    except ConnectionIdentityError as error:
        raise ConnectionSettingsError(error.code) from None


async def identify(url, key, *, transport=None):
    try:
        return await identify_connection(url, key, transport=transport)
    except ConnectionIdentityError as error:
        raise ConnectionSettingsError(error.code) from None


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
        profile = profile_id(url, user_id)
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
        url, key = os.environ.get("IMMICH_URL", ""), os.environ.get("IMMICH_API_KEY", "")
        os.environ.pop("IMMICH_URL", None)
        os.environ.pop("IMMICH_API_KEY", None)
        if url.strip() and key.strip():
            try:
                active_url, user_id = await identify(url, key)
                os.environ["IMMICH_URL"] = active_url
                os.environ["IMMICH_API_KEY"] = key
                return WindowsConnection(store, source="environment", managed=managed), profile_id(active_url, user_id), None
            except ConnectionSettingsError as error:
                connection_log("startup.recovery", error=str(error))
                return WindowsConnection(store, source="environment", error=str(error), managed=managed), None, str(error)
        return WindowsConnection(store, source="environment", error="not_configured", managed=managed), None, "not_configured"
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
                active_url, identity = await identify(selected["url"], key)
                if identity != selected["userId"]:
                    raise ConnectionSettingsError("identity_changed")
                os.environ["IMMICH_URL"], os.environ["IMMICH_API_KEY"] = active_url, key
    except ConnectionSettingsError as failure:
        selected = None
        error = str(failure)
        connection_log("startup.recovery", error=error)
    connection = WindowsConnection(store, source="recovery" if error else "saved", active=selected, error=error, managed=managed)
    return connection, profile_id(selected["url"], selected["userId"]) if selected else None, error
