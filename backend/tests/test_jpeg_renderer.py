import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

from edit_state import BOUNDS, FLAGS, InvalidEditState
from jpeg_renderer import JpegRenderer, _bytes
from rendered_image import RenderedImage, Renderer


def recipe(**changes):
    result = {"version": 18, "adjustments": {key: 0 for key in BOUNDS},
              "adjustmentEnabled": {key: True for key in BOUNDS},
              **{flag: True for flag in FLAGS}}
    result["adjustments"].update(changes)
    return result


def compatibility_pixels():
    # Reproduce the frontend LCG and grayscale tail, including original alpha bytes.
    pixels = bytearray()
    seed = 17
    for _ in range(4096):
        seed = (seed * 1664525 + 1013904223) & 0xffffffff
        pixels.extend((seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, seed >> 24))
    for value in range(256):
        pixels.extend((value,) * 4)
    return bytes(pixels)


CASES = json.loads((Path(__file__).parent / "fixtures/jpeg_recipe_compatibility.json").read_text())["cases"]


class JpegRendererTests(unittest.TestCase):
    def setUp(self):
        self.rgba = compatibility_pixels()
        self.source = RenderedImage(256, 17, np.frombuffer(self.rgba, np.uint8).reshape(-1, 4)[:, :3].tobytes())
        self.renderer: Renderer = JpegRenderer()

    def test_frozen_frontend_hashes(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                settings = recipe(**case["adjustments"])
                original = copy.deepcopy(settings)
                result = self.renderer.render(self.source, settings)
                rgba = np.frombuffer(self.rgba, np.uint8).reshape(-1, 4).copy()
                rgba[:, :3] = np.frombuffer(result.pixels, np.uint8).reshape(-1, 3)
                self.assertEqual(hashlib.sha256(rgba.tobytes()).hexdigest(), case["hash"])
                self.assertEqual(self.source.pixels, rgba_source_rgb(self.rgba))
                self.assertEqual(settings, original)
                self.assertEqual((result.width, result.height), (256, 17))

    def test_each_group_bypasses_only_its_members(self):
        groups = {
            "whiteBalanceEnabled": ("temperature", "tint"),
            "basicEnabled": ("exposure", "contrast", "highlights", "whites", "shadows", "blacks"),
            "colorGradingEnabled": ("shadowsTemperature", "shadowsTint", "midtonesTemperature", "midtonesTint", "highlightsTemperature", "highlightsTint"),
            "gradingShadowsEnabled": ("shadowsTemperature", "shadowsTint"),
            "gradingMidtonesEnabled": ("midtonesTemperature", "midtonesTint"),
            "gradingHighlightsEnabled": ("highlightsTemperature", "highlightsTint"),
            "colorEnabled": ("vibrance", "saturation"),
        }
        mixed = next(case["adjustments"] for case in CASES if case["name"] == "all sixteen adjustments")
        for flag, members in groups.items():
            with self.subTest(flag=flag):
                settings = recipe(**mixed)
                settings[flag] = False
                expected = recipe(**{**mixed, **dict.fromkeys(members, 0)})
                self.assertEqual(self.renderer.render(self.source, settings), self.renderer.render(self.source, expected))

    def test_each_individual_bypass_and_category_precedence(self):
        mixed = next(case["adjustments"] for case in CASES if case["name"] == "all sixteen adjustments")
        for key in BOUNDS:
            with self.subTest(key=key):
                settings = recipe(**mixed)
                settings["adjustmentEnabled"][key] = False
                expected = recipe(**{**mixed, key: 0})
                self.assertEqual(self.renderer.render(self.source, settings), self.renderer.render(self.source, expected))
        settings = recipe(**mixed)
        for flag in FLAGS:
            settings[flag] = False
        self.assertEqual(self.renderer.render(self.source, settings), self.source)
        settings = recipe(**mixed)
        settings["adjustmentEnabled"] = dict.fromkeys(BOUNDS, False)
        self.assertEqual(self.renderer.render(self.source, settings), self.source)
        settings = recipe(shadowsTemperature=100, shadowsTint=100)
        settings["colorGradingEnabled"] = False
        self.assertEqual(self.renderer.render(self.source, settings), self.source)

    def test_chunk_boundaries_preserve_pixels_and_source(self):
        settings = recipe(**next(case["adjustments"] for case in CASES if case["name"] == "all sixteen adjustments"))
        large = RenderedImage(256 * 5, 17, self.source.pixels * 5)
        result = self.renderer.render(large, settings)
        self.assertEqual(result.pixels, self.renderer.render(self.source, settings).pixels * 5)
        self.assertEqual(large.pixels, self.source.pixels * 5)
        with patch("jpeg_renderer._CHUNK_PIXELS", 7):
            self.assertEqual(self.renderer.render(self.source, settings).pixels, result.pixels[:len(self.source.pixels)])

    def test_js_round_ties_and_adjacent_values(self):
        result = _bytes(np.array([0.5, 2.5, 254.5, np.nextafter(0.5, 0), np.nextafter(2.5, 0)]))
        self.assertEqual(result.tolist(), [1, 3, 255, 0, 2])

    def test_invalid_recipes_fail_before_rendering(self):
        for change in ({"version": 17}, {"adjustments": {}}, {"basicEnabled": 1}):
            with self.subTest(change=change), self.assertRaises(InvalidEditState):
                self.renderer.render(self.source, {**recipe(), **change})
        settings = recipe(exposure=float("nan"))
        with self.assertRaises(InvalidEditState):
            self.renderer.render(self.source, settings)

    def test_image_boundary_rejects_invalid_dimensions_and_buffers(self):
        for width, height, pixels in ((0, 1, b""), (True, 1, b"123"), (1, 1, b"12"), (1, 1, bytearray(b"123"))):
            with self.subTest(width=width, height=height), self.assertRaises(ValueError):
                RenderedImage(width, height, pixels)


def rgba_source_rgb(rgba):
    return np.frombuffer(rgba, np.uint8).reshape(-1, 4)[:, :3].tobytes()
