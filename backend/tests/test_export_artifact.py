from datetime import datetime, timedelta, timezone
from io import BytesIO
import unittest
from unittest.mock import Mock, patch
import struct
import warnings
import xml.etree.ElementTree as ET

from PIL import ExifTags, Image, ImageCms, JpegImagePlugin, TiffImagePlugin

from export_artifact import create_export_artifact, filename_family, next_export_filename
from jpeg_codec import JpegCodecError, decode_jpeg, encode_jpeg
from jpeg_metadata import DC, RDF, XMP, MAX_TEXT_BYTES, MAX_EXIF_BYTES, MAX_XMP_BYTES, _preserve_exif
from rendered_image import RenderedImage
from tests.test_jpeg_codec import swapped_primaries_profile


B, G = ExifTags.Base, ExifTags.GPS
STAMP = datetime(2026, 10, 7, 23, 59, 59, 900000, tzinfo=timezone(timedelta(hours=9)))
RGB = RenderedImage(7, 11, bytes([120, 70, 30]) * 77)


def jpeg(exif=None, xmp=None, profile=None):
    output = BytesIO()
    with Image.new("RGB", (11, 7), (120, 70, 30)) as image:
        image.save(output, "JPEG", exif=exif or b"", xmp=xmp or b"", icc_profile=profile)
    return output.getvalue()


def artifact(source=None, timestamp=STAMP):
    return create_export_artifact(source or jpeg(), "IMG.JPG", [], RGB, timestamp=timestamp)


def xmp(properties="", attributes=""):
    return (f'<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="{RDF}" '
            f'xmlns:dc="{DC}" xmlns:xmp="{XMP}" xmlns:private="urn:private">'
            f'<rdf:RDF><rdf:Description {attributes}>{properties}</rdf:Description>'
            '</rdf:RDF></x:xmpmeta>').encode()


class FilenameTests(unittest.TestCase):
    def test_phase0_frontend_filename_family_correspondence(self):
        # Corresponding fixtures lock stackCandidateDetection.filenameFamily first-dot semantics.
        cases = {"IMG_1234.JPG": "IMG_1234", "IMG_1234.edit.jpg": "IMG_1234",
                 "IMG_1234-Genzo03.jpg": "IMG_1234", "IMG_1234-Genzo3.extra.jpg": "IMG_1234",
                 "foo.bar.baz": "foo", "foo.jpg": "foo", "Foo.JPG": "Foo",
                 "IMG-Genzo.jpg": "IMG-Genzo", "IMG-GenzoX.jpg": "IMG-GenzoX",
                 "IMG-Genzo01-extra.jpg": "IMG-Genzo01-extra", "a-Genzo1-Genzo02.jpg": "a-Genzo1",
                 "": None, ".jpg": None, "a": None, "a.": None, "a.b.": None,
                 " \t.jpg": None, "\ufeff-Genzo01.jpg": None, "-Genzo01.jpg": None}
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(filename_family(name), expected)

    def test_maximum_gaps_source_derivative_and_unrelated_families(self):
        names = ["IMG.JPG", "IMG-Genzo01.jpg", "IMG-Genzo03.extra.JPG", "OTHER-Genzo99.jpg",
                 "img-Genzo100.jpg", "IMG-Genzo50-extra.jpg", "IMG-GenzoX.jpg"]
        before = names.copy()
        self.assertEqual(next_export_filename("IMG-Genzo02.jpg", names), "IMG-Genzo04.jpg")
        self.assertEqual(names, before)
        self.assertEqual(next_export_filename("IMG-Genzo03.jpg", []), "IMG-Genzo04.jpg")

    def test_no_existing_zero_padding_and_carry(self):
        for previous, expected in ((None, "01"), ("0", "01"), ("09", "10"),
                                   ("99", "100"), ("00003", "04")):
            with self.subTest(previous=previous):
                names = [] if previous is None else [f"IMG-Genzo{previous}.jpg"]
                self.assertEqual(next_export_filename("IMG.edit.JPG", iter(names)), f"IMG-Genzo{expected}.jpg")

    def test_giant_decimal_suffix_does_not_depend_on_python_int_conversion(self):
        self.assertEqual(next_export_filename("IMG.jpg", ["IMG-Genzo" + "9" * 5000 + ".jpg"]),
                         "IMG-Genzo1" + "0" * 5000 + ".jpg")

    def test_invalid_roots_and_unsafe_output_names_fail_safely(self):
        for name in ("", ".jpg", "no-extension", "a.", "-Genzo1.jpg", " \t.jpg",
                     "../a.jpg", "dir/photo.jpg", "dir\\photo.jpg", "bad\x00.jpg", "bad:photo.jpg"):
            with self.subTest(name=name), self.assertRaises(JpegCodecError) as raised:
                next_export_filename(name, [])
            self.assertEqual(raised.exception.code, "invalid_export_filename")


