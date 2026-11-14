"""LightCraft control allowlist for the Native editor; never JPEG Recipe values."""

import math
import copy
import re

from lightcraft_mcp import LightCraftError

CONTROLS = {
    "light.exposure": (-5, 5, .01, 0, 2),
    **{f"light.{key}": (-100, 100, 1, 0, 0)
       for key in ("contrast", "highlights", "shadows", "whites", "blacks")},
    **{f"grading.{band}.{field}": (lo, hi, 1, 0, 0)
       for band in ("shadows", "midtones", "highlights")
       for field, lo, hi in (("hue", 0, 360), ("sat", 0, 100), ("lum", -100, 100))},
    "grading.blending": (0, 100, 1, 50, 0),
    "grading.balance": (-100, 100, 1, 0, 0),
    "wb.temp": (2000, 50000, 50, 6500, 0),
    "wb.tint": (-150, 150, 1, 0, 0),
    "color.vibrance": (-100, 100, 1, 0, 0),
    "color.saturation": (-100, 100, 1, 0, 0),
    **{f"mixer.{color}.{field}": (-100, 100, 1, 0, 0)
       for color in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")
       for field in ("hue", "sat", "lum")},
    **{f"effects.{key}": (-100, 100, 1, 0, 0) for key in ("texture", "clarity", "dehaze")},
    "vignette.amount": (-100, 100, 1, 0, 0),
    "vignette.midpoint": (0, 100, 1, 50, 0),
    "vignette.feather": (0, 100, 1, 50, 0),
    "vignette.roundness": (-100, 100, 1, 0, 0),
    "vignette.highlights": (0, 100, 1, 0, 0),
    "detail.sharpenAmount": (0, 150, 1, 0, 0),
    "detail.sharpenMasking": (0, 100, 1, 0, 0),
    "detail.nrLuminance": (0, 100, 1, 0, 0),
    "detail.nrDetail": (0, 100, 1, 50, 0),
    "detail.nrColor": (0, 100, 1, 0, 0),
    "detail.nrColorDetail": (0, 100, 1, 50, 0),
    "detail.nrColorSmoothness": (0, 100, 1, 50, 0),
    **{f"optics.{name}": spec for name, spec in {
        "distortion": (-100, 100, 1, 0, 0), "vignetting": (-100, 100, 1, 0, 0),
        "vignettingMidpoint": (0, 100, 1, 50, 0), "profileDistortion": (0, 200, 1, 100, 0),
        "profileVignetting": (0, 200, 1, 100, 0), "defringePurple": (0, 20, 1, 0, 0),
        "defringePurpleHueLo": (0, 90, 1, 30, 0), "defringePurpleHueHi": (10, 100, 1, 70, 0),
        "defringeGreen": (0, 20, 1, 0, 0), "defringeGreenHueLo": (0, 90, 1, 40, 0),
        "defringeGreenHueHi": (10, 100, 1, 60, 0), "caRed": (-100, 100, 1, 0, 0), "caBlue": (-100, 100, 1, 0, 0),
    }.items()},
}

SECTIONS = ("light", "color", "grading", "effects", "detail", "optics")
SETTINGS_SECTIONS = SECTIONS
HISTORY_CONTROLS = frozenset(CONTROLS)
HISTORY_FLAG_CONTROLS = frozenset(("optics.remove_ca", "optics.lens_profile", "profile.camera_local_tone"))
# Vignette has a Native reset section, but its eye belongs to Effects.
RESET_SECTIONS = (*SETTINGS_SECTIONS, "vignette", "mixer")
CURVE_CHANNELS = ("master", "red", "green", "blue")
CURVE_SETTING_FIELDS = frozenset((*CURVE_CHANNELS, "highlights", "lights", "darks", "shadows",
                                  "split_shadows", "split_mid", "split_highlights", "refine_saturation"))
CURVE_NUMERIC_FIELDS = ("highlights", "lights", "darks", "shadows", "split_shadows", "split_mid",
                        "split_highlights", "refine_saturation")
