import asyncio
import json
import os
from pathlib import Path
import secrets
import ssl
import sys
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest

from windows_connection import ConnectionStore, WindowsConnection, identify, load_windows_connection, normalize_url
from windows_credentials import ConnectionSettingsError, CredentialVault
from tests.test_windows_local import local, client, authenticate


class Vault:
    def __init__(self):
        self.values = {}
        self.fail_delete = False
        self.fail_put = False

    def get(self, identifier):
        return self.values.get(identifier)

    def put(self, identifier, key):
        if self.fail_put:
            raise ConnectionSettingsError("credential_write_failed")
        self.values[identifier] = key

    def delete(self, identifier):
        if self.fail_delete:
            raise ConnectionSettingsError("credential_delete_failed")
        self.values.pop(identifier, None)


@pytest.fixture
def settings(tmp_path):
    return ConnectionStore(tmp_path, Vault())


@pytest.mark.parametrize("value,expected", [
    (" HTTP://LOCALHOST:80/api/ ", "http://localhost"),
    ("https://Example.com:443/photos/api/", "https://example.com/photos"),
    ("http://[::1]:2283/api", "http://[::1]:2283"),
])
def test_url_normalization(value, expected):
    assert normalize_url(value) == expected


@pytest.mark.parametrize("value", ["file:///a", "https://a?secret=x", "http://u:p@a", "https://a/#x", "http://a/../b", "http://a/%2e", "http://a:0", "http://", None])
def test_url_rejection(value):
    with pytest.raises(ConnectionSettingsError, match="url_invalid"):
        normalize_url(value)


def test_authenticated_identity_and_no_persistence_during_test(settings):
    key, user = secrets.token_urlsafe(32), str(uuid4())
    def handler(request):
        assert request.url.path == "/api/users/me"
        assert secrets.compare_digest(request.headers["x-api-key"], key)
        return httpx.Response(200, json={"id": user})
    assert asyncio.run(identify("http://immich.invalid/api", key, transport=httpx.MockTransport(handler))) == ("http://immich.invalid", user)
    assert not settings.path.exists() and not settings.vault.values


@pytest.mark.parametrize("status,code", [(401, "authentication_failed"), (403, "permission_denied"), (302, "unexpected_response"), (500, "unexpected_response")])
def test_authentication_and_redirect_errors(status, code):
    with pytest.raises(ConnectionSettingsError, match=code):
        asyncio.run(identify("https://immich.invalid", secrets.token_urlsafe(32),
                             transport=httpx.MockTransport(lambda _: httpx.Response(status))))


@pytest.mark.parametrize("kind,code", [("timeout", "connection_timeout"), ("tls", "tls_certificate_error"), ("network", "unreachable"), ("identity", "identity_unavailable")])
def test_connection_failure_classification(kind, code):
    def handler(request):
        if kind == "timeout":
            raise httpx.ConnectTimeout("private detail", request=request)
        if kind == "network":
            raise httpx.ConnectError("private detail", request=request)
        if kind == "tls":
            raise httpx.ConnectError("private detail", request=request) from ssl.SSLCertVerificationError()
        return httpx.Response(200, json={})
    with pytest.raises(ConnectionSettingsError, match=code):
        asyncio.run(identify("https://immich.invalid", secrets.token_urlsafe(32), transport=httpx.MockTransport(handler)))


def test_same_connection_and_key_resave_preserves_selection_without_pending_cleanup(settings):
    key, user = secrets.token_urlsafe(32), str(uuid4())
    first = settings.save("http://first.invalid", user, key)
    assert settings.save("http://first.invalid", user, key) == first
    assert len(settings.vault.values) == 1
    assert settings.read()["cleanup"] == []
    assert not WindowsConnection(settings, active=first, managed=True).metadata()["pendingRestart"]


def test_key_update_preserves_profile_and_new_credential(settings):
    user, old_key, new_key = str(uuid4()), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    first = settings.save("http://first.invalid", user, old_key)
    updated = settings.save("http://first.invalid", user, new_key)
    assert updated["profile"] == first["profile"]
    assert updated["credential"] != first["credential"]
    assert settings.vault.get(updated["credential"]) == new_key
    assert first["credential"] not in settings.vault.values
    assert settings.read()["cleanup"] == []


