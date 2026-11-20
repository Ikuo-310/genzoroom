"""Canonical Immich connection identity shared by all deployments."""

import hashlib
import json
import ssl
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx


class ConnectionIdentityError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def normalize_url(value: str) -> str:
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
        raise ConnectionIdentityError("url_invalid") from None


def profile_id(url: str, user_id: str) -> str:
    normalized_url = normalize_url(url)
    try:
        normalized_user_id = str(UUID(user_id))
    except (ValueError, TypeError, AttributeError):
        raise ConnectionIdentityError("identity_unavailable") from None
    identity = json.dumps([1, normalized_url, normalized_user_id], separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(b"GenzoRoom Immich profile\0" + identity).hexdigest()


async def identify(url: str, key: str, *, transport: httpx.AsyncBaseTransport | None = None) -> tuple[str, str]:
    url = normalize_url(url)
    if not isinstance(key, str) or not key.strip() or len(key.encode("utf-8")) > 2560 \
            or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise ConnectionIdentityError("key_invalid")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=3), follow_redirects=False,
                                     trust_env=False, transport=transport) as client:
            response = await client.get(url + "/api/users/me",
                                        headers={"x-api-key": key, "Accept": "application/json"})
        if response.status_code in (401, 403):
            raise ConnectionIdentityError("authentication_failed" if response.status_code == 401 else "permission_denied")
        if response.status_code != 200:
            raise ConnectionIdentityError("unexpected_response")
        identity = str(UUID(response.json()["id"]))
        return url, identity
    except httpx.TimeoutException:
        raise ConnectionIdentityError("connection_timeout") from None
    except httpx.RequestError as error:
        cause = error
        while cause is not None:
            if isinstance(cause, ssl.SSLCertVerificationError):
                raise ConnectionIdentityError("tls_certificate_error") from None
            cause = cause.__cause__
        raise ConnectionIdentityError("unreachable") from None
    except (ValueError, KeyError, TypeError):
        raise ConnectionIdentityError("identity_unavailable") from None
