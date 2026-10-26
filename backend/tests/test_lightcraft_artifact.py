import asyncio
import hashlib
import json
import threading

import pytest

from lightcraft_artifact import ENGINE_VERSION, MANAGED, resolve_managed_executable, verified_artifact
from tests.test_lightcraft_runtime import make_manager
from tests.test_lightcraft_mcp import until


def write_receipt(executable, **changes):
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    value = {**{key: MANAGED[key] for key in ('version', 'commit', 'patches', 'geometryDescriptorContract')},
             'binarySha256': digest, 'beforeContract': 1, 'previewContract': 1, 'regionContract': 1, 'wbContract': 1, **changes}
    executable.with_suffix('.genzoroom.json').write_text(json.dumps(value), encoding='utf-8')
    return digest


@pytest.mark.parametrize('changes', [
    {'version': '0.10.0'}, {'commit': 'a' * 40}, {'binarySha256': 'b' * 64},
    {'patches': []}, {'beforeContract': 2}, {'regionContract': True}, {'geometryDescriptorContract': 1},
    {'wbContract': True}, {'wbContract': 2}, {'wbContract': None},
])
def test_receipt_mismatch_never_claims_a_managed_version(tmp_path, changes):
    executable = tmp_path / 'engine.exe'
    executable.write_bytes(b'actual engine')
    digest = write_receipt(executable, **changes)
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None


def test_missing_malformed_and_replaced_binary_receipts(tmp_path):
    executable = tmp_path / 'engine.exe'
    executable.write_bytes(b'actual engine')
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None
    executable.with_suffix('.genzoroom.json').write_text('{', encoding='utf-8')
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None
    write_receipt(executable)
    assert verified_artifact(executable, digest, ENGINE_VERSION)['version'] == ENGINE_VERSION
    assert verified_artifact(executable, 'c' * 64, ENGINE_VERSION) is None


def test_receipt_without_wb_contract_is_not_a_phase_one_artifact(tmp_path):
    executable = tmp_path / 'engine.exe'
    executable.write_bytes(b'actual engine')
    digest = write_receipt(executable)
    path = executable.with_suffix('.genzoroom.json')
    receipt = json.loads(path.read_text(encoding='utf-8'))
    del receipt['wbContract']
    path.write_text(json.dumps(receipt), encoding='utf-8')
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None


def test_runtime_attestation_belongs_only_to_the_ready_generation(tmp_path):
    async def run():
        manager, _, _ = make_manager(tmp_path)
        write_receipt(tmp_path / 'lightcraft-cli.exe')
        assert manager.artifact_info() is None
        await manager.start()
        await until(lambda: manager.status().state == 'ready')
        assert manager.artifact_info()['version'] == ENGINE_VERSION
        await manager.close()
        assert manager.artifact_info() is None
        (tmp_path / 'lightcraft-cli.genzoroom.json').write_text('{}', encoding='utf-8')
        await manager.start()
        await until(lambda: manager.status().state == 'ready')
        assert manager.artifact_info() is None
        await manager.close()
    asyncio.run(run())


def test_stalled_receipt_io_cannot_hold_the_loop_or_shutdown(tmp_path, monkeypatch):
    import lightcraft_runtime
    async def run():
        gate, entered = threading.Event(), threading.Event()
        def stalled(*_):
            entered.set()
            gate.wait(5)
            return None
        monkeypatch.setattr(lightcraft_runtime, 'verified_artifact', stalled)
        manager, _, launches = make_manager(tmp_path)
        await manager.start()
        try:
            await until(entered.is_set)
            await until(lambda: manager.status().state == 'failed')
            assert manager.status().error_code == 'lightcraft_startup_timeout'
            await asyncio.wait_for(manager.close(), .2)
            assert not launches
        finally:
            gate.set()
    asyncio.run(run())


def test_managed_executable_discovery_is_dev_only_and_manifest_bound(tmp_path):
    root = tmp_path / 'checkout'
    (root / '.git').mkdir(parents=True)
    manifest = root / 'native' / 'lightcraft' / 'manifest.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps(MANAGED), encoding='utf-8')
    executable = root / '.tmp' / 'lightcraft-0.14' / MANAGED['developmentTargetDir'] / 'release' / 'lightcraft-cli.exe'
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b'managed executable')
    assert resolve_managed_executable({}, 'win32', project_root=root, frozen=False) == str(executable)
    assert resolve_managed_executable({'GENZOROOM_LIGHTCRAFT_EXE': 'custom.exe'}, 'win32',
                                      project_root=root, frozen=False) == 'custom.exe'
    assert resolve_managed_executable({}, 'win32', project_root=root, frozen=True) == ''
    assert resolve_managed_executable({}, 'linux', project_root=root, frozen=False) == ''

    write_receipt(executable)
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    assert verified_artifact(executable, digest, ENGINE_VERSION)['version'] == ENGINE_VERSION
    executable.with_suffix('.genzoroom.json').unlink()
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None
    assert resolve_managed_executable({}, 'win32', project_root=root, frozen=False) == str(executable)

    executable.with_suffix('.genzoroom.json').write_text('{}', encoding='utf-8')
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None
    write_receipt(executable)
    assert verified_artifact(executable, '0' * 64, ENGINE_VERSION) is None
    write_receipt(executable, version='0.10.0')
    assert verified_artifact(executable, digest, ENGINE_VERSION) is None
    stale = root / '.tmp' / 'lightcraft-0.10' / 'target' / 'release' / 'lightcraft-cli.exe'
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b'old')
    executable.unlink()
    executable.with_suffix('.genzoroom.json').unlink()
    assert resolve_managed_executable({}, 'win32', project_root=root, frozen=False) == ''

    manifest.write_text(json.dumps({**MANAGED, 'version': '0.10.0'}), encoding='utf-8')
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.write_bytes(b'managed executable')
    assert resolve_managed_executable({}, 'win32', project_root=root, frozen=False) == ''


def test_lightcraft_manager_attests_discovered_executable(monkeypatch, tmp_path):
    import lightcraft_runtime
    from tests.test_lightcraft_runtime import FAST, FakeProcess

    async def run():
        executable = tmp_path / 'managed.exe'
        executable.write_bytes(b'managed executable')
        write_receipt(executable)
        children = []
        async def spawn(*args, **kwargs):
            child = FakeProcess()
            children.append(child)
            return child
        monkeypatch.setattr(lightcraft_runtime, 'resolve_managed_executable', lambda *_: str(executable))
        manager = lightcraft_runtime.LightCraftManager(environment={'SYSTEMROOT': 'C:\\Windows'}, platform='win32',
                                                        spawn=spawn, timeouts=FAST)
        await manager.start()
        await until(lambda: manager.status().state == 'ready')
        assert manager.artifact_info()['version'] == ENGINE_VERSION
        assert manager.status().executable_sha256 == hashlib.sha256(executable.read_bytes()).hexdigest()
        await manager.close()
    asyncio.run(run())


def test_unattested_process_cannot_import_or_stamp_a_recipe_tuple(tmp_path):
    from lightcraft_mcp import LightCraftError
    from tests.test_lightcraft_raw import create
    async def run():
        raw, manager, children, files = await create(tmp_path)
        try:
            manager._artifact = None
            with pytest.raises(LightCraftError, match='raw_unverified_artifact'):
                await raw.open_raw('synthetic-source', files[0])
            assert not children[0].commands
        finally:
            await raw.close()
    asyncio.run(run())