@pytest.mark.parametrize("url,user_change", [("http://first.invalid", True), ("http://second.invalid", False)])
def test_different_url_or_authenticated_user_gets_new_profile(settings, url, user_change):
    user, key = str(uuid4()), secrets.token_urlsafe(32)
    first = settings.save("http://first.invalid", user, key)
    updated = settings.save(url, str(uuid4()) if user_change else user, key)
    assert updated["profile"] != first["profile"]


def test_failed_key_update_keeps_existing_selection_and_secret(settings):
    user, old_key, new_key = str(uuid4()), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    old = settings.save("http://first.invalid", user, old_key)
    settings.vault.fail_put = True
    with pytest.raises(ConnectionSettingsError, match="credential_write_failed"):
        settings.save("http://first.invalid", user, new_key)
    assert settings.read()["selected"] == old
    assert settings.vault.get(old["credential"]) == old_key
    assert settings.read()["cleanup"]


def test_profile_files_survive_key_update_restart_and_connection_deletion(settings, monkeypatch):
    user, key = str(uuid4()), secrets.token_urlsafe(32)
    first = settings.save("http://first.invalid", user, key)
    profile_root = settings.root / "profiles" / first["profile"]
    db = profile_root / "data" / "genzoroom.db"
    thumbnail = profile_root / "cache" / "thumbnails" / "asset.jpg"
    db.parent.mkdir(parents=True); thumbnail.parent.mkdir(parents=True)
    db.write_bytes(b"recipe-history-queue")
    thumbnail.write_bytes(b"thumbnail-cache")

    new_key = secrets.token_urlsafe(32)
    updated = settings.save("http://first.invalid", user, new_key)
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    async def identify_same(url, secret):
        return url, user
    with patch("windows_connection.identify", identify_same):
        _, restarted_profile, error = asyncio.run(load_windows_connection(store=ConnectionStore(settings.root, settings.vault), managed=True))
    assert updated["profile"] == first["profile"] == restarted_profile
    assert error is None and os.environ["IMMICH_API_KEY"] == new_key
    assert db.read_bytes() == b"recipe-history-queue"
    assert thumbnail.read_bytes() == b"thumbnail-cache"

    settings.delete()
    assert settings.read()["selected"] is None
    assert db.read_bytes() == b"recipe-history-queue"
    assert thumbnail.read_bytes() == b"thumbnail-cache"


def test_failed_publication_keeps_old_selection_and_journals_new_credential(settings):
    old = settings.save("http://first.invalid", str(uuid4()), secrets.token_urlsafe(32))
    real_write = settings.write
    calls = 0
    def failing(data):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ConnectionSettingsError("settings_write_failed")
        real_write(data)
    with patch.object(settings, "write", failing), pytest.raises(ConnectionSettingsError):
        settings.save("http://second.invalid", str(uuid4()), secrets.token_urlsafe(32))
    assert settings.read()["selected"] == old
    assert len(settings.read()["cleanup"]) == 1
    settings.cleanup(settings.read())
    assert list(settings.vault.values) == [old["credential"]]


def test_cleanup_failure_is_durable_and_retryable(settings):
    settings.save("http://first.invalid", str(uuid4()), secrets.token_urlsafe(32))
    settings.vault.fail_delete = True
    with pytest.raises(ConnectionSettingsError, match="credential_delete_failed"):
        settings.delete()
    assert settings.read()["selected"] is None and settings.read()["cleanup"]
    settings.vault.fail_delete = False
    settings.delete()
    assert not settings.read()["cleanup"] and not settings.vault.values


def test_saved_source_overrides_environment_and_checks_user_before_profile_open(settings, monkeypatch):
    entry = settings.save("http://saved.invalid", str(uuid4()), secrets.token_urlsafe(32))
    monkeypatch.setenv("IMMICH_URL", "http://unintended.invalid")
    monkeypatch.setenv("IMMICH_API_KEY", secrets.token_urlsafe(32))
    async def identity(url, key):
        return url, entry["userId"]
    with patch("windows_connection.identify", identity):
        connection, profile, error = asyncio.run(load_windows_connection(store=settings, managed=True))
    assert profile == entry["profile"] and error is None
    assert os.environ["IMMICH_URL"] == entry["url"]
    assert connection.metadata()["source"] == "saved"
    assert "apiKey" not in connection.metadata()
    async def other(url, key):
        return url, str(uuid4())
    with patch("windows_connection.identify", other):
        connection, profile, error = asyncio.run(load_windows_connection(store=settings, managed=True))
    assert profile == "unconfigured" and error == "identity_changed"
    assert "IMMICH_API_KEY" not in os.environ and "IMMICH_URL" not in os.environ
    assert settings.read()["selected"] == entry


