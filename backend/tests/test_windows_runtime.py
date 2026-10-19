"""Deployment contracts without touching user data or credentials."""
import json
import sys

import pytest

import windows_runtime as runtime


@pytest.mark.parametrize("frozen", [False, True])
def test_deployment_paths_do_not_discover_or_modify_poc(tmp_path, monkeypatch, frozen):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    poc = tmp_path / "GenzoRoom/WindowsPoC"
    poc.mkdir(parents=True)
    sentinel = poc / "connection.json"
    sentinel.write_text("untouched", encoding="utf-8")
    assert runtime.data_root() == (poc.parent if frozen else poc)
    assert runtime.credential_namespace() == ("GenzoRoom/Immich/" if frozen else "GenzoRoom/WindowsPoC/Immich/")
    assert sentinel.read_text() == "untouched"


@pytest.mark.parametrize("location", ["", "relative", r"\\server\share"])
def test_invalid_local_data_rejected(monkeypatch, location):
    monkeypatch.setenv("LOCALAPPDATA", location)
    with pytest.raises(ValueError, match="invalid_local_data"):
        runtime.data_root()


def test_frozen_identity_uses_bundled_manifest(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(runtime, "__file__", str(tmp_path / "windows_runtime.py"))
    for field in ("CHANNEL", "VERSION", "COMMIT"):
        monkeypatch.setenv("GENZOROOM_" + field, "ambient-value")
    manifest = tmp_path / "build-manifest.json"
    manifest.write_text(json.dumps({"channel": "validation", "version": "0.0.0-validation", "commit": "a" * 40}))
    runtime.apply_build_info()
    assert runtime.os.environ["GENZOROOM_COMMIT"] == "a" * 40
    manifest.write_text("{}")
    with pytest.raises(RuntimeError, match="^backend_build_info_invalid$"):
        runtime.apply_build_info()


def test_native_runtime_selfcheck_is_offline_and_does_not_create_data(tmp_path, monkeypatch):
    from windows_runtime_check import check_runtime
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    result = check_runtime()
    assert result["jpegIccNumpy"] and result["sqlite"] and result["tlsCaLoaded"]
    assert not list(tmp_path.iterdir())


def test_distribution_inventory_detects_incomplete_or_changed_copy(tmp_path):
    import hashlib
    import importlib.util
    from pathlib import Path
    import struct
    spec = importlib.util.spec_from_file_location("verify_bundle", Path(__file__).resolve().parents[2] / "desktop/packaging/verify_bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    executable = bytearray(512)
    executable[:2] = b'MZ'
    struct.pack_into('<I', executable, 0x3c, 128)
    executable[128:132] = b'PE\0\0'
    struct.pack_into('<H', executable, 132, 0x8664)
    struct.pack_into('<H', executable, 128 + 24 + 68, 3)
    (tmp_path / 'genzoroom-backend.exe').write_bytes(executable)
    frontend = tmp_path / '_internal/frontend/dist'
    frontend.mkdir(parents=True)
    (frontend / 'index.html').write_text('test')
    for path in (tmp_path / 'build-manifest.json', tmp_path / '_internal/build-manifest.json'):
        path.write_text('{}')
    files = [{'path': path.relative_to(tmp_path).as_posix(), 'bytes': path.stat().st_size,
              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in tmp_path.rglob('*') if path.is_file()]
    (tmp_path / 'inventory.json').write_text(json.dumps({'files': files}))
    module.verify(tmp_path)
    extra = tmp_path / 'stale.dll'
    extra.write_bytes(b'not in the new build')
    with pytest.raises(RuntimeError, match='bundle_inventory_file_set_mismatch'):
        module.verify(tmp_path)
    extra.unlink()
    (frontend / 'index.html').write_text('lost')
    with pytest.raises(RuntimeError, match='bundle_inventory_mismatch'):
        module.verify(tmp_path)
    (frontend / 'index.html').unlink()
    with pytest.raises(RuntimeError, match='bundle_inventory_file_set_mismatch'):
        module.verify(tmp_path)
