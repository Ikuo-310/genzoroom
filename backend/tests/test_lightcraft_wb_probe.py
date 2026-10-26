"""Native settings identity must survive transport without float/string reserialization."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('wb_probe', Path(__file__).parents[2] / 'native/lightcraft/wb_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def test_native_fingerprint_preserves_number_tokens_and_quoted_whitespace():
    native = '{\n  "exposure": 1e-7,\n "label": "a b\\n\\\"c\\\\d", "negativeZero": -0.0\n}'
    compact = '{"exposure":1e-7,"label":"a b\\n\\\"c\\\\d","negativeZero":-0.0}'
    assert probe.settings_fingerprint(native) == hashlib.sha256(compact.encode()).hexdigest()
    assert probe.settings_fingerprint(native) != hashlib.sha256(
        json.dumps(json.loads(native), separators=(',', ':'), sort_keys=True).encode()).hexdigest()


def test_native_fingerprint_checks_text_and_structured_settings_agree():
    result = {'content': [{'type': 'text', 'text': '{ "exposure": 1e-7 }'}],
              'structuredContent': {'exposure': 1e-7}}
    assert probe.result_fingerprint(result) == hashlib.sha256(b'{"exposure":1e-7}').hexdigest()
    result['structuredContent']['exposure'] = 0.5
    with pytest.raises(ValueError, match='mismatch'):
        probe.result_fingerprint(result)


@pytest.mark.parametrize('text', ['[]', 'null', '"settings"'])
def test_native_fingerprint_rejects_non_settings_json(text):
    with pytest.raises(ValueError, match='object required'):
        probe.settings_fingerprint(text)