MAX_CURVE_POINTS = 4096
MAX_CURVE_BYTES = 64 * 1024
VIGNETTE_STYLES = ("highlightPriority", "colorPriority", "paintOverlay")
POINT_COLOR_FIELDS = {
    "hueShift": ("hue_shift", -100.0, 100.0, 0.0),
    "satShift": ("sat_shift", -100.0, 100.0, 0.0),
    "lumShift": ("lum_shift", -100.0, 100.0, 0.0),
    "variance": ("variance", -100.0, 100.0, 0.0),
    "range": ("range", 0.0, 100.0, 50.0),
    "hueRange": ("hue_range", 0.0, 100.0, 50.0),
    "satRange": ("sat_range", 0.0, 100.0, 50.0),
    "lumRange": ("lum_range", 0.0, 100.0, 50.0),
}
POINT_COLOR_CENTER_FIELDS = ("lum", "chroma", "hue")
MAX_POINT_COLORS = 8
# Native command IDs are not JSON field names; every readback and History delta uses this mapping.
CONTROL_PATHS = {control: tuple(control.split(".")) for control in CONTROLS} | {
    "detail.sharpenAmount": ("detail", "sharpen_amount"),
    "detail.sharpenMasking": ("detail", "sharpen_masking"),
    "detail.nrLuminance": ("detail", "nr_luminance"),
    "detail.nrDetail": ("detail", "nr_detail"),
    "detail.nrColor": ("detail", "nr_color"),
    "detail.nrColorDetail": ("detail", "nr_color_detail"),
    "detail.nrColorSmoothness": ("detail", "nr_color_smoothness"),
    **{f"optics.{name}": ("optics", field) for name, field in {
        "distortion": "distortion", "vignetting": "vignetting", "vignettingMidpoint": "vignetting_midpoint",
        "profileDistortion": "profile_distortion", "profileVignetting": "profile_vignetting",
        "defringePurple": "defringe_purple_amount", "defringePurpleHueLo": "defringe_purple_hue_lo",
        "defringePurpleHueHi": "defringe_purple_hue_hi", "defringeGreen": "defringe_green_amount",
        "defringeGreenHueLo": "defringe_green_hue_lo", "defringeGreenHueHi": "defringe_green_hue_hi",
        "caRed": "ca_red", "caBlue": "ca_blue"}.items()},
    "optics.remove_ca": ("optics", "remove_ca"), "optics.lens_profile": ("optics", "lens_profile"),
    "profile.camera_local_tone": ("profile", "camera_local_tone"),
}
# A native Detail reset includes controls not exposed by GenzoRoom yet.
DETAIL_RESET_DEFAULTS = dict(sharpen_amount=0, sharpen_radius=1, sharpen_detail=25, sharpen_masking=0,
    nr_luminance=0, nr_detail=50, nr_contrast=0, nr_color=0, nr_color_detail=50, nr_color_smoothness=50)


def complete_snapshot_for_merge(settings, *, restore_point_colors=False):
    """Complete defaults for full restores; partial merges and stored snapshots keep omissions."""
    if type(settings) is not dict:
        raise LightCraftError("raw_invalid_settings")
    result = copy.deepcopy(settings)
    mixer = result.setdefault("mixer", {})
    if type(mixer) is not dict:
        raise LightCraftError("raw_invalid_settings")
    for color in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"):
        band = mixer.setdefault(color, {})
        if type(band) is not dict:
            raise LightCraftError("raw_invalid_settings")
        for field in ("hue", "sat", "lum"):
            band.setdefault(field, 0.0)
    detail = result.setdefault("detail", {})
    if type(detail) is not dict:
        raise LightCraftError("raw_invalid_settings")
    if "nr_outliers" not in detail:
        detail["nr_outliers"] = False
    elif type(detail["nr_outliers"]) is not bool:
        raise LightCraftError("raw_invalid_settings")
    if "point_colors" in result:
        validate_point_colors(result)
    elif restore_point_colors:
        # Older full snapshots omit this serde-default array; a partial Native merge would retain it.
        result["point_colors"] = []
    return result


def settings_snapshot_for_comparison(settings):
    """Compare legacy omissions as Native serde defaults without changing stored snapshots."""
    result = complete_snapshot_for_merge(settings)
    if "point_colors" not in result:
        result["point_colors"] = []
    validate_point_colors(result)
    return with_legacy_mixer_defaults(with_legacy_profile_defaults(result))


