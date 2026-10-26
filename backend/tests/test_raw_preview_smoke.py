import importlib.util
import json
from pathlib import Path


def module():
    path = Path(__file__).resolve().parents[2] / 'native/lightcraft/raw_preview_smoke.py'
    spec = importlib.util.spec_from_file_location('raw_preview_smoke', path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def prepare(monkeypatch):
    smoke = module()
    async def ready(report):
        report['stages']['readiness'] = 'pass'
    def fixtures(report):
        report['stages'].update(dict.fromkeys(smoke.STAGES, 'pass'))
    monkeypatch.setattr(smoke, 'readiness', ready)
    monkeypatch.setattr(smoke, 'frontend', fixtures)
    monkeypatch.setattr(smoke, 'backend', fixtures)
    return smoke


def test_json_export_and_optional_benchmark_never_change_correctness(monkeypatch, tmp_path, capsys):
    smoke = prepare(monkeypatch)
    async def bench(_):
        return {'enabled': True, 'status': 'complete', 'iterations': 3, 'totalMs': {'median': 999999}}
    monkeypatch.setattr(smoke, 'benchmark', bench)
    destination = tmp_path / 'result.json'
    monkeypatch.setattr('sys.argv', ['raw-preview-smoke', '--json', '--json-out', str(destination), '--benchmark', '--raw-file', 'PRIVATE'])
    assert smoke.main() == 0
    printed = capsys.readouterr()
    report = json.loads(printed.out)
    assert report == json.loads(destination.read_text())
    assert report['schemaVersion'] == 1 and report['result'] == 'pass'
    assert report['benchmark']['totalMs']['median'] == 999999
    assert 'PRIVATE' not in printed.out and 'PASS' in printed.err


def test_default_command_does_not_run_a_benchmark(monkeypatch, capsys):
    smoke = prepare(monkeypatch)
    monkeypatch.setattr(smoke, 'benchmark', lambda _: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr('sys.argv', ['raw-preview-smoke', '--json'])
    assert smoke.main() == 0
    assert json.loads(capsys.readouterr().out)['benchmark'] == {'enabled': False}


def test_failure_is_fixed_code_and_does_not_export_upstream_errors(monkeypatch, capsys):
    smoke = prepare(monkeypatch)
    def frontend(report):
        smoke.failure(report, 'geometryStability', 'draft_full_geometry_changed')
    async def benchmark(_):
        raise RuntimeError('PRIVATE C:/photo.raw raw recipe')
    monkeypatch.setattr(smoke, 'frontend', frontend)
    monkeypatch.setattr(smoke, 'backend', lambda _: None)
    monkeypatch.setattr(smoke, 'benchmark', benchmark)
    monkeypatch.setattr('sys.argv', ['raw-preview-smoke', '--json', '--benchmark', '--raw-file', 'PRIVATE'])
    assert smoke.main() == 1
    printed = capsys.readouterr()
    report = json.loads(printed.out)
    assert report['result'] == 'fail'
    assert report['failure']['stage'] == 'geometryStability'
    assert report['failure']['code'] == 'draft_full_geometry_changed'
    assert report['stages']['close'] == 'not_run'
    assert 'PRIVATE' not in printed.out + printed.err
