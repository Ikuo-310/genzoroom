import pytest

from build_info import read_build_info


@pytest.mark.parametrize("values,expected", [
    ({}, {"name": "GenzoRoom", "version": "0.0.0-development", "channel": "development", "commit": None}),
    ({"GENZOROOM_CHANNEL": "validation", "GENZOROOM_VERSION": "0.0.0-validation", "GENZOROOM_COMMIT": "a" * 40},
     {"name": "GenzoRoom", "version": "0.0.0-validation", "channel": "validation", "commit": "a" * 40}),
    ({"GENZOROOM_CHANNEL": "stable", "GENZOROOM_VERSION": "v0.1.0", "GENZOROOM_COMMIT": "b" * 40},
     {"name": "GenzoRoom", "version": "v0.1.0", "channel": "stable", "commit": "b" * 40}),
])
def test_build_metadata_channels(monkeypatch, values, expected):
    for name in ("GENZOROOM_CHANNEL", "GENZOROOM_VERSION", "GENZOROOM_COMMIT"):
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    assert read_build_info() == expected


@pytest.mark.parametrize("values", [
    {"GENZOROOM_CHANNEL": "stable", "GENZOROOM_VERSION": "validation", "GENZOROOM_COMMIT": "a" * 40},
    {"GENZOROOM_CHANNEL": "stable", "GENZOROOM_VERSION": "v0.1.0", "GENZOROOM_COMMIT": "short"},
    {"GENZOROOM_CHANNEL": "validation", "GENZOROOM_VERSION": "v0.1.0", "GENZOROOM_COMMIT": "a" * 40},
    {"GENZOROOM_CHANNEL": "development", "GENZOROOM_VERSION": "v0.1.0"},
    {"GENZOROOM_CHANNEL": "unknown"},
])
def test_invalid_build_metadata_fails(monkeypatch, values):
    for name in ("GENZOROOM_CHANNEL", "GENZOROOM_VERSION", "GENZOROOM_COMMIT"):
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError):
        read_build_info()
