import pytest

from lightcraft_mcp import LightCraftError
from raw_controls import CURVE_CHANNELS, curve_readback, validate_curve_input
from raw_controls import validate_history_operation
from raw_recipe_store import InvalidRawHistory, _history_metadata


@pytest.mark.parametrize("channel", CURVE_CHANNELS)
def test_curve_input_accepts_native_pair_arrays(channel):
    assert validate_curve_input(channel, [[0, 0], [0.5, 0.75], [1, 1]])[-1] == [1, 1]


@pytest.mark.parametrize("channel", ["rgb", "parametric", "", None])
def test_curve_input_rejects_unknown_channel(channel):
    with pytest.raises(LightCraftError, match="raw_invalid_request"):
        validate_curve_input(channel, [])


@pytest.mark.parametrize("point", [[float("nan"), 0], [0, float("inf")], [-0.1, 0], [0, 1.1], [0], [0, 0, 0], {"x": 0, "y": 1}, [True, 0]])
def test_curve_input_rejects_malformed_or_out_of_range_points(point):
    with pytest.raises(LightCraftError, match="raw_invalid_request"):
        validate_curve_input("master", [point])


def test_curve_input_enforces_point_and_serialized_size_limits():
    with pytest.raises(LightCraftError, match="raw_invalid_request"):
        validate_curve_input("master", [[0, 0]] * 4097)
    with pytest.raises(LightCraftError, match="raw_invalid_request"):
        validate_curve_input("master", [[0.1234567890123456, 0.8765432109876543]] * 4096)


def test_curve_readback_requires_four_channels_and_valid_object_points():
    value = {"curve": {channel: [{"x": 0, "y": 0}, {"x": 1, "y": 1}] for channel in CURVE_CHANNELS}}
    assert curve_readback(value)["blue"] == [{"x": 0, "y": 0}, {"x": 1, "y": 1}]
    for invalid in (
        {"curve": {"master": [{"x": 0, "y": 0}]}},
        {"curve": {**value["curve"], "red": [{"x": float("nan"), "y": 0}]}},
        {"curve": {**value["curve"], "green": [{"x": -0.1, "y": 0}]}},
        {"curve": {**value["curve"], "blue": [{"x": 0, "y": 0, "extra": 1}]}},
    ):
        with pytest.raises(LightCraftError, match="raw_invalid_settings"):
            curve_readback(invalid)


def test_curve_history_metadata_contains_only_the_channel():
    metadata = {"channel": "green"}
    validate_history_operation("curve", metadata)
    assert _history_metadata("curve", metadata) == metadata
    with pytest.raises(LightCraftError, match="raw_invalid_request"):
        validate_history_operation("curve", {"channel": "green", "points": [[0, 0]]})
    with pytest.raises(InvalidRawHistory):
        _history_metadata("curve", {"channel": "green", "points": [[0, 0]]})


def test_curve_reset_metadata_allows_only_point_or_a_single_point_channel():
    for channel in (*CURVE_CHANNELS, "point"):
        metadata = {"channel": channel}
        validate_history_operation("curveReset", metadata)
        assert _history_metadata("curveReset", metadata) == metadata
    for channel in ("all", "parametric", None):
        with pytest.raises(LightCraftError, match="raw_invalid_request"):
            validate_history_operation("curveReset", {"channel": channel})
        with pytest.raises(InvalidRawHistory):
            _history_metadata("curveReset", {"channel": channel})
