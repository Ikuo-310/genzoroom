from io import BytesIO
import unittest
from unittest.mock import patch

from PIL import Image, ImageCms, JpegImagePlugin

from jpeg_codec import JpegCodecError, decode_jpeg, encode_jpeg
from rendered_image import RenderedImage
from jpeg_renderer import JpegRenderer
from tests.test_jpeg_renderer import recipe


def srgb_profile():
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def swapped_primaries_profile():
    # A valid RGB matrix profile with different primaries exercises real conversion,
    # rather than allowing an identity sRGB transform to hide discarded ICC data.
    profile = bytearray(srgb_profile())
    tags = {}
    for index in range(int.from_bytes(profile[128:132], "big")):
        entry = 132 + index * 12
        signature = bytes(profile[entry:entry + 4])
        offset = int.from_bytes(profile[entry + 4:entry + 8], "big")
        size = int.from_bytes(profile[entry + 8:entry + 12], "big")
        tags[signature] = (offset, size)
    red, red_size = tags[b"rXYZ"]
    blue, blue_size = tags[b"bXYZ"]
    assert red_size == blue_size
    profile[red:red + red_size], profile[blue:blue + blue_size] = \
        profile[blue:blue + blue_size], profile[red:red + red_size]
    return bytes(profile)


def jpeg(*, mode="RGB", profile=None, orientation=None):
    output = BytesIO()
    color = (180, 40, 80) if mode == "RGB" else (10, 20, 30, 40) if mode == "CMYK" else 123
    with Image.new(mode, (11, 7), color) as image:
        # Asymmetric pixels make all rotations and reflections observable.
        image.putpixel((0, 0), (0, 255, 0) if mode == "RGB" else color)
        options = {"quality": 95, "subsampling": 0}
        if profile is not None:
            options["icc_profile"] = profile
        if orientation is not None:
            exif = Image.Exif()
            exif[274] = orientation
            options["exif"] = exif
        image.save(output, "JPEG", **options)
    return output.getvalue()


class JpegCodecTests(unittest.TestCase):
    def test_untagged_rgb_and_grayscale(self):
        for mode in ("RGB", "L"):
            with self.subTest(mode=mode):
                data = jpeg(mode=mode)
                result = decode_jpeg(data)
                with Image.open(BytesIO(data)) as image:
                    self.assertEqual(result.pixels, image.convert("RGB").tobytes())
                self.assertEqual((result.width, result.height), (11, 7))

    def test_embedded_srgb_uses_color_management(self):
        with patch("jpeg_codec.ImageCms.profileToProfile", wraps=ImageCms.profileToProfile) as transform:
            result = decode_jpeg(jpeg(profile=srgb_profile()))
            transform.assert_called_once()
            self.assertEqual(transform.call_args.kwargs["outputMode"], "RGB")
        self.assertEqual(len(result.pixels), 11 * 7 * 3)

    def test_non_srgb_embedded_rgb_profile_changes_colors(self):
        profile = swapped_primaries_profile()
        data = jpeg(profile=profile)
        result = decode_jpeg(data)
        with Image.open(BytesIO(data)) as source:
            expected = ImageCms.profileToProfile(
                source, ImageCms.ImageCmsProfile(BytesIO(profile)),
                ImageCms.ImageCmsProfile(BytesIO(srgb_profile())), outputMode="RGB")
            with expected:
                self.assertEqual(result.pixels, expected.tobytes())
            self.assertNotEqual(result.pixels, source.tobytes())
        self.assertEqual((result.width, result.height), (11, 7))

    def test_all_exif_orientations_apply_to_pixels(self):
        methods = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
                   4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
                   6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE,
                   8: Image.Transpose.ROTATE_90}
        for orientation in range(1, 9):
            with self.subTest(orientation=orientation):
                data = jpeg(orientation=orientation)
                result = decode_jpeg(data)
                with Image.open(BytesIO(data)) as original:
                    expected = original.copy() if orientation == 1 else original.transpose(methods[orientation])
                    with expected:
                        self.assertEqual((result.width, result.height), expected.size)
                        self.assertEqual(result.pixels, expected.tobytes())

    def test_non_jpeg_malformed_and_truncated_fail(self):
        png = BytesIO()
        Image.new("RGB", (2, 2)).save(png, "PNG")
        for data in (b"", b"not an image", b"\xff\xd8garbage", jpeg()[:-20], png.getvalue()):
            with self.subTest(size=len(data)), self.assertRaises(JpegCodecError):
                decode_jpeg(data)

    def test_invalid_and_unusable_profiles_fail(self):
        lab = ImageCms.ImageCmsProfile(ImageCms.createProfile("LAB")).tobytes()
        for profile in (b"invalid profile", lab):
            with self.subTest(profile_size=len(profile)), self.assertRaises(JpegCodecError) as raised:
                decode_jpeg(jpeg(profile=profile))
            self.assertEqual(raised.exception.code, "invalid_icc_profile")
        with patch("jpeg_codec.ImageCms.profileToProfile", side_effect=ImageCms.PyCMSError("unavailable")):
            with self.assertRaises(JpegCodecError) as raised:
                decode_jpeg(jpeg(profile=srgb_profile()))
            self.assertEqual(raised.exception.code, "invalid_icc_profile")

    def test_untagged_cmyk_fails_without_guessed_conversion(self):
        with self.assertRaises(JpegCodecError) as raised:
            decode_jpeg(jpeg(mode="CMYK"))
        self.assertEqual(raised.exception.code, "unsupported_jpeg_color_space")

    def test_encoder_fixed_settings_rgb_dimensions_and_icc(self):
        source = RenderedImage(11, 7, bytes([180, 40, 80]) * 77)
        original_save = Image.Image.save
        calls = []

        def save(image, output, **options):
            calls.append((image.mode, image.size, options))
            return original_save(image, output, **options)

        with patch.object(Image.Image, "save", save):
            encoded = encode_jpeg(source)
        self.assertEqual(calls[0][:2], ("RGB", (11, 7)))
        self.assertEqual(calls[0][2]["quality"], 95)
        self.assertEqual(calls[0][2]["subsampling"], 0)
        self.assertEqual(calls[0][2]["format"], "JPEG")
        with Image.open(BytesIO(encoded)) as image:
            image.load()
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (11, 7))
            self.assertEqual(JpegImagePlugin.get_sampling(image), 0)
            profile = ImageCms.ImageCmsProfile(BytesIO(image.info["icc_profile"]))
            self.assertIn("sRGB", ImageCms.getProfileDescription(profile))
            self.assertEqual(dict(image.getexif()), {})
            self.assertNotIn("xmp", image.info)

    def test_decode_render_encode_keeps_normalized_size_and_discards_source_metadata(self):
        source = decode_jpeg(jpeg(profile=srgb_profile(), orientation=6))
        rendered = JpegRenderer().render(source, recipe(exposure=0.5))
        with Image.open(BytesIO(encode_jpeg(rendered))) as image:
            image.load()
            self.assertEqual(image.size, (7, 11))
            self.assertIn("icc_profile", image.info)
            self.assertEqual(dict(image.getexif()), {})

    def test_encode_failure_is_explicit(self):
        with patch.object(Image.Image, "save", side_effect=OSError("encoder unavailable")):
            with self.assertRaises(JpegCodecError) as raised:
                encode_jpeg(RenderedImage(1, 1, b"\x00\x00\x00"))
            self.assertEqual(raised.exception.code, "jpeg_encode_failed")