def validate_point_colors(settings):
    """Validate Native Point Color data without normalizing it or changing its order."""
    values = settings.get("point_colors") if type(settings) is dict else None
    if type(values) is not list or len(values) > MAX_POINT_COLORS:
        raise LightCraftError("raw_invalid_point_colors")
    fields = set(POINT_COLOR_CENTER_FIELDS) | {spec[0] for spec in POINT_COLOR_FIELDS.values()}
    for item in values:
        if type(item) is not dict or set(item) != fields:
            raise LightCraftError("raw_invalid_point_colors")
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in item.values()):
            raise LightCraftError("raw_invalid_point_colors")
        if not 0 <= item["lum"] <= 1 or item["chroma"] < 0 or not 0 <= item["hue"] < 360:
            raise LightCraftError("raw_invalid_point_colors")
        for field, low, high, _default in POINT_COLOR_FIELDS.values():
            if not low <= item[field] <= high:
                raise LightCraftError("raw_invalid_point_colors")
    return values


def validate_point_color_control(control_id, count=None):
    """Validate indexed control syntax, optionally requiring an existing entry."""
    if type(control_id) is not str:
        raise LightCraftError("raw_invalid_point_color_control")
    match = re.fullmatch(r"pointColor\.(0|[1-9][0-9]*)\.([A-Za-z]+)", control_id)
    if match is None:
        raise LightCraftError("raw_invalid_point_color_control")
    index_text, field = match.group(1), match.group(2)
    if field not in POINT_COLOR_FIELDS:
        raise LightCraftError("raw_invalid_point_color_control")
    try:
        index = int(index_text)
    except ValueError:
        raise LightCraftError("raw_invalid_point_color_control") from None
    if count is not None and (type(count) is not int or not 0 <= count <= MAX_POINT_COLORS or index >= count):
        raise LightCraftError("raw_invalid_point_color_control")
    return index, POINT_COLOR_FIELDS[field]


def validate_point_color_value(field, value):
    spec = POINT_COLOR_FIELDS.get(field)
    if spec is None or type(value) not in (int, float) or not math.isfinite(value) or not spec[1] <= value <= spec[2]:
        raise LightCraftError("raw_invalid_controls")
    return value


def validate_point_color_coordinates(x, y):
    if any(type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1 for value in (x, y)):
        raise LightCraftError("raw_invalid_point_color_coordinates")
    return x, y


def validate_point_color_delete(index, count=None):
    if type(index) is not int or index < 0:
        raise LightCraftError("raw_invalid_point_color_index")
    if count is not None and (type(count) is not int or not 0 <= count <= MAX_POINT_COLORS or index >= count):
        raise LightCraftError("raw_invalid_point_color_index")
    return index


def validate_point_color_append(count):
    if type(count) is not int or not 0 <= count < MAX_POINT_COLORS:
        raise LightCraftError("raw_point_color_limit")


POINT_COLOR_HISTORY_SCHEMAS = {
    "pointColorPick": frozenset(("x", "y")),
    "pointColorDelete": frozenset(("index",)),
    "pointColorControl": frozenset(("control", "value")),
    "pointColorControlReset": frozenset(("control",)),
    "pointColorReset": frozenset(),
}


