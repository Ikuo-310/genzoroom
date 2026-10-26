import asyncio
import hashlib
import json
import threading

import pytest

from lightcraft_artifact import ENGINE_VERSION, MANAGED, verified_artifact
from tests.test_lightcraft_runtime import make_manager
from tests.test_lightcraft_mcp import until


def write_receipt(executable, **changes):
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    value = {**{key: MANAGED[key] for key in ('version', 'commit', 'patches', 'geometryDescriptorContract')},
             'binarySha256': digest, 'beforeContract': 1, 'previewContract': 1, 'regionContract': 1, **changes}
    executable.with_suffix('.genzoroom.json').write_text(json.dumps(value), encoding='utf-8')
    return digest


@pytest.mark.parametrize('changes', [
    {'version': '0.10.0'}, {'commit': 'a' * 40}, {'binarySha256': 'b' * 64},
    {'patches': []}, {'beforeContract': 2}, {'regionContract': True}, {'geometryDescriptorContract': 1},
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
