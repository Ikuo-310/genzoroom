"""Read-only Immich RAW acquisition into a bounded, privately owned local cache."""

import asyncio
import os
import shutil
import threading
import uuid

import httpx

from immich import (IMMICH_TIMEOUT, RAW_FORMATS, ImmichOriginal, ImmichRequestError,
                    _immich_request, _require_configuration, _request_error, get_asset_detail)
from lightcraft_mcp import LightCraftError
from lightcraft_runtime import _bounded_temp_io, _trusted_temp_root

MAX_RAW_BYTES = 512 * 1024 * 1024
MAX_CACHE_BYTES = 1024 * 1024 * 1024
MIN_FREE_BYTES = 1024 * 1024 * 1024
DOWNLOAD_SECONDS = 120
IO_SECONDS = 5


async def get_raw_original(asset_id, *, transport=None):
    url, key = _require_configuration(os.getenv("IMMICH_URL"), os.getenv("IMMICH_API_KEY"))
    detail = await get_asset_detail(url, key, asset_id, transport=transport)
    if str(detail.id) != str(asset_id) or not detail.is_raw or detail.format not in RAW_FORMATS:
        raise LightCraftError("raw_unsupported_source")
    client = httpx.AsyncClient(timeout=IMMICH_TIMEOUT, follow_redirects=False, trust_env=False, transport=transport)
    response = None
    try:
        response = await _immich_request(client, "GET", url, f"/assets/{asset_id}/original", stream=True,
                                         headers={"x-api-key": key, "Accept": "application/octet-stream,image/*"})
        if response.status_code != 200:
            raise _request_error(response)
        # A successful HTML/JSON error page must never become a cached source file.
        mime = response.headers.get("content-type", "").split(";")[0].strip().lower()
        if mime != "application/octet-stream" and not mime.startswith("image/"):
            raise LightCraftError("raw_unsupported_source")
        return ImmichOriginal(response, client), detail.format.lower()
    except BaseException:
        if response is not None:
            await response.aclose()
        await client.aclose()
        raise


class RawSourceCache:
    def __init__(self, *, root=None, acquire=get_raw_original):
        self._base = root
        self._acquire = acquire
        self._lock = threading.Lock()
        self.directory = None
        self._parent = None
        self._bytes = 0
        self._owned = False
        self._download = None

    def stop_download(self):
        if self._download is not None and not self._download.done():
            self._download.cancel()

    async def _io(self, function, *args):
        return await _bounded_temp_io(function, *args, timeout=IO_SECONDS)

    def _create(self):
        with self._lock:
            base = _trusted_temp_root(self._base)
            self._parent = base
            self.directory = base / f"genzoroom-raw-source-{uuid.uuid4().hex}"
            self.directory.mkdir(mode=0o700)
            self._owned = True

    def _write(self, path, data):
        with self._lock:
            if self._bytes + len(data) > MAX_CACHE_BYTES:
                raise LightCraftError("raw_cache_capacity")
            if shutil.disk_usage(self.directory).free < MIN_FREE_BYTES + len(data):
                raise LightCraftError("raw_disk_capacity")
            with path.open("ab") as output:
                output.write(data)
            self._bytes += len(data)

    def _finish(self, partial, complete):
        with self._lock:
            partial.replace(complete)

    async def download(self, asset_id):
        self._download = asyncio.create_task(self._download_file(asset_id), name="raw-source-download")
        try:
            return await asyncio.shield(self._download)
        except asyncio.CancelledError:
            if self._download.cancelled():
                raise LightCraftError("raw_download_cancelled") from None
            raise

    async def _download_file(self, asset_id):
        original = None
        try:
            async with asyncio.timeout(DOWNLOAD_SECONDS):
                if self.directory is None:
                    await self._io(self._create)
                original, extension = await self._acquire(asset_id)
                if extension.upper() not in RAW_FORMATS:
                    raise LightCraftError("raw_unsupported_source")
                length = original.response.headers.get("content-length")
                if length is not None and (not length.isascii() or not length.isdecimal() or int(length) > MAX_RAW_BYTES):
                    raise LightCraftError("raw_source_too_large")
                name = uuid.uuid4().hex
                partial = self.directory / f"{name}.part"
                complete = self.directory / f"{name}.{extension}"
                total = 0
                async for chunk in original.chunks():
                    total += len(chunk)
                    if total > MAX_RAW_BYTES:
                        raise LightCraftError("raw_source_too_large")
                    await self._io(self._write, partial, chunk)
                if not total or length is not None and total != int(length):
                    raise LightCraftError("raw_source_incomplete")
                await self._io(self._finish, partial, complete)
                return complete
        except TimeoutError:
            raise LightCraftError("raw_download_timeout") from None
        except (ImmichRequestError, httpx.HTTPError):
            raise LightCraftError("raw_download_failed") from None
        finally:
            if original is not None:
                await original.close()

    def _remove(self):
        with self._lock:
            path = self.directory
            if path is None:
                return
            if not self._owned:
                self.directory = None
                return
            # Retain ownership on I/O timeout; a subsequent cleanup uses the same lock.
            if path.parent != self._parent or not path.name.startswith("genzoroom-raw-source-") \
                    or path.is_symlink() or path.resolve() != path:
                raise LightCraftError("raw_cache_cleanup_failed")
            if path.exists():
                shutil.rmtree(path)
            self.directory = None
            self._bytes = 0
            self._owned = False

    async def close(self):
        await self._io(self._remove)
