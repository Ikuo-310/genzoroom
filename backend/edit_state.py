"""Validation for the versioned edit snapshot sent by the frontend."""

import math
from uuid import UUID

STATE_FORMAT_VERSION = 2
RECIPE_VERSION = 17
PROCESSING_VERSION = "jpeg-preview-srgb8-v1"

BOUNDS = {
    "temperature": (-100, 100), "tint": (-100, 100), "exposure": (-5, 5),
    "contrast": (-100, 100), "highlights": (-100, 100), "whites": (-100, 100),
    "shadows": (-100, 100), "blacks": (-100, 100),
    "shadowsTemperature": (-100, 100), "shadowsTint": (-100, 100),
    "midtonesTemperature": (-100, 100), "midtonesTint": (-100, 100),
    "highlightsTemperature": (-100, 100), "highlightsTint": (-100, 100),
    "vibrance": (-100, 100), "saturation": (-100, 100),
}
FLAGS = (
    "whiteBalanceEnabled", "basicEnabled", "colorGradingEnabled", "gradingShadowsEnabled",
    "gradingMidtonesEnabled", "gradingHighlightsEnabled", "colorEnabled",
)
SCALAR_KINDS = frozenset(BOUNDS)
TOGGLE_FIELDS = {
    "whiteBalanceToggle": "whiteBalanceEnabled", "basicToggle": "basicEnabled",
    "colorGradingToggle": "colorGradingEnabled", "colorToggle": "colorEnabled",
    "gradingShadowsToggle": "gradingShadowsEnabled",
    "gradingMidtonesToggle": "gradingMidtonesEnabled",
    "gradingHighlightsToggle": "gradingHighlightsEnabled",
}
RESET_FIELDS = {f"{key}Reset": frozenset((key,)) for key in BOUNDS}
RESET_FIELDS.update({
    "whiteBalanceReset": frozenset(("temperature", "tint")),
    "basicReset": frozenset(("exposure", "contrast", "highlights", "whites", "shadows", "blacks")),
    "colorGradingReset": frozenset(("shadowsTemperature", "shadowsTint", "midtonesTemperature", "midtonesTint", "highlightsTemperature", "highlightsTint")),
    "colorReset": frozenset(("vibrance", "saturation")),
    "allReset": frozenset(BOUNDS),
})
KINDS = SCALAR_KINDS | TOGGLE_FIELDS.keys() | RESET_FIELDS.keys()
SNAPSHOT_KEYS = frozenset((
    "stateFormatVersion", "recipeVersion", "processingVersion", "currentRecipe", "history",
    "historyCursor", "sourceIdentity",
))