class MetadataTests(unittest.TestCase):
    def test_preserve_capture_camera_lens_exposure_user_and_gps(self):
        exif = Image.Exif()
        root = {B.Make: "Camera", B.Model: "Model", B.Artist: "Author",
                B.Copyright: "Copyright", B.ImageDescription: "Caption & <description>"}
        capture = {B.DateTimeOriginal: "2020:02:29 12:34:56", B.OffsetTimeOriginal: "+09:00",
                   B.SubsecTimeOriginal: "123", B.LensMake: "Lens maker", B.LensModel: "Lens model",
                   B.LensSpecification: tuple(TiffImagePlugin.IFDRational(n) for n in (24, 70, 2, 4)),
                   B.ExposureTime: TiffImagePlugin.IFDRational(1, 125), B.FNumber: TiffImagePlugin.IFDRational(28, 10),
                   B.ISOSpeedRatings: 200, B.ExposureBiasValue: TiffImagePlugin.IFDRational(-1, 3),
                   B.ExposureProgram: 3, B.MeteringMode: 5, B.Flash: 0,
                   B.FocalLength: TiffImagePlugin.IFDRational(35), B.FocalLengthIn35mmFilm: 50,
                   B.WhiteBalance: 1, B.LightSource: 1, B.SceneCaptureType: 0,
                   B.ExposureMode: 1, B.DigitalZoomRatio: TiffImagePlugin.IFDRational(1)}
        gps = {G.GPSLatitudeRef: "N", G.GPSLatitude: (35, 30, 10),
               G.GPSLongitudeRef: "E", G.GPSLongitude: (139, 20, 30),
               G.GPSAltitudeRef: 1, G.GPSAltitude: TiffImagePlugin.IFDRational(12),
               G.GPSTimeStamp: (12, 34, 56), G.GPSDateStamp: "2020:02:29",
               G.GPSImgDirectionRef: "T", G.GPSImgDirection: TiffImagePlugin.IFDRational(123)}
        exif.update(root)
        exif[ExifTags.IFD.Exif] = capture
        exif[ExifTags.IFD.GPSInfo] = gps
        with Image.open(BytesIO(artifact(jpeg(exif)).jpeg)) as image:
            actual = image.getexif()
            for tag, value in root.items():
                self.assertEqual(actual[tag], value)
            for tag, value in capture.items():
                self.assertEqual(actual.get_ifd(ExifTags.IFD.Exif)[tag], value)
            for tag, value in gps.items():
                self.assertEqual(actual.get_ifd(ExifTags.IFD.GPSInfo)[tag], bytes([value])
                                 if tag == G.GPSAltitudeRef else value)

    def test_regeneration_removes_private_structural_and_auxiliary_metadata(self):
        exif = Image.Exif()
        exif.update({B.Software: "HDR+ source", B.Orientation: 6, B.ImageWidth: 999, B.ImageLength: 998,
                     B.Make: "Camera", 65000: b"private"})
        exif[ExifTags.IFD.Exif] = {B.BodySerialNumber: "body secret", B.LensSerialNumber: "lens secret",
                                 B.MakerNote: b"private note", B.ExifImageWidth: 999,
                                 B.ExifImageHeight: 998, B.ColorSpace: 65535}
        source_profile = swapped_primaries_profile()
        source = jpeg(exif, xmp('<private:secret>secret</private:secret>'), source_profile)
        # Unapproved APP markers and an appended movie must never survive fresh encoding.
        extra = b"MPF\x00private" + b"\x00" * 10
        source = source[:2] + b"\xff\xe2" + (len(extra) + 2).to_bytes(2, "big") + extra + source[2:] + b"appended MP4"
        with warnings.catch_warnings(record=True) as source_warnings:
            warnings.simplefilter("always")
            rendered = decode_jpeg(source)
            result = create_export_artifact(source, "IMG.jpg", [], rendered, timestamp=STAMP)
        self.assertTrue(any("malformed MPO" in str(warning.message) for warning in source_warnings))
        self.assertEqual(result.filename, "IMG-Genzo01.jpg")
        with Image.open(BytesIO(result.jpeg)) as image:
            image.load()
            output = image.getexif()
            self.assertEqual(set(output), {B.Make, B.Software, B.Orientation, B.DateTime, ExifTags.IFD.Exif})
            self.assertEqual(output[B.Software], "GenzoRoom")
            self.assertEqual(output[B.Orientation], 1)
            self.assertEqual(image.size, (7, 11))
            capture = output.get_ifd(ExifTags.IFD.Exif)
            self.assertEqual(capture, {B.ExifImageWidth: 7, B.ExifImageHeight: 11, B.ColorSpace: 1, B.OffsetTime: "+00:00"})
            self.assertEqual(output.get_ifd(ExifTags.IFD.IFD1), {})
            self.assertNotEqual(image.info["icc_profile"], source_profile)
            profile = ImageCms.ImageCmsProfile(BytesIO(image.info["icc_profile"]))
            self.assertIn("sRGB", ImageCms.getProfileDescription(profile))
        for forbidden in (b"HDR+ source", b"body secret", b"lens secret", b"private", b"MPF", b"appended MP4"):
            self.assertNotIn(forbidden, result.jpeg)

    def test_xmp_user_fields_unicode_escaping_and_same_run_timestamp(self):
        props = ''.join(f'<dc:{name}><rdf:Alt><rdf:li xml:lang="x-default">{text}</rdf:li>'
                        f'<rdf:li xml:lang="ja">日本語</rdf:li></rdf:Alt></dc:{name}>'
                        for name, text in (("title", "Title &amp; &lt;test&gt;"), ("description", "Caption"), ("rights", "Rights")))
        props += '<dc:creator><rdf:Seq><rdf:li>Author</rdf:li><rdf:li>Other</rdf:li></rdf:Seq></dc:creator>'
        props += '<dc:subject><rdf:Bag><rdf:li>Keyword</rdf:li></rdf:Bag></dc:subject>'
        props += '<private:secret>private source</private:secret><xmp:ModifyDate>old date</xmp:ModifyDate>'
        packet = xmp(props, 'xmp:Rating="4" xmp:Label="Blue" xmp:CreatorTool="HDR+"')
        exif = Image.Exif()
        exif[ExifTags.IFD.Exif] = {B.DateTimeOriginal: "2020:02:29 12:34:56"}
        source = jpeg(exif, packet)
        first = artifact(source)
        with Image.open(BytesIO(first.jpeg)) as image:
            output = image.info["xmp"]
            tree = ET.fromstring(output)
            self.assertNotEqual(output, packet)
            self.assertEqual(tree.find(f'.//{{{XMP}}}CreatorTool').text, "GenzoRoom")
            for name in ("ModifyDate", "MetadataDate"):
                self.assertEqual(tree.find(f'.//{{{XMP}}}{name}').text, "2026-10-07T14:59:59.900Z")
            self.assertEqual(image.getexif()[B.DateTime], "2026:10:07 14:59:59")
            self.assertEqual(image.getexif().get_ifd(ExifTags.IFD.Exif)[B.DateTimeOriginal], "2020:02:29 12:34:56")
            for name in ("title", "description", "rights", "creator", "subject"):
                self.assertIsNotNone(tree.find(f'.//{{{DC}}}{name}'))
            self.assertEqual(tree.find(f'.//{{{DC}}}title/{{{RDF}}}Alt/{{{RDF}}}li').text, "Title & <test>")
            self.assertEqual(tree.find(f'.//{{{XMP}}}Rating').text, "4")
            self.assertEqual(tree.find(f'.//{{{XMP}}}Label').text, "Blue")
            self.assertIn(b"&amp; &lt;test&gt;", output)
            self.assertIn("日本語".encode(), output)
            for forbidden in (b"urn:private", b"HDR+", b"private source", b"old date"):
                self.assertNotIn(forbidden, output)
        with Image.open(BytesIO(artifact(source).jpeg)) as image:
            self.assertEqual(image.info["xmp"], output)

    def test_malformed_xmp_dtd_depth_and_individual_field_isolation(self):
        packets = [b"<malformed", b'<!DOCTYPE foo [<!ENTITY secret SYSTEM "file:///private">]><foo>&secret;</foo>',
                   '<!DOCTYPE foo [<!ENTITY secret "expansion">]><foo>&secret;</foo>'.encode("utf-16"),
                   xmp('<private:nested>' * 20 + '</private:nested>' * 20)]
        for packet in packets:
            with self.subTest(packet=packet[:20]), Image.open(BytesIO(artifact(jpeg(xmp=packet)).jpeg)) as image:
                tree = ET.fromstring(image.info["xmp"])
                self.assertEqual(len(tree.find(f'.//{{{RDF}}}Description')), 3)
        packet = xmp('<dc:title>Good</dc:title><dc:subject><private:bad>Bad</private:bad></dc:subject>',
                     'xmp:Rating="NaN" xmp:Label="Good label"')
        with Image.open(BytesIO(artifact(jpeg(xmp=packet)).jpeg)) as image:
            tree = ET.fromstring(image.info["xmp"])
            self.assertIsNotNone(tree.find(f'.//{{{DC}}}title'))
            self.assertIsNone(tree.find(f'.//{{{DC}}}subject'))
            self.assertIsNone(tree.find(f'.//{{{XMP}}}Rating'))
            self.assertEqual(tree.find(f'.//{{{XMP}}}Label').text, "Good label")

    def test_optional_malformed_exif_fields_and_container_fallback(self):
        exif = Image.Exif()
        exif.update({B.Make: "Good", B.Model: "x" * (MAX_TEXT_BYTES + 1)})
        exif[ExifTags.IFD.Exif] = {B.DateTimeOriginal: "invalid date", B.OffsetTimeOriginal: "+99:99",
                                 B.SubsecTimeOriginal: "invalid", B.LensModel: "Good lens"}
        exif[ExifTags.IFD.GPSInfo] = {G.GPSLatitudeRef: "X", G.GPSLatitude: (90, 61, 0), G.GPSLongitudeRef: "E"}
        with Image.open(BytesIO(artifact(jpeg(exif)).jpeg)) as image:
            output = image.getexif()
            self.assertEqual(output[B.Make], "Good")
            self.assertNotIn(B.Model, output)
            capture = output.get_ifd(ExifTags.IFD.Exif)
            self.assertEqual(capture[B.LensModel], "Good lens")
            self.assertNotIn(B.DateTimeOriginal, capture)
            self.assertNotIn(B.OffsetTimeOriginal, capture)
            self.assertNotIn(B.SubsecTimeOriginal, capture)
            self.assertEqual(output.get_ifd(ExifTags.IFD.GPSInfo), {G.GPSLongitudeRef: "E"})
        broken = Mock()
        broken.getexif.side_effect = OSError("private exception")
        self.assertEqual(_preserve_exif(broken), ({}, {}, {}))
        # Inject only at optional extraction; decoder validation still runs normally.
        with patch("jpeg_metadata._preserve_exif", side_effect=lambda image: _preserve_exif(broken)):
            self.assertTrue(artifact(jpeg(exif)).jpeg.startswith(b"\xff\xd8"))

    def test_actual_corrupt_exif_container_falls_back_after_successful_jpeg_validation(self):
        for raw in (b"Exif\x00\x00garbage", b"Exif\x00\x00II\x2a\x00\xff\xff\xff\x7f"):
            with self.subTest(raw=raw), warnings.catch_warnings(record=True):
                source = jpeg(raw)
                result = artifact(source)
                with Image.open(BytesIO(result.jpeg)) as image:
                    self.assertEqual(image.getexif()[B.Software], "GenzoRoom")
                    self.assertEqual(image.getexif()[B.Orientation], 1)

    def test_metadata_bounds_and_safe_errors(self):
        for keyword, limit in (("exif", MAX_EXIF_BYTES), ("xmp", MAX_XMP_BYTES)):
            with self.subTest(keyword=keyword), self.assertRaises(JpegCodecError) as raised:
                encode_jpeg(RGB, **{keyword: b"a" * (limit + 1)})
            self.assertEqual(raised.exception.code, "metadata_too_large")
        # Individually permitted fields may exceed the APP1 aggregate after regeneration.
        text = "x" * MAX_TEXT_BYTES
        packet = xmp(''.join(f'<dc:{name}>{text}</dc:{name}>' for name in ("title", "description", "rights")))
        with Image.open(BytesIO(artifact(jpeg(xmp=packet)).jpeg)) as image:
            self.assertLessEqual(len(image.info["xmp"]), MAX_XMP_BYTES)
        large_values = {f"{{{DC}}}{name}": [("x-default", "&" * MAX_TEXT_BYTES)]
                        for name in ("title", "description", "rights")}
        with patch("jpeg_metadata._preserve_xmp", return_value=large_values), self.assertRaises(JpegCodecError) as raised:
            artifact()
        self.assertEqual(raised.exception.code, "metadata_too_large")
        large_exif = {tag: "x" * MAX_TEXT_BYTES for tag in (B.Make, B.Model, B.Artist, B.Copyright)}
        with patch("jpeg_metadata._preserve_exif", return_value=(large_exif, {}, {})), self.assertRaises(JpegCodecError) as raised:
            artifact()
        self.assertEqual(raised.exception.code, "metadata_too_large")
        with patch.object(Image.Exif, "tobytes", side_effect=OSError("secret path")), self.assertRaises(JpegCodecError) as raised:
            artifact()
        self.assertEqual(str(raised.exception), "metadata_encode_failed")

    def test_artifact_source_validation_keeps_jpeg_and_icc_failures(self):
        for source, code in ((b"invalid", "invalid_jpeg"), (jpeg()[:-20], "invalid_jpeg"),
                             (jpeg(profile=b"invalid ICC"), "invalid_icc_profile")):
            with self.subTest(code=code), self.assertRaises(JpegCodecError) as raised:
                artifact(source)
            self.assertEqual(raised.exception.code, code)
        with self.assertRaises(JpegCodecError) as raised:
            artifact(timestamp=STAMP.replace(tzinfo=None))
        self.assertEqual(raised.exception.code, "invalid_export_timestamp")

    def test_default_timestamp_called_once_and_encoder_compatibility(self):
        with patch("export_artifact.datetime") as clock:
            clock.now.return_value = STAMP
            result = artifact(timestamp=None)
            clock.now.assert_called_once_with(timezone.utc)
        with Image.open(BytesIO(result.jpeg)) as image, Image.open(BytesIO(encode_jpeg(RGB))) as bare:
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (7, 11))
            self.assertEqual(JpegImagePlugin.get_sampling(image), 0)
            self.assertEqual(image.quantization, bare.quantization)
            self.assertEqual(image.tobytes(), bare.tobytes())

    def test_unsupported_recognized_iptc_private_namespace_and_extended_xmp_are_not_copied(self):
        source = jpeg(xmp=xmp('<private:Caption>not supported</private:Caption>'))
        # A valid IPTC IIM Caption record inside Photoshop's standard 8BIM resource.
        iim = b"\x1c\x02\x78\x00\x12recognized caption"
        marker = b"Photoshop 3.0\x00" + b"8BIM\x04\x04\x00\x00" + struct.pack(">I", len(iim)) + iim
        if len(iim) % 2:
            marker += b"\x00"
        source = source[:2] + b"\xff\xed" + (len(marker) + 2).to_bytes(2, "big") + marker + source[2:]
        extension = b"http://ns.adobe.com/xmp/extension/\x00" + b"A" * 32 + struct.pack(">II", 17, 0) + b"extended metadata"
        source = source[:2] + b"\xff\xe1" + (len(extension) + 2).to_bytes(2, "big") + extension + source[2:]
        result = artifact(source)
        self.assertNotIn(b"Photoshop", result.jpeg)
        self.assertNotIn(b"not supported", result.jpeg)
        self.assertNotIn(b"recognized caption", result.jpeg)
        self.assertNotIn(b"extended metadata", result.jpeg)

    def test_embedded_source_thumbnail_is_not_copied(self):
        thumbnail = jpeg() + b"source thumbnail marker"
        # Minimal standard TIFF: empty IFD0 points to IFD1 with JPEG offset/length fields.
        exif = (b"Exif\x00\x00II" + struct.pack("<HIHI", 42, 8, 0, 14)
                + struct.pack("<H", 2) + struct.pack("<HHII", 513, 4, 1, 44)
                + struct.pack("<HHII", 514, 4, 1, len(thumbnail)) + struct.pack("<I", 0) + thumbnail)
        source = jpeg(exif)
        with Image.open(BytesIO(source)) as image:
            self.assertEqual(image.getexif().get_ifd(ExifTags.IFD.IFD1)[514], len(thumbnail))
        result = artifact(source)
        with Image.open(BytesIO(result.jpeg)) as image:
            self.assertEqual(image.getexif().get_ifd(ExifTags.IFD.IFD1), {})
        self.assertNotIn(b"source thumbnail marker", result.jpeg)

    def test_logging_contains_only_safe_codes_counts_and_cannot_fail_export(self):
        with patch("jpeg_metadata.backend_logger.add") as logger:
            artifact(jpeg(xmp=b"private malformed packet"))
            logger.assert_called_once_with(level="warn", component="export_artifact",
                                          event="metadata.xmp_dropped", context={"errorCode": "invalid_xmp"})
        with patch("export_artifact.backend_logger.add") as logger:
            with self.assertRaises(JpegCodecError):
                artifact(b"private malformed JPEG")
            logger.assert_called_once_with(level="error", component="export_artifact",
                                          event="artifact.failed", context={"errorCode": "invalid_jpeg"})
        with patch("jpeg_metadata.backend_logger.add", side_effect=RuntimeError("logger failure")):
            self.assertTrue(artifact(jpeg(xmp=b"invalid")).jpeg.startswith(b"\xff\xd8"))

    def test_xmp_array_items_depth_elements_text_and_gps_rational_bounds(self):
        packets = [xmp('<dc:title>' + 'x' * (MAX_TEXT_BYTES + 1) + '</dc:title>'),
                   xmp('<dc:subject><rdf:Bag>' + '<rdf:li>word</rdf:li>' * 129 + '</rdf:Bag></dc:subject>'),
                   xmp('<private:field />' * 1024)]
        for packet in packets:
            with self.subTest(size=len(packet)), Image.open(BytesIO(artifact(jpeg(xmp=packet)).jpeg)) as image:
                tree = ET.fromstring(image.info["xmp"])
                self.assertEqual(len(tree.find(f'.//{{{RDF}}}Description')), 3)
        exif = Image.Exif()
        exif[ExifTags.IFD.Exif] = {B.ExposureTime: TiffImagePlugin.IFDRational(1, 0), B.ISOSpeedRatings: 100}
        exif[ExifTags.IFD.GPSInfo] = {G.GPSImgDirection: TiffImagePlugin.IFDRational(360),
                                    G.GPSTimeStamp: (24, 0, 0), G.GPSAltitudeRef: 2}
        with Image.open(BytesIO(artifact(jpeg(exif)).jpeg)) as image:
            self.assertNotIn(B.ExposureTime, image.getexif().get_ifd(ExifTags.IFD.Exif))
            self.assertEqual(image.getexif().get_ifd(ExifTags.IFD.Exif)[B.ISOSpeedRatings], 100)
            self.assertEqual(image.getexif().get_ifd(ExifTags.IFD.GPSInfo), {})
