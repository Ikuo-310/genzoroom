import os
from uuid import UUID

import pytest

import thumbnail_cache as module
from thumbnail_cache import CACHE_HEADER_PREFIX, CACHE_HEADER_SIZE, MAX_CACHE_BYTES, ThumbnailCache

A, B, C = (UUID(int=i) for i in (1, 2, 3))


def write_entry(path, content: bytes, version: str):
    path.write_bytes(CACHE_HEADER_PREFIX + version.encode("ascii") + b"\n" + content)


def test_atomic_replacement_read_and_delete(tmp_path):
    cache = ThumbnailCache(tmp_path / "thumbnails")
    cache.initialize()
    assert cache.read(A) is None


def test_publication_version_is_stable_across_restart_and_unique_on_replacement(tmp_path):
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"first")
    first = cache.version(A)
    assert first is not None and cache.read_versioned(A) == (b"first", first)

    restarted = ThumbnailCache(tmp_path)
    assert restarted.version(A) == first
    restarted.store(A, b"second")
    second = restarted.version(A)
    assert second is not None and len(second) == 32 and second != first
    assert restarted.read_versioned(A) == (b"second", second)
    os.utime(tmp_path / f"{A}.jpg", (1, 1))
    restarted.store(A, b"same after clock rollback")
    rolled_back = restarted.version(A)
    assert rolled_back not in {first, second}
    assert restarted.delete(A) is True
    assert not restarted._reset_marker(A).exists()
    assert restarted.version(A) is None
    cache.store(A, b"old")
    recreated = cache.version(A)
    cache.store(A, b"new")
    assert cache.read(A) == b"new" and cache.version(A) not in {first, second, rolled_back, recreated}
    assert [p.name for p in cache.root.iterdir()] == [f"{A}.jpg"]
    cache.delete(A)
    cache.delete(A)
    assert cache.read(A) is None


@pytest.mark.parametrize("operation", ["fsync", "replace"])
def test_write_failure_preserves_previous_and_cleans_temp(tmp_path, monkeypatch, operation):
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"old")
    def fail(*args):
        raise OSError("private disk path")
    monkeypatch.setattr(module.os, operation, fail)
    with pytest.raises(OSError):
        cache.store(A, b"new")
    assert cache.read(A) == b"old"
    assert not list(tmp_path.glob("*.tmp"))
    with pytest.raises(OSError):
        cache.store(B, b"new")
    assert cache.read(B) is None and not list(tmp_path.glob("*.tmp"))


def test_limit_is_one_gib_and_evicts_oldest(tmp_path):
    assert MAX_CACHE_BYTES == 1_073_741_824
    cache = ThumbnailCache(tmp_path)
    # Sparse files exercise the production limit without allocating a GiB of image data.
    for asset_id, timestamp in ((A, 10), (B, 20)):
        path = tmp_path / f"{asset_id}.jpg"
        with path.open("wb") as output:
            output.truncate(MAX_CACHE_BYTES // 2)
        os.utime(path, (timestamp, timestamp))
    before = (tmp_path / f"{A}.jpg").stat().st_mtime_ns
    # Read a small entry to verify the delivery operation never updates generation time.
    cache.store(C, b"new")
    assert not (tmp_path / f"{A}.jpg").exists()
    assert (tmp_path / f"{B}.jpg").exists()
    timestamp = (tmp_path / f"{C}.jpg").stat().st_mtime_ns
    assert cache.read(C) == b"new"
    assert (tmp_path / f"{C}.jpg").stat().st_mtime_ns == timestamp
    assert before == 10_000_000_000
    assert sum(p.stat().st_size for p in tmp_path.glob("*.jpg")) <= MAX_CACHE_BYTES


def test_recent_read_does_not_protect_old_generation_from_eviction(tmp_path, monkeypatch):
    entry_size = CACHE_HEADER_SIZE + 4
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", entry_size * 2)
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"old1")
    os.utime(tmp_path / f"{A}.jpg", (10, 10))
    cache.store(B, b"old2")
    os.utime(tmp_path / f"{B}.jpg", (20, 20))
    previous_version = cache.version(A)
    assert cache.read(A) == b"old1"
    cache.store(C, b"new3")
    assert cache.read(A) is None and cache.read(B) == b"old2"
    cache.store(A, b"regenerated")
    assert cache.version(A) != previous_version and cache.read(A) == b"regenerated"


