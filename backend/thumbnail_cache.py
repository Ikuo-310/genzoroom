"""Atomic, bounded thumbnail storage, independent of image generation."""

import os
from collections import OrderedDict
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock
from time import time_ns
from uuid import UUID

from backend_logging import backend_logger
import storage

THUMBNAIL_CACHE_ROOT = storage.STORAGE_ROOT / "cache" / "thumbnails"
MAX_CACHE_BYTES = 1_073_741_824


def thumbnail_log(event: str, *, level: str = "debug", component: str = "thumbnail_cache", **context):
    try:
        backend_logger.add(level=level, component=component, event=event, context=context)
    except Exception:
        # Optional diagnostics cannot affect saves, cache publication, or delivery.
        pass


class ThumbnailCache:
    def __init__(self, root: Path | None = None):
        self.root = root if root is not None else storage.STORAGE_ROOT / "cache" / "thumbnails"
        # Readers must finish copying bytes before replacement, eviction, or reset on Windows.
        self._lock = RLock()
        self._read_failures = OrderedDict()

    def _path(self, asset_id: UUID) -> Path:
        return self.root / f"{asset_id}.jpg"

    def _reset_marker(self, asset_id: UUID) -> Path:
        return self.root / f"{asset_id}.reset"

    def _is_invalidated(self, asset_id: UUID) -> bool:
        try:
            self._reset_marker(asset_id).stat()
            return True
        except FileNotFoundError:
            return False

    def initialize(self):
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            # Only our temporary-file namespace is disposable after a process interruption.
            for path in self.root.glob("thumbnail-*.tmp"):
                path.unlink(missing_ok=True)
            return self._prune()

    def read(self, asset_id: UUID) -> bytes | None:
        with self._lock:
            try:
                if self._is_invalidated(asset_id):
                    return None
                return self._path(asset_id).read_bytes()
            except FileNotFoundError:
                return None
            except OSError:
                thumbnail_log("read.failed", level="warn", assetId=str(asset_id), errorCode="cache_read_failed")
                return None

    def read_versioned(self, asset_id: UUID) -> tuple[bytes, str] | None:
        with self._lock:
            try:
                path = self._path(asset_id)
                if self._is_invalidated(asset_id):
                    return None
                with path.open("rb") as image:
                    content = image.read()
                    self._read_failures.pop(asset_id, None)
                    return (content, str(os.fstat(image.fileno()).st_mtime_ns)) if content else None
            except FileNotFoundError:
                return None
            except OSError:
                self._read_failures[asset_id] = None
                self._read_failures.move_to_end(asset_id)
                if len(self._read_failures) > 1024:
                    self._read_failures.popitem(last=False)
                thumbnail_log("read.failed", level="warn", assetId=str(asset_id), errorCode="cache_read_failed")
                return None

    def version(self, asset_id: UUID) -> str | None:
        with self._lock:
            if asset_id in self._read_failures:
                # A one-byte probe cannot detect a failure later in a previously unreadable file.
                result = self.read_versioned(asset_id)
                return result[1] if result else None
            try:
                if self._is_invalidated(asset_id):
                    return None
                with self._path(asset_id).open("rb") as image:
                    if not image.read(1):
                        return None
                    return str(os.fstat(image.fileno()).st_mtime_ns)
            except FileNotFoundError:
                return None
            except OSError:
                thumbnail_log("stat.failed", level="warn", assetId=str(asset_id), errorCode="cache_stat_failed")
                return None

    def versions(self, asset_ids: list[UUID]) -> dict[str, str | None]:
        with self._lock:
            return {str(asset_id): self.version(asset_id) for asset_id in asset_ids}

    def fence_reset(self, asset_id: UUID):
        with self._lock:
            try:
                previous_version = self._path(asset_id).stat().st_mtime_ns
            except FileNotFoundError:
                return False
            if not self._is_invalidated(asset_id):
                # Fence the old JPEG before attempting physical removal. Keep the fence
                # while deletion fails, including across process restarts.
                with self._reset_marker(asset_id).open("x", encoding="ascii") as marker:
                    marker.write(str(previous_version))
                    marker.flush()
                    os.fsync(marker.fileno())
            return True

    def delete(self, asset_id: UUID):
        with self._lock:
            existed = self.fence_reset(asset_id)
            self._path(asset_id).unlink(missing_ok=True)
            self._read_failures.pop(asset_id, None)
            thumbnail_log("deleted", level="info", assetId=str(asset_id))
            return existed

    def store(self, asset_id: UUID, content: bytes):
        temporary = None
        with self._lock:
            try:
                if not content or len(content) > MAX_CACHE_BYTES:
                    raise ValueError("cache_entry_size_limit")
                self.root.mkdir(parents=True, exist_ok=True)
                with NamedTemporaryFile(dir=self.root, prefix="thumbnail-", suffix=".tmp", delete=False) as output:
                    temporary = Path(output.name)
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                # Persisted mtime gives each atomic publication a restart-stable URL identity.
                try:
                    previous_mtime = self._path(asset_id).stat().st_mtime_ns
                except FileNotFoundError:
                    previous_mtime = 0
                try:
                    previous_mtime = max(previous_mtime, int(self._reset_marker(asset_id).read_text(encoding="ascii") or "0"))
                except FileNotFoundError:
                    pass
                # Leave room for filesystem timestamp rounding (including Windows FILETIME).
                published_mtime = max(time_ns(), previous_mtime + 1_000_000)
                os.utime(temporary, ns=(published_mtime, published_mtime))
                if temporary.stat().st_mtime_ns <= previous_mtime:
                    raise OSError("thumbnail_publication_timestamp_not_advanced")
                os.replace(temporary, self._path(asset_id))
                self._reset_marker(asset_id).unlink(missing_ok=True)
                thumbnail_log("updated", level="info", assetId=str(asset_id), payloadBytes=len(content))
                try:
                    return self._prune()
                except OSError:
                    # Publication already succeeded; report cleanup separately from write failure.
                    thumbnail_log("prune.failed", level="warn", errorCode="cache_prune_failed")
            except (OSError, ValueError):
                thumbnail_log("write.failed", level="warn", assetId=str(asset_id), errorCode="cache_write_failed")
                raise
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        thumbnail_log("temporaryCleanup.failed", level="warn", errorCode="cache_cleanup_failed")

    def _prune(self):
        entries = []
        for path in self.root.glob("*.jpg"):
            try:
                asset_id = UUID(path.stem)
            except ValueError:
                continue
            try:
                metadata = path.stat()
            except OSError:
                thumbnail_log("prune.statFailed", level="warn", assetId=str(asset_id))
                continue
            entries.append((metadata.st_mtime_ns, str(asset_id), path, metadata.st_size))
        total = sum(entry[3] for entry in entries)
        evicted = []
        for _, asset_id, path, size in sorted(entries):
            if total <= MAX_CACHE_BYTES:
                break
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                thumbnail_log("prune.deleteFailed", level="warn", assetId=asset_id)
                continue
            total -= size
            evicted.append(UUID(asset_id))
            thumbnail_log("evicted", level="info", assetId=asset_id, payloadBytes=size,
                          remainingBytes=total)
        return evicted
