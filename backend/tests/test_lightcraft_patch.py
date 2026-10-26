import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

spec = importlib.util.spec_from_file_location("lightcraft_build", Path(__file__).parents[2] / "native/lightcraft/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def test_manifest_patch_digest_and_targets():
    value = build.manifest()
    assert value["version"] == "0.14.0"
    assert value["commit"] == "03c88c166c054c009db2a47187d59991f6232b85"
    assert value['geometryDescriptorContract'] == 2
    assert len(value["patches"]) == 1
    patch = (build.ROOT / value["patches"][0]["file"]).read_text(encoding="utf-8")
    assert '"before"' in patch and 'render_job(id, size, size, true, true)' in patch
    assert all(f"a/{target}" in patch for target in value["patches"][0]["targets"])
    assert 'GEOMETRY_DESCRIPTOR_CONTRACT: u64 = 2' in patch and '"nativeAspect":native_aspect' in patch


def test_archived_010_manifest_and_patch_remain_reproducible():
    value = build.manifest(build.ROOT / 'versions/0.10.0.json')
    assert value['version'] == '0.10.0'
    assert value['patches'][0]['sha256'] == '6d2e4113001aa8d9661ac706857191b2286ca420e4987be987bf55b6462609dc'


@pytest.mark.parametrize('changes', [
    {'contracts': {'before': 1, 'preview': 1, 'region': 1, 'wb': True}},
    {'contracts': {'before': 1, 'preview': 1, 'region': 1, 'wb': 2}},
    {'developmentTargetDir': None}, {'developmentTargetDir': 'target'},
    {'developmentTargetDir': '../target'}, {'developmentTargetDir': 'target/release'},
])
def test_wb_manifest_requires_a_supported_contract_and_independent_target(tmp_path, changes):
    value = {**build.manifest(), **changes}
    path = tmp_path / 'manifest.json'
    path.write_text(json.dumps(value), encoding='utf-8')
    with pytest.raises(ValueError, match='unsupported managed contracts|invalid managed development target'):
        build.manifest(path)


def test_wb_receipt_adds_only_the_independent_wb_contract(tmp_path):
    binary = tmp_path / 'engine.exe'
    binary.write_bytes(b'fixture executable')
    value = build.manifest()
    actual = build.receipt(binary, value)
    assert actual['wbContract'] == 1
    assert all(actual[key] == 1 for key in ('beforeContract', 'previewContract', 'regionContract'))
    assert actual['geometryDescriptorContract'] == 2
    assert actual['binarySha256'] == hashlib.sha256(binary.read_bytes()).hexdigest()
    without_wb = {**value, 'contracts': {'before': 1, 'preview': 1, 'region': 1}}
    assert 'wbContract' not in build.receipt(binary, without_wb)


def test_browser_identity_is_generated_from_the_managed_manifest():
    source = build.ROOT / 'sync_identity.py'
    spec = importlib.util.spec_from_file_location('sync_identity', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert (build.ROOT.parents[1] / 'frontend/src/lightcraftEngine.ts').read_text(encoding='utf-8') == module.identity_source(build.manifest())


@pytest.mark.parametrize('version', ['0.10.0', '0.14.0'])
def test_shared_region_artifact_gate_cannot_be_skipped_by_version(tmp_path, monkeypatch, version):
    shared = tmp_path / 'repository'
    managed = shared / 'native/lightcraft'
    managed.mkdir(parents=True)
    source = tmp_path / 'upstream'
    for native, original in [('region_schema.json', 'frontend/src/rawRegion.schema.json'),
                             ('region_contract.json', 'frontend/src/rawRegionContract.json'),
                             ('region_fixtures.json', 'frontend/src/test-fixtures/raw-region-v1.json'),
                             ('region_schema.json', 'backend/raw_region_schema.json')]:
        target = source / 'crates/mcp/src' / native
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'{}\n')
        expected = shared / original
        expected.parent.mkdir(parents=True, exist_ok=True)
        expected.write_bytes(b'{}\n')
    monkeypatch.setattr(build, 'ROOT', managed)
    monkeypatch.setattr(build, 'source_state', lambda *_: 'patched')
    spec = {'version': version, 'geometryDescriptorContract': 2}
    assert build.prepare(source, spec) == 'patched'
    (source / 'crates/mcp/src/region_schema.json').write_bytes(b'{"foreign":true}\n')
    with pytest.raises(ValueError, match='shared contract artifact mismatch'):
        build.prepare(source, spec)


def test_patch_apply_verify_duplicate_and_unknown_changes_fail_closed(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    def git(*args):
        return subprocess.check_output(["git", "-C", str(source), *args])
    git("init", "-q")
    (source / "fixture.txt").write_text("original\n", encoding="utf-8")
    git("add", "fixture.txt")
    git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
    commit = git("rev-parse", "HEAD").decode().strip()
    (source / "fixture.txt").write_text("patched\n", encoding="utf-8")
    patch = git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-color")
    (source / "fixture.txt").write_text("original\n", encoding="utf-8")
    patches = tmp_path / "patches"
    patches.mkdir()
    (patches / "fixture.patch").write_bytes(patch)
    monkeypatch.setattr(build, "ROOT", patches)
    value = {"version": "fixture", "commit": commit, "patches": [
        {"file": "fixture.patch", "sha256": hashlib.sha256(patch).hexdigest()}]}
    (patches / "manifest.json").write_text(json.dumps(value), encoding="utf-8")
    assert build.manifest() == value
    assert build.prepare(source, value) == "upstream"
    assert build.prepare(source, value, apply=True) == "patched"
    with pytest.raises(ValueError, match="already applied"):
        build.prepare(source, value, apply=True)
    (source / "fixture.txt").write_text("partial or foreign edit\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unrecognized changes"):
        build.prepare(source, value)
    with pytest.raises(ValueError, match="HEAD differs"):
        build.prepare(source, {**value, "commit": "0" * 40})
    (source / "fixture.txt").write_text("original\n", encoding="utf-8")
    (patches / "fixture.patch").write_bytes(patch.replace(b"-original", b"-not-the-upstream-content"))
    with pytest.raises(subprocess.CalledProcessError):
        build.prepare(source, value, apply=True)
    assert (source / "fixture.txt").read_text(encoding="utf-8") == "original\n"
    assert build.source_state(source, value) == "upstream"
    (patches / "fixture.patch").write_bytes(patch + b"tampered")
    with pytest.raises(ValueError, match="digest mismatch"):
        build.manifest()


def test_replaced_binary_is_rejected_before_execution(tmp_path, monkeypatch):
    binary = tmp_path / "engine.exe"
    binary.write_bytes(b"verified-build")
    spec = build.manifest()
    binary.with_suffix(".genzoroom.json").write_text(json.dumps(build.receipt(binary, spec)), encoding="utf-8")
    binary.write_bytes(b"replaced-binary")
    monkeypatch.setattr(sys, "argv", ["build.py", "--binary", str(binary)])
    monkeypatch.setattr(build, "probe", lambda _: pytest.fail("a replaced binary must not run"))
    with pytest.raises(ValueError, match="receipt mismatch"):
        build.main()


def test_managed_new_source_joins_diff_without_admitting_untracked_files(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    def git(*args):
        return subprocess.check_output(["git", "-C", str(source), *args])
    git("init", "-q")
    (source / "base.txt").write_text("upstream\n", encoding="utf-8")
    git("add", "base.txt")
    git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
    commit = git("rev-parse", "HEAD").decode().strip()
    added = source / "managed.rs"
    added.write_text("managed source\n", encoding="utf-8")
    git("add", "--intent-to-add", "managed.rs")
    patch = git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-color")
    git("rm", "--cached", "-f", "managed.rs")
    added.unlink()
    patches = tmp_path / "patches"
    patches.mkdir()
    (patches / "fixture.patch").write_bytes(patch)
    monkeypatch.setattr(build, "ROOT", patches)
    value = {"version": "fixture", "commit": commit, "patches": [
        {"file": "fixture.patch", "sha256": hashlib.sha256(patch).hexdigest()}]}
    assert build.prepare(source, value, apply=True) == "patched"
    assert not git("diff", "--cached", "--name-only").strip()
    assert not git("ls-files", "--others", "--exclude-standard").strip()
    with pytest.raises(ValueError, match="already applied"):
        build.prepare(source, value, apply=True)
    (source / "unmanaged.rs").write_text("not managed\n", encoding="utf-8")
    with pytest.raises(ValueError, match="untracked source"):
        build.source_state(source, value)