def test_initialize_removes_orphan_temps_and_prunes(tmp_path, monkeypatch):
    (tmp_path / "thumbnail-orphan.tmp").write_bytes(b"partial")
    (tmp_path / "unrelated.tmp").write_bytes(b"keep")
    entry_size = CACHE_HEADER_SIZE + 4
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", entry_size * 2 - 1)
    for asset_id, timestamp in ((A, 10), (B, 20)):
        path = tmp_path / f"{asset_id}.jpg"
        write_entry(path, b"1234", f"{asset_id.int:032x}")
        os.utime(path, (timestamp, timestamp))
    cache = ThumbnailCache(tmp_path)
    cache.initialize()
    assert not (tmp_path / "thumbnail-orphan.tmp").exists()
    assert (tmp_path / "unrelated.tmp").exists()
    assert cache.read(A) is None and cache.read(B) == b"1234"


def test_oversized_entry_preserves_cache(tmp_path, monkeypatch):
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"old")
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", 3)
    with pytest.raises(ValueError):
        cache.store(A, b"large")
    assert cache.read(A) == b"old" and not list(tmp_path.glob("*.tmp"))


def test_logger_failure_is_ignored(tmp_path, monkeypatch):
    def fail(**kwargs):
        raise RuntimeError("logger failed")
    monkeypatch.setattr(module.backend_logger, "add", fail)
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"jpeg")
    assert cache.read(A) == b"jpeg"
    cache.delete(A)


def test_read_failure_falls_back(tmp_path, monkeypatch):
    from pathlib import Path
    open_file = Path.open
    def fail(self, *args, **kwargs):
        if self.name == f"{A}.jpg":
            raise PermissionError()
        return open_file(self, *args, **kwargs)
    monkeypatch.setattr(Path, "open", fail)
    assert ThumbnailCache(tmp_path).read(A) is None


def test_failed_reset_delete_fences_old_file_after_restart(tmp_path, monkeypatch):
    from pathlib import Path

    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"before reset")
    old = cache.version(A)
    unlink = Path.unlink

    def deny_old_jpeg(path, *args, **kwargs):
        if path.name == f"{A}.jpg":
            raise PermissionError()
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as disk:
        disk.setattr(Path, "unlink", deny_old_jpeg)
        with pytest.raises(PermissionError):
            cache.delete(A)
    restarted = ThumbnailCache(tmp_path)
    assert (tmp_path / f"{A}.jpg").exists()
    assert restarted._reset_marker(A).exists()
    assert restarted.versions([A]) == {str(A): None}
    assert restarted.read_versioned(A) is None
    restarted.store(A, b"after reset")
    new = restarted.version(A)
    assert new != old
    assert restarted.read_versioned(A) == (b"after reset", new)
    assert not restarted._reset_marker(A).exists()
    (tmp_path / f"{A}.jpg").unlink()
    assert restarted.versions([A]) == {str(A): None}


def test_successful_reset_and_startup_cleanup_remove_unneeded_markers(tmp_path):
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"old")
    assert cache.fence_reset(A)
    assert cache._reset_marker(A).exists()
    assert cache.delete(A)
    assert not cache._reset_marker(A).exists()

    orphan = cache._reset_marker(B)
    orphan.write_text("", encoding="ascii")
    cache.initialize()
    assert not orphan.exists()


def test_eviction_removes_reset_marker_with_deleted_artifact(tmp_path, monkeypatch):
    entry_size = CACHE_HEADER_SIZE + 4
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", entry_size)
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"oldA")
    assert cache.fence_reset(A)
    assert cache._reset_marker(A).exists()
    os.utime(tmp_path / f"{A}.jpg", (1, 1))
    cache.store(B, b"newB")
    assert not (tmp_path / f"{A}.jpg").exists()
    assert not cache._reset_marker(A).exists()


def test_initialize_discards_raw_jpeg_entries_without_publication_identity(tmp_path):
    legacy = tmp_path / f"{A}.jpg"
    legacy.write_bytes(b"old raw jpeg cache")
    cache = ThumbnailCache(tmp_path)
    cache.initialize()
    assert not legacy.exists()
    assert cache.read_versioned(A) is None


def test_partial_prune_reports_each_successful_eviction(tmp_path, monkeypatch):
    from pathlib import Path

    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"aaaa")
    cache.store(B, b"bbbb")
    os.utime(tmp_path / f"{A}.jpg", (10, 10))
    os.utime(tmp_path / f"{B}.jpg", (20, 20))
    entry_size = CACHE_HEADER_SIZE + 4
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", entry_size * 2)
    unlink = Path.unlink

    def deny_first(path, *args, **kwargs):
        if path.name == f"{A}.jpg":
            raise PermissionError()
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", deny_first)
    assert cache.store(C, b"cccc") == [B]
    assert cache.version(A) is not None
    assert cache.version(B) is None
    assert cache.version(C) is not None