def test_recovery_never_opens_selected_profile_and_retains_retry_settings(settings, monkeypatch):
    entry = settings.save("http://saved.invalid", str(uuid4()), secrets.token_urlsafe(32))
    monkeypatch.setenv("IMMICH_API_KEY", secrets.token_urlsafe(32))
    connection, profile, error = asyncio.run(load_windows_connection(store=settings, recovery=True, managed=True))
    assert profile == "unconfigured" and error == "restart_failed"
    assert connection.metadata()["pendingRestart"]
    assert settings.read()["selected"] == entry and "IMMICH_API_KEY" not in os.environ


def test_unavailable_vault_never_falls_back_to_plaintext(settings):
    key = secrets.token_urlsafe(32)
    with patch.object(settings.vault, "put", side_effect=ConnectionSettingsError("credential_unavailable")):
        with pytest.raises(ConnectionSettingsError, match="credential_unavailable"):
            settings.save("http://immich.invalid", str(uuid4()), key)
    assert key not in settings.path.read_text()
    assert settings.read()["selected"] is None
    assert settings.read()["cleanup"]


def test_missing_saved_credential_opens_unconfigured_recovery(settings, monkeypatch):
    settings.save("http://immich.invalid", str(uuid4()), secrets.token_urlsafe(32))
    settings.vault.values.clear()
    monkeypatch.setenv("IMMICH_API_KEY", secrets.token_urlsafe(32))
    _, profile, error = asyncio.run(load_windows_connection(store=settings))
    assert profile == "unconfigured" and error == "credential_read_failed"
    assert "IMMICH_API_KEY" not in os.environ


def test_connection_routes_require_session_origin_and_retest_before_save(local, settings):
    from starlette.routing import Route
    key, user = secrets.token_urlsafe(32), str(uuid4())
    connection = WindowsConnection(settings, managed=True)
    local.application.router.routes.insert(0, Route("/__local/connection", connection.endpoint, methods=["GET", "POST", "PUT", "DELETE"]))
    checks = []
    async def identity(url, secret):
        checks.append(True)
        assert secrets.compare_digest(secret, key)
        return url, user
    async def scenario():
        async with client(local) as http:
            assert (await http.get("/__local/connection")).status_code == 401
            await authenticate(http, local)
            payload = {"url": "http://immich.invalid", "apiKey": key}
            assert (await http.put("/__local/connection", json=payload)).status_code == 400
            response = await http.post("/__local/connection", json=payload, headers={"Origin": local.origin})
            assert response.status_code == 200 and not settings.path.exists()
            response = await http.put("/__local/connection", json=payload, headers={"Origin": local.origin})
            assert response.status_code == 200 and response.json()["pendingRestart"]
            assert key not in response.text
            response = await http.get("/__local/connection")
            assert response.json()["keyConfigured"] and key not in response.text
            assert "userId" not in response.text and "credential" not in response.json()
            assert (await http.delete("/__local/connection", headers={"Origin": "http://other.invalid"})).status_code == 403
    with patch("windows_connection.identify", identity):
        asyncio.run(scenario())
    assert len(checks) == 2


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Credential Manager")
def test_real_current_user_vault_roundtrip_without_fixed_fixture_key():
    vault = CredentialVault(namespace="GenzoRoom/Tests/" + secrets.token_hex(16) + "/")
    identifier, key = secrets.token_hex(32), secrets.token_urlsafe(32)
    try:
        assert vault.get(identifier) is None
        vault.put(identifier, key)
        assert secrets.compare_digest(vault.get(identifier), key)
        vault.put(identifier, key[::-1])
        assert secrets.compare_digest(vault.get(identifier), key[::-1])
    finally:
        vault.delete(identifier)
    assert vault.get(identifier) is None