def validate_point_color_history_operation(kind, metadata):
    """Validate and canonicalize Point Color History metadata without consulting Native state."""
    import json
    if type(kind) is not str or kind not in POINT_COLOR_HISTORY_SCHEMAS or type(metadata) is not dict or \
            set(metadata) != POINT_COLOR_HISTORY_SCHEMAS[kind]:
        raise LightCraftError("raw_invalid_request")
    try:
        if kind == "pointColorPick":
            x, y = validate_point_color_coordinates(metadata["x"], metadata["y"])
            normalized = {"x": x, "y": y}
        elif kind == "pointColorDelete":
            normalized = {"index": validate_point_color_delete(metadata["index"])}
        elif kind in ("pointColorControl", "pointColorControlReset"):
            control = metadata["control"]
            validate_point_color_control(control)
            normalized = {"control": control}
            if kind == "pointColorControl":
                field = control.rsplit(".", 1)[1]
                normalized["value"] = validate_point_color_value(field, metadata["value"])
        else:
            normalized = {}
    except (LightCraftError, TypeError, ValueError, OverflowError):
        raise LightCraftError("raw_invalid_request") from None
    # Match the store's stable JSON normalization without rounding numeric metadata.
    try:
        return json.loads(json.dumps(normalized, sort_keys=True, separators=(",", ":"), allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        raise LightCraftError("raw_invalid_request") from None


def with_legacy_mixer_defaults(settings):
    """Use LightCraft's HSL defaults when an older full snapshot omitted the mixer."""
    mixer = settings.get("mixer")
    if mixer is not None and type(mixer) is not dict:
        raise LightCraftError("raw_invalid_settings")
    mixer = {} if mixer is None else mixer
    result = {}
    for color in ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"):
        band = mixer.get(color, {})
        if type(band) is not dict:
            raise LightCraftError("raw_invalid_settings")
        result[color] = {field: band.get(field, 0.0) for field in ("hue", "sat", "lum")}
    if all(color in mixer and all(field in mixer[color] for field in ("hue", "sat", "lum")) for color in result):
        return settings
    return {**settings, "mixer": {**mixer, **{color: {**mixer.get(color, {}), **values}
                                                 for color, values in result.items()}}}


def control_location(settings, control):
    # Grading wheels are nested; preserve the native DevelopSettings shape everywhere.
    *parents, key = CONTROL_PATHS[control]
    value = settings
    for parent in parents:
        value = value.get(parent, {}) if isinstance(value, dict) else {}
    return value if isinstance(value, dict) else {}, key


def with_legacy_grading_defaults(settings):
    # Older full snapshots may omit this serde-default section. Do not rewrite stored
    # receipts or existing (including global) values; normalize only the engine view.
    if "grading" in settings:
        return settings
    return {**settings, "grading": {
        **{band: {"hue": 0., "sat": 0., "lum": 0.} for band in ("shadows", "midtones", "highlights", "global")},
        "blending": 50., "balance": 0.}}


def with_legacy_optics_defaults(settings):
    # Older recipes can omit this new serde-default section; keep persisted snapshots and receipts untouched.
    optics = settings.get("optics")
    if optics is not None and type(optics) is not dict:
        return settings
    defaults = {CONTROL_PATHS[control][1]: spec[3] for control, spec in CONTROLS.items()
                if control.startswith("optics.")}
    defaults.update(remove_ca=False, lens_profile=False)
    if optics is None:
        return {**settings, "optics": defaults}
    missing = defaults.keys() - optics.keys()
    return {**settings, "optics": {**{key: defaults[key] for key in missing}, **optics}} if missing else settings


def with_legacy_profile_defaults(settings):
    profile = settings.get("profile")
    if profile is not None and type(profile) is not dict:
        return settings
    if profile is None:
        profile = {}
    profile = {"id": "lc.color", "amount": 100., **profile}
    value = profile.get("camera_local_tone", False)
    if type(value) is not bool:
        raise LightCraftError("raw_invalid_settings")
    return {**settings, "profile": {**profile, "camera_local_tone": value}}


def with_legacy_curve_defaults(settings):
    # Native serde defaults old snapshots, but full readback comparisons need the same engine view.
    if "curve" not in settings:
        return {**settings, "curve": {"highlights": 0.0, "lights": 0.0, "darks": 0.0, "shadows": 0.0,
            "split_shadows": 25.0, "split_mid": 50.0, "split_highlights": 75.0,
            **{channel: [] for channel in CURVE_CHANNELS}, "refine_saturation": 100.0}}
    return settings


def validate_curve_settings(settings):
    """Reject malformed explicit ToneCurve snapshots; only an absent section is legacy-defaulted."""
    curve = settings.get("curve") if type(settings) is dict else None
    if type(curve) is not dict or set(curve) != CURVE_SETTING_FIELDS:
        raise LightCraftError("raw_invalid_settings")
    if any(type(curve[field]) not in (int, float) or not math.isfinite(curve[field])
           for field in CURVE_NUMERIC_FIELDS):
        raise LightCraftError("raw_invalid_settings")
    curve_readback(settings)
    return curve


def validate_curve_operation(kind, metadata):
    import json
    if kind == "curve":
        if type(metadata) is not dict or set(metadata) != {"channel", "points"}:
            raise LightCraftError("raw_invalid_request")
        if len(json.dumps(metadata, separators=(",", ":")).encode()) > MAX_CURVE_BYTES:
            raise LightCraftError("raw_invalid_request")
        validate_curve_input(metadata["channel"], metadata["points"])
        return
    if kind == "curveReset" and type(metadata) is dict and set(metadata) == {"channel"} and metadata["channel"] in (*CURVE_CHANNELS, "point"):
        return
    raise LightCraftError("raw_invalid_request")


def validate_curve_input(channel, points):
    """Validate Native command pair-array input; Native readback uses object points instead."""
    import json
    if type(channel) is not str or channel not in CURVE_CHANNELS or type(points) is not list or len(points) > MAX_CURVE_POINTS:
        raise LightCraftError("raw_invalid_request")
    if len(json.dumps({"channel": channel, "points": points}, separators=(",", ":")).encode("utf-8")) > MAX_CURVE_BYTES:
        raise LightCraftError("raw_invalid_request")
    for point in points:
        if type(point) is not list or len(point) != 2 or any(
                type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1
                for value in point):
            raise LightCraftError("raw_invalid_request")
    return points


def curve_readback(settings):
    """Validate Native DevelopSettings object points before publishing pair-array API values."""
    curve = settings.get("curve") if type(settings) is dict else None
    if type(curve) is not dict:
        raise LightCraftError("raw_invalid_settings")
    result = {}
    for channel in CURVE_CHANNELS:
        points = curve.get(channel)
        if type(points) is not list or len(points) > MAX_CURVE_POINTS:
            raise LightCraftError("raw_invalid_settings")
        converted = []
        for point in points:
            if type(point) is not dict or set(point) != {"x", "y"}:
                raise LightCraftError("raw_invalid_settings")
            x, y = point["x"], point["y"]
            if any(type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1 for value in (x, y)):
                raise LightCraftError("raw_invalid_settings")
            converted.append({"x": x, "y": y})
        result[channel] = converted
    return result


def controls_state(snapshot):
    settings = snapshot.settings
    values = {}
    for control in CONTROLS:
        parent, key = control_location(settings, control)
        value = parent.get(key, CONTROLS[control][3] if control.startswith("mixer.") else None)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise LightCraftError("raw_invalid_settings")
        values[control] = value
    wb = settings.get("wb", {})
    style = settings.get("vignette", {}).get("style")
    if type(style) is not str or style not in VIGNETTE_STYLES:
        raise LightCraftError("raw_invalid_settings")
    disabled = settings.get("disabled_sections", [])
    if type(disabled) is not list or any(type(section) is not str for section in disabled):
        raise LightCraftError("raw_invalid_settings")
    from raw_geometry import geometry_state
    optics = settings.get("optics", {})
    flags = {name: optics.get(name) for name in ("remove_ca", "lens_profile")}
    if any(type(value) is not bool for value in flags.values()):
        raise LightCraftError("raw_invalid_settings")
    profile = settings.get("profile", {})
    camera_local_tone = profile.get("camera_local_tone", False) if type(profile) is dict else None
    if type(camera_local_tone) is not bool:
        raise LightCraftError("raw_invalid_settings")
    lens_info = snapshot.lens_profile_info
    lens_applied = False
    if flags["lens_profile"] and "optics" not in disabled:
        if lens_info.get("profileAvailable") is None:
            lens_applied = None
        elif lens_info["profileAvailable"] is True:
            lens_applied = bool(
                lens_info["profileHasDistortion"] and optics.get("profile_distortion", 0) > 0
                or lens_info["profileHasVignetting"] and optics.get("profile_vignetting", 0) > 0)
    public_lens_info = {key: value for key, value in lens_info.items()
                        if key not in ("profileHasDistortion", "profileHasVignetting")}
    public_lens_info["profileApplied"] = lens_applied
    curve_points = curve_readback(settings)
    wb_scale = wb.get("scale", "legacy")
    wb_available = wb_scale in ("kelvin", "legacy")
    return {**geometry_state(settings), "values": values, "curve": curve_points, "opticsFlags": flags,
            "cameraLocalTone": camera_local_tone, "vignetteStyle": style, "wbAutoAvailable": snapshot.wb_auto and wb_available,
            "lensProfileInfo": public_lens_info,
            "sections": {section: section not in disabled for section in SETTINGS_SECTIONS},
            "controls": [dict(id=key, min=v[0], max=v[1], step=v[2], default=v[3], precision=v[4])
                                           for key, v in CONTROLS.items()],
            "wb": {"available": wb_available,
                   "mode": wb.get("mode", "asShot"), "scale": wb_scale}, "process": settings["process"]}


def mixer_target_readback(value, target, *, snapshot=False):
    """Validate Native's mixer-only changed-control map or full settings readback."""
    if target not in ("hue", "sat", "lum") or type(target) is not str or type(value) is not dict:
        raise LightCraftError("raw_invalid_settings" if snapshot else "raw_invalid_response")
    result = {}
    if snapshot:
        for control, spec in CONTROLS.items():
            if not control.startswith("mixer."):
                continue
            parent, key = control_location(value, control)
            number = parent.get(key, spec[3])
            if type(number) not in (int, float) or not math.isfinite(number) or not spec[0] <= number <= spec[1]:
                raise LightCraftError("raw_invalid_settings")
        return result
    if not value or len(value) > 24:
        raise LightCraftError("raw_invalid_response")
    for control, number in value.items():
        if type(control) is not str or not control.startswith("mixer.") or control not in CONTROLS or \
                not control.endswith(f".{target}") or type(number) not in (int, float) or \
                not math.isfinite(number) or not CONTROLS[control][0] <= number <= CONTROLS[control][1]:
            raise LightCraftError("raw_invalid_response")
        result[control] = number
    return result


def validate_controls(values, wb_available):
    if not isinstance(values, dict) or not 1 <= len(values) <= len(CONTROLS) + 2:
        raise LightCraftError("raw_invalid_controls")
    has_optics_flag = any(key in ("optics.remove_ca", "optics.lens_profile") for key in values)
    if has_optics_flag and any(not key.startswith("optics.") for key in values):
        raise LightCraftError("raw_invalid_controls")
    for key, value in values.items():
        if key in ("optics.remove_ca", "optics.lens_profile"):
            if type(value) is not bool:
                raise LightCraftError("raw_invalid_controls")
            continue
        if key not in CONTROLS or type(value) not in (int, float) or not math.isfinite(value):
            raise LightCraftError("raw_invalid_controls")
        lo, hi, *_ = CONTROLS[key]
        if not lo <= value <= hi:
            raise LightCraftError("raw_invalid_controls")
        if key.startswith("wb.") and not wb_available:
            raise LightCraftError("raw_wb_unavailable")
    return values


def validate_history_operation(kind, metadata):
    if type(metadata) is not dict:
        raise LightCraftError("raw_invalid_request")
    if kind == 'geometry':
        from raw_geometry import valid_metadata
        if not valid_metadata(metadata):
            raise LightCraftError('raw_invalid_request')
        return
    valid = (kind == "controlReset" and set(metadata) == {"control"}
             and type(metadata["control"]) is str and metadata["control"] in HISTORY_CONTROLS
             or kind == "sectionReset" and set(metadata) == {"section"}
             and type(metadata["section"]) is str and metadata["section"] in RESET_SECTIONS
             or kind == "sectionToggle" and set(metadata) == {"section", "enabled"}
             and type(metadata["section"]) is str and metadata["section"] in SETTINGS_SECTIONS
             and type(metadata["enabled"]) is bool
             or kind == "opticsFlag" and set(metadata) == {"control", "enabled"}
             and type(metadata["control"]) is str and metadata["control"] in HISTORY_FLAG_CONTROLS
             and type(metadata["enabled"]) is bool
             or kind == "opticsFlagReset" and set(metadata) == {"control"}
             and type(metadata["control"]) is str and metadata["control"] in HISTORY_FLAG_CONTROLS
             or kind == "vignetteStyle" and set(metadata) == {"style"}
             and type(metadata["style"]) is str and metadata["style"] in VIGNETTE_STYLES
             or kind == "curve" and set(metadata) == {"channel"}
             and type(metadata["channel"]) is str and metadata["channel"] in CURVE_CHANNELS
             or kind == "curveReset" and set(metadata) == {"channel"}
             and type(metadata["channel"]) is str and metadata["channel"] in (*CURVE_CHANNELS, "point")
             or kind == "mixerTarget" and set(metadata) == {"target"}
             and type(metadata["target"]) is str and metadata["target"] in ("hue", "sat", "lum")
             or kind in ("colorReset", "wbReset") and not metadata
             or kind in ("allReset", "wbAuto", "wbPick") and not metadata)
    if not valid:
        raise LightCraftError("raw_invalid_request")
