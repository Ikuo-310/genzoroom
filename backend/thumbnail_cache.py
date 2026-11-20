"""Atomic, bounded thumbnail storage, independent of image generation."""

import os
import re
from collections import OrderedDict
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock
from uuid import UUID, uuid4

from backend_logging import backend_logger
import storage

THUMBNAIL_CACHE_ROOT = storage.STORAGE_ROOT / "cache" / "thumbnails"
MAX_CACHE_BYTES = 1_073_741_824
CACHE_HEADER_PREFIX = b"GENZOROOM-THUMBNAIL-V1 "
CACHE_HEADER_SIZE = len(CACHE_HEADER_PREFIX) + 32 + 1
PUBLICATION_VERSION_PATTERN = re.compile(rb"[0-9a-f]{32}")


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

    @staticmethod
    def _read_publication_version(image) -> str | None:
        if image.read(len(CACHE_HEADER_PREFIX)) != CACHE_HEADER_PREFIX:
            return None
        version = image.read(32)
        if len(version) != 32 or PUBLICATION_VERSION_PATTERN.fullmatch(version) is None or image.read(1) != b"\n":
            return None
        return version.decode("ascii")

    def initialize(self):
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            # Only our temporary-file namespace is disposable after a process interruption.
            for path in self.root.glob("thumbnail-*.tmp"):
                path.unlink(missing_ok=True)
            # Cache contents are derived data; old raw-JPEG entries have no durable publication identity.
            for path in self.root.glob("*.jpg"):
                try:
                    UUID(path.stem)
                    with path.open("rb") as image:
                        version = self._read_publication_version(image)
                        has_content = bool(image.read(1))
                    if version is None or not has_content:
                        path.unlink(missing_ok=True)
                except ValueError:
                    continue
                except OSError:
                    thumbnail_log("initialize.entryCleanupFailed", level="warn", errorCode="cache_cleanup_failed")
            # A fence is needed only while an old JPEG still exists after failed deletion.
            for marker in self.root.glob("*.reset"):
                try:
                    asset_id = UUID(marker.stem)
                    try:
                        self._path(asset_id).stat()
                    except FileNotFoundError:
                        marker.unlink(missing_ok=True)
                    except OSError:
                        continue
                except (OSError, ValueError):
                    thumbnail_log("initialize.markerCleanupFailed", level="warn", errorCode="cache_cleanup_failed")
            return self._prune()

    def read(self, asset_id: UUID) -> bytes | None:
        with self._lock:
            try:
                if self._is_invalidated(asset_id):
                    return None
                with self._path(asset_id).open("rb") as image:
                    if self._read_publication_version(image) is None:
                        return None
                    content = image.read()
                    return content or None
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
                    version = self._read_publication_version(image)
                    if version is None:
                        return None
                    content = image.read()
                    self._read_failures.pop(asset_id, None)
                    return (content, version) if content else None
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
                    version = self._read_publication_version(image)
                    if version is None or not image.read(1):
                        return None
                    self._read_failures.pop(asset_id, None)
                    return version
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
                self._path(asset_id).stat()
            except FileNotFoundError:
                return False
            if not self._is_invalidated(asset_id):
                # Fence the old JPEG before attempting physical removal. Keep the fence
                # while deletion fails, including across process restarts.
                with self._reset_marker(asset_id).open("x", encoding="ascii") as marker:
                    marker.flush()
                    os.fsync(marker.fileno())
            return True

    def delete(self, asset_id: UUID):
        with self._lock:
            existed = self.fence_reset(asset_id)
            self._path(asset_id).unlink(missing_ok=True)
            self._reset_marker(asset_id).unlink(missing_ok=True)
            self._read_failures.pop(asset_id, None)
            thumbnail_log("deleted", level="info", assetId=str(asset_id))
            return existed

    def prepare_store(self, content: bytes) -> Path:
        temporary = None
        try:
            if not content or len(content) + CACHE_HEADER_SIZE > MAX_CACHE_BYTES:
                raise ValueError("cache_entry_size_limit")
            with self._lock:
                self.root.mkdir(parents=True, exist_ok=True)
                output = NamedTemporaryFile(dir=self.root, prefix="thumbnail-", suffix=".tmp", delete=False)
                temporary = Path(output.name)
            with output:
                output.write(CACHE_HEADER_PREFIX + uuid4().hex.encode("ascii") + b"\n")
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            return temporary
        except (OSError, ValueError):
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    thumbnail_log("temporaryCleanup.failed", level="warn", errorCode="cache_cleanup_failed")
            thumbnail_log("write.failed", level="warn", errorCode="cache_write_failed")
            raise

    def publish_prepared(self, asset_id: UUID, temporary: Path, payload_bytes: int) -> str:
        with self._lock:
            try:
                with temporary.open("rb") as image:
                    version = self._read_publication_version(image)
                    if version is None or not image.read(1):
                        raise OSError("thumbnail_publication_identity_invalid")
                os.replace(temporary, self._path(asset_id))
                self._reset_marker(asset_id).unlink(missing_ok=True)
                self._read_failures.pop(asset_id, None)
                thumbnail_log("updated", level="info", assetId=str(asset_id), payloadBytes=payload_bytes)
                return version
            except (OSError, ValueError):
                thumbnail_log("write.failed", level="warn", assetId=str(asset_id), errorCode="cache_write_failed")
                raise

    def discard_prepared(self, temporary: Path):
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            thumbnail_log("temporaryCleanup.failed", level="warn", errorCode="cache_cleanup_failed")

    def prune(self):
        with self._lock:
            return self._prune()

    def store(self, asset_id: UUID, content: bytes):
        temporary = self.prepare_store(content)
        try:
            with self._lock:
                self.publish_prepared(asset_id, temporary, len(content))
                try:
                    return self._prune()
                except OSError:
                    # Publication already succeeded; report cleanup separately from write failure.
                    thumbnail_log("prune.failed", level="warn", errorCode="cache_prune_failed")
        finally:
            self.discard_prepared(temporary)

    def store_with_version(self, asset_id: UUID, content: bytes) -> tuple[list[UUID], str | None]:
        # Keep the new file stable until its identity is captured for the publication event.
        with self._lock:
            evicted = self.store(asset_id, content)
            return evicted or [], self.version(asset_id)

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
            try:
                self._reset_marker(UUID(asset_id)).unlink(missing_ok=True)
            except OSError:
                thumbnail_log("prune.markerCleanupFailed", level="warn", assetId=asset_id)
            total -= size
            evicted.append(UUID(asset_id))
            thumbnail_log("evicted", level="info", assetId=asset_id, payloadBytes=size,
                          remainingBytes=total)
        return evicted
