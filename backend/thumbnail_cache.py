"""Atomic, bounded thumbnail storage, independent of image generation."""

import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock
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

    def _path(self, asset_id: UUID) -> Path:
        return self.root / f"{asset_id}.jpg"

    def initialize(self):
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            # Only our temporary-file namespace is disposable after a process interruption.
            for path in self.root.glob("thumbnail-*.tmp"):
                path.unlink(missing_ok=True)
            self._prune()

    def read(self, asset_id: UUID) -> bytes | None:
        with self._lock:
            try:
                return self._path(asset_id).read_bytes()
            except FileNotFoundError:
                return None
            except OSError:
                thumbnail_log("read.failed", level="warn", assetId=str(asset_id), errorCode="cache_read_failed")
                return None

    def delete(self, asset_id: UUID):
        with self._lock:
            self._path(asset_id).unlink(missing_ok=True)
            thumbnail_log("deleted", level="info", assetId=str(asset_id))

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
                # The file's mtime records generation; reads never refresh it.
                os.replace(temporary, self._path(asset_id))
                thumbnail_log("updated", level="info", assetId=str(asset_id), payloadBytes=len(content))
                try:
                    self._prune()
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
            metadata = path.stat()
            entries.append((metadata.st_mtime_ns, str(asset_id), path, metadata.st_size))
        total = sum(entry[3] for entry in entries)
        for _, asset_id, path, size in sorted(entries):
            if total <= MAX_CACHE_BYTES:
                break
            path.unlink()
            total -= size
            thumbnail_log("evicted", level="info", assetId=asset_id, payloadBytes=size,
                          remainingBytes=total)