class InvalidEditState(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _record(value: object, keys: frozenset[str], code: str) -> dict:
    if not isinstance(value, dict) or value.keys() != keys:
        raise InvalidEditState(code)
    return value


def _recipe(value: object) -> dict:
    recipe = _record(value, frozenset(("version", "adjustments", *FLAGS)), "invalid_recipe")
    if type(recipe["version"]) is not int or recipe["version"] != RECIPE_VERSION:
        raise InvalidEditState("unsupported_recipe_version")
    if any(type(recipe[flag]) is not bool for flag in FLAGS):
        raise InvalidEditState("invalid_recipe")
    adjustments = _record(recipe["adjustments"], frozenset(BOUNDS), "invalid_recipe")
    for key, (low, high) in BOUNDS.items():
        number = adjustments[key]
        try:
            valid_number = type(number) in (int, float) and math.isfinite(number) and low <= number <= high
        except OverflowError:
            # math.isfinite converts integers to float; sufficiently large JSON
            # integers cannot be represented there and are invalid by range.
            valid_number = False
        if not valid_number:
            raise InvalidEditState("invalid_recipe")
    return recipe


def _changed_fields(before: dict, after: dict) -> tuple[set[str], set[str]]:
    values = {key for key in BOUNDS if before["adjustments"][key] != after["adjustments"][key]}
    flags = {key for key in FLAGS if before[key] != after[key]}
    return values, flags


def _entry(value: object, state_format_version: int) -> dict:
    paste = isinstance(value, dict) and value.get("kind") == "paste"
    keys = ("kind", "before", "after", "metadata") if paste else ("kind", "before", "after")
    entry = _record(value, frozenset(keys), "invalid_history")
    kind = entry["kind"]
    if type(kind) is not str or (kind not in KINDS and not paste) or (paste and state_format_version != 2):
        raise InvalidEditState("invalid_history")
    if paste:
        metadata = _record(entry["metadata"], frozenset(("sourceAssetId", "sourceFilename", "adjustmentIds")), "invalid_history")
        ids = metadata["adjustmentIds"]
        if type(metadata["sourceAssetId"]) is not str or type(metadata["sourceFilename"]) is not str \
            or not isinstance(ids, list) or not ids \
            or any(type(key) is not str or key not in BOUNDS for key in ids) \
            or len(set(ids)) != len(ids):
            raise InvalidEditState("invalid_history")
    before, after = _recipe(entry["before"]), _recipe(entry["after"])
    values, flags = _changed_fields(before, after)
    if paste:
        valid = not flags and bool(values) and values <= set(ids)
    elif kind in SCALAR_KINDS:
        valid = not flags and values <= {kind}
    elif kind in TOGGLE_FIELDS:
        valid = not values and flags <= {TOGGLE_FIELDS[kind]}
    else:
        valid = not flags and values <= RESET_FIELDS[kind] if kind != "allReset" else True
    if not valid:
        raise InvalidEditState("invalid_history_semantics")
    return entry


def validate_snapshot(value: object, asset_id: UUID | None = None) -> dict:
    state = _record(value, SNAPSHOT_KEYS, "invalid_snapshot")
    # Preserve the original version: GET and identical saveId retries must not
    # rewrite stored v1 JSON. The frontend creates v2 on its next changed save.
    if type(state["stateFormatVersion"]) is not int or state["stateFormatVersion"] not in (1, STATE_FORMAT_VERSION):
        raise InvalidEditState("unsupported_state_format_version")
    for key, expected in (
        ("recipeVersion", RECIPE_VERSION),
        ("processingVersion", PROCESSING_VERSION),
    ):
        if type(state[key]) is not type(expected) or state[key] != expected:
            raise InvalidEditState("unsupported_" + {
                "stateFormatVersion": "state_format_version", "recipeVersion": "recipe_version",
                "processingVersion": "processing_version",
            }[key])
    current = _recipe(state["currentRecipe"])
    source = state["sourceIdentity"]
    if not isinstance(source, dict) or not {"provider", "assetId", "inputKind"} <= source.keys() \
        or source.keys() - {"provider", "assetId", "inputKind", "checksum", "checksumKind"} \
        or source["provider"] != "immich" or source["inputKind"] != "immich-preview" \
        or type(source["assetId"]) is not str or not source["assetId"].strip() \
        or ("checksum" in source) != ("checksumKind" in source) \
        or ("checksum" in source and (type(source["checksum"]) is not str or type(source["checksumKind"]) is not str)):
        raise InvalidEditState("invalid_source_identity")
    if asset_id is not None:
        try:
            matches = UUID(source["assetId"]) == asset_id
        except ValueError:
            matches = False
        if not matches:
            raise InvalidEditState("invalid_source_identity")
    history = state["history"]
    if not isinstance(history, list):
        raise InvalidEditState("invalid_history")
    previous = None
    for item in history:
        entry = _entry(item, state["stateFormatVersion"])
        if previous is not None and previous["after"] != entry["before"]:
            raise InvalidEditState("history_discontinuity")
        previous = entry
    cursor = state["historyCursor"]
    if type(cursor) is not int or not 0 <= cursor <= len(history):
        raise InvalidEditState("invalid_history_cursor")
    if (cursor and current != history[cursor - 1]["after"]) or (cursor < len(history) and current != history[cursor]["before"]):
        raise InvalidEditState("current_recipe_mismatch")
    return state
