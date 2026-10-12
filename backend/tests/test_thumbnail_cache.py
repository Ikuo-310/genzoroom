import os
from uuid import UUID

import pytest

import thumbnail_cache as module
from thumbnail_cache import MAX_CACHE_BYTES, ThumbnailCache

A, B, C = (UUID(int=i) for i in (1, 2, 3))


def test_atomic_replacement_read_and_delete(tmp_path):
    cache = ThumbnailCache(tmp_path / "thumbnails")
    cache.initialize()
    assert cache.read(A) is None
    cache.store(A, b"old")
    cache.store(A, b"new")
    assert cache.read(A) == b"new"
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
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", 8)
    cache = ThumbnailCache(tmp_path)
    cache.store(A, b"old1")
    os.utime(tmp_path / f"{A}.jpg", (10, 10))
    cache.store(B, b"old2")
    os.utime(tmp_path / f"{B}.jpg", (20, 20))
    assert cache.read(A) == b"old1"
    cache.store(C, b"new3")
    assert cache.read(A) is None and cache.read(B) == b"old2"


def test_initialize_removes_orphan_temps_and_prunes(tmp_path, monkeypatch):
    (tmp_path / "thumbnail-orphan.tmp").write_bytes(b"partial")
    (tmp_path / "unrelated.tmp").write_bytes(b"keep")
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", 5)
    for asset_id, timestamp in ((A, 10), (B, 20)):
        path = tmp_path / f"{asset_id}.jpg"
        path.write_bytes(b"1234")
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
    def fail(self):
        raise PermissionError()
    monkeypatch.setattr(Path, "read_bytes", fail)
    assert ThumbnailCache(tmp_path).read(A) is None
