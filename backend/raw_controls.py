"""RAW allowlist from LightCraft v0.17.0 develop/src/controls.rs; never JPEG Recipe values."""

import math

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

SECTIONS = ("light", "color", "grading", "effects", "detail")
SETTINGS_SECTIONS = (*SECTIONS, "optics")
HISTORY_CONTROLS = frozenset(control for control in CONTROLS if not control.startswith("optics."))
# Vignette has a Native reset section, but its eye belongs to Effects.
RESET_SECTIONS = (*SECTIONS, "vignette")
VIGNETTE_STYLES = ("highlightPriority", "colorPriority", "paintOverlay")
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
}
# A native Detail reset includes controls not exposed by GenzoRoom yet.
DETAIL_RESET_DEFAULTS = dict(sharpen_amount=0, sharpen_radius=1, sharpen_detail=25, sharpen_masking=0,
    nr_luminance=0, nr_detail=50, nr_contrast=0, nr_color=0, nr_color_detail=50, nr_color_smoothness=50)


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


def controls_state(snapshot):
    settings = snapshot.settings
    values = {}
    for control in CONTROLS:
        parent, key = control_location(settings, control)
        value = parent.get(key)
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
    return {**geometry_state(settings), "values": values, "opticsFlags": flags, "vignetteStyle": style, "wbAutoAvailable": snapshot.wb_auto and snapshot.wb_kelvin,
            "sections": {section: section not in disabled for section in SETTINGS_SECTIONS},
            "controls": [dict(id=key, min=v[0], max=v[1], step=v[2], default=v[3], precision=v[4])
                                           for key, v in CONTROLS.items()],
            "wb": {"available": snapshot.wb_kelvin and wb.get("scale") == "kelvin",
                   "mode": wb.get("mode", "asShot"), "scale": wb.get("scale", "legacy")}, "process": settings["process"]}


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
             and type(metadata["section"]) is str and metadata["section"] in SECTIONS
             and type(metadata["enabled"]) is bool
             or kind == "vignetteStyle" and set(metadata) == {"style"}
             and type(metadata["style"]) is str and metadata["style"] in VIGNETTE_STYLES
             or kind in ("allReset", "wbAuto", "wbPick") and not metadata)
    if not valid:
        raise LightCraftError("raw_invalid_request")
