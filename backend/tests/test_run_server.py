import asyncio
from uuid import uuid4

import pytest

import edit_store
import run_server
import storage
from connection_identity import ConnectionIdentityError, normalize_url, profile_id
from edit_store import StoreUnavailable


def test_docker_without_connection_serves_no_persistent_profile():
    assert run_server.configure_docker_storage("", "") is None
    assert not storage.profile_configured()
    existed = storage.DB_PATH.exists()
    with pytest.raises(StoreUnavailable):
        with edit_store._connection():
            pass
    assert storage.DB_PATH.exists() is existed


def test_docker_profile_is_shared_identity_not_api_key(monkeypatch):
    user = str(uuid4())

    async def identify(url, key):
        assert key in {"first-key", "rotated-key"}
        return normalize_url(url), user

    monkeypatch.setattr(run_server, "identify", identify)
    first = run_server.configure_docker_storage("https://IMMICH.invalid:443/api", "first-key")
    second = run_server.configure_docker_storage("https://immich.invalid", "rotated-key")
    assert first == second == profile_id("https://immich.invalid", user)

    other_user = str(uuid4())

    async def identify_other_user(url, key):
        return url, other_user

    monkeypatch.setattr(run_server, "identify", identify_other_user)
    assert run_server.configure_docker_storage("https://immich.invalid", "rotated-key") \
        == profile_id("https://immich.invalid", other_user)


def test_docker_connection_failure_does_not_select_storage(monkeypatch):
    storage.clear_profile(storage.DEPLOYMENT_ROOT)

    async def failed_identity(_url, _key):
        raise ConnectionIdentityError("unreachable")

    monkeypatch.setattr(run_server, "identify", failed_identity)
    with pytest.raises(RuntimeError, match="immich_unreachable"):
        run_server.configure_docker_storage("https://immich.invalid", "valid-looking-key")
    assert not storage.profile_configured()
