"""Bounded semantic metadata reconstruction; source containers are never serialized."""

from datetime import datetime
from io import BytesIO
import math
import re
import warnings
import xml.etree.ElementTree as ET

from PIL import ExifTags, Image, TiffImagePlugin

from backend_logging import backend_logger
from jpeg_codec import JpegCodecError, JPEG_APP1_MAX_BYTES, JPEG_XMP_MAX_BYTES
from rendered_image import RenderedImage


MAX_TEXT_BYTES = 16384
MAX_XMP_BYTES = JPEG_XMP_MAX_BYTES
MAX_EXIF_BYTES = JPEG_APP1_MAX_BYTES
MAX_XML_DEPTH = 12
MAX_XML_ELEMENTS = 1024
MAX_ARRAY_ITEMS = 128
B, G = ExifTags.Base, ExifTags.GPS
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC = "http://purl.org/dc/elements/1.1/"
XMP = "http://ns.adobe.com/xap/1.0/"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
for prefix, namespace in (("x", "adobe:ns:meta/"), ("rdf", RDF), ("dc", DC), ("xmp", XMP)):
    ET.register_namespace(prefix, namespace)


def _diagnostic(event: str, **context):
    try:
        backend_logger.add(level="warn", component="export_artifact", event=event, context=context)
    except Exception:
        # Optional diagnostics must never change artifact generation semantics.
        pass


def _text(value, *, ascii_only=False):
    if not isinstance(value, str) or not value or len(value) > MAX_TEXT_BYTES:
        raise ValueError("invalid_text")
    if any(not (char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF
                or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF)
           for char in value):
        raise ValueError("invalid_text")
    if len(value.encode("ascii" if ascii_only else "utf-8")) > MAX_TEXT_BYTES:
        raise ValueError("text_too_large")
    return value


def _integer(value, minimum=0, maximum=65535):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("invalid_integer")
    return value


def _rational(value, *, signed=False):
    if type(value) not in (int, float, TiffImagePlugin.IFDRational):
        raise ValueError("invalid_rational")
    if not math.isfinite(float(value)) or (not signed and value < 0):
        raise ValueError("invalid_rational")
    result = TiffImagePlugin.IFDRational(value)
    minimum, maximum = (-2**31, 2**31 - 1) if signed else (0, 2**32 - 1)
    if not minimum <= result.numerator <= maximum or not 1 <= result.denominator <= maximum:
        raise ValueError("invalid_rational")
    return result


def _rationals(value, count):
    if type(value) not in (tuple, list) or len(value) != count:
        raise ValueError("invalid_rationals")
    return tuple(_rational(item) for item in value)


def _date(value, fmt):
    value = _text(value, ascii_only=True)
    parsed = datetime.strptime(value, fmt)
    if parsed.strftime(fmt) != value:
        raise ValueError("invalid_date")
    return value


def _choice(value, choices):
    if value not in choices:
        raise ValueError("invalid_choice")
    return value


_ROOT_TEXT = (B.Make, B.Model, B.Artist, B.Copyright, B.ImageDescription)
_CAPTURE_TEXT = (B.LensMake, B.LensModel)
_CAPTURE_RATIONAL = (B.ExposureTime, B.FNumber, B.FocalLength, B.DigitalZoomRatio)
_CAPTURE_INT = (B.ISOSpeedRatings, B.ExposureProgram, B.MeteringMode, B.Flash,
                B.FocalLengthIn35mmFilm, B.WhiteBalance, B.LightSource,
                B.SceneCaptureType, B.ExposureMode)
_GPS_RULES = {
    G.GPSLatitudeRef: lambda v: _choice(v, ("N", "S")),
    G.GPSLongitudeRef: lambda v: _choice(v, ("E", "W")),
    # Pillow exposes standard BYTE fields as bytes, unlike SHORT fields.
    G.GPSAltitudeRef: lambda v: _integer(v[0] if type(v) is bytes and len(v) == 1 else v, 0, 1),
    G.GPSAltitude: _rational,
    G.GPSDateStamp: lambda v: _date(v, "%Y:%m:%d"),
    G.GPSImgDirectionRef: lambda v: _choice(v, ("T", "M")),
    G.GPSImgDirection: lambda v: _bounded_rational(v, 360),
}


def _bounded_rational(value, maximum):
    result = _rational(value)
    if result >= maximum:
        raise ValueError("invalid_range")
    return result


def _gps_triplet(value, maximum):
    result = _rationals(value, 3)
    if result[0] > maximum or result[1] >= 60 or result[2] >= 60 \
            or (result[0] == maximum and (result[1] != 0 or result[2] != 0)):
        raise ValueError("invalid_coordinate")
    return result


_GPS_RULES.update({
    G.GPSLatitude: lambda v: _gps_triplet(v, 90),
    G.GPSLongitude: lambda v: _gps_triplet(v, 180),
    G.GPSTimeStamp: lambda v: _gps_time(v),
})


def _gps_time(value):
    result = _rationals(value, 3)
    if result[0] >= 24 or result[1] >= 60 or result[2] >= 60:
        raise ValueError("invalid_time")
    return result


def _preserve_exif(image):
    root, capture, gps = {}, {}, {}
    dropped = 0

    def copy_fields(source, target, rules):
        nonlocal dropped
        for tag, validator in rules.items():
            try:
                if tag in source:
                    target[tag] = validator(source[tag])
            except (ValueError, TypeError, OverflowError, ZeroDivisionError):
                dropped += 1

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            exif = image.getexif()
            copy_fields(exif, root, {tag: lambda v: _text(v, ascii_only=True) for tag in _ROOT_TEXT})
            # Rebuild canonical sub-IFDs even for sources whose capture fields are in IFD0.
            fields = dict(exif)
            fields.update(exif.get_ifd(ExifTags.IFD.Exif))
            rules = {tag: lambda v: _text(v, ascii_only=True) for tag in _CAPTURE_TEXT}
            rules.update({tag: _rational for tag in _CAPTURE_RATIONAL})
            rules.update({tag: _integer for tag in _CAPTURE_INT})
            rules.update({B.DateTimeOriginal: lambda v: _date(v, "%Y:%m:%d %H:%M:%S"),
                          B.OffsetTimeOriginal: _offset,
                          B.SubsecTimeOriginal: _subseconds,
                          B.LensSpecification: lambda v: _rationals(v, 4),
                          B.ExposureBiasValue: lambda v: _rational(v, signed=True)})
            copy_fields(fields, capture, rules)
            copy_fields(exif.get_ifd(ExifTags.IFD.GPSInfo), gps, _GPS_RULES)
    except Exception:
        # Corrupt optional containers must not cause raw offsets/private data to be reused.
        _diagnostic("metadata.exif_dropped", errorCode="invalid_exif")
        return {}, {}, {}
    if dropped:
        _diagnostic("metadata.fields_dropped", fieldCount=dropped)
    return root, capture, gps


def _offset(value):
    value = _text(value, ascii_only=True)
    if not re.fullmatch(r"[+-](?:[01][0-9]|2[0-3]):[0-5][0-9]", value):
        raise ValueError("invalid_offset")
    return value


def _subseconds(value):
    value = _text(value, ascii_only=True)
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError("invalid_subseconds")
    return value


class _BoundedXml(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = self.count = 0

    def doctype(self, name, pubid, system):
        # Reject declarations before entity expansion, including UTF-16 encoded DTDs.
        raise ValueError("unsupported_dtd")

    def start(self, tag, attrs):
        self.depth += 1
        self.count += 1
        if self.depth > MAX_XML_DEPTH or self.count > MAX_XML_ELEMENTS:
            raise ValueError("xml_too_complex")
        return super().start(tag, attrs)

    def end(self, tag):
        result = super().end(tag)
        self.depth -= 1
        return result


_DC_ARRAYS = {"title": "Alt", "description": "Alt", "rights": "Alt",
              "creator": "Seq", "subject": "Bag"}


def _read_property(description, tag, container=None):
    child = description.find(tag)
    if child is None:
        return _text(description.attrib[tag]) if tag in description.attrib else None
    if container is None or not len(child):
        if len(child):
            raise ValueError("unsupported_structure")
        return _text(child.text)
    if len(child) != 1 or child[0].tag != f"{{{RDF}}}{container}":
        raise ValueError("unsupported_structure")
    items = child[0]
    if not 1 <= len(items) <= MAX_ARRAY_ITEMS:
        raise ValueError("invalid_array")
    result = []
    languages = set()
    for item in items:
        if item.tag != f"{{{RDF}}}li" or len(item):
            raise ValueError("unsupported_structure")
        language = item.get(XML_LANG, "x-default") if container == "Alt" else None
        if language is not None:
            if not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", language) \
                    or language in languages or len(language) > 64:
                raise ValueError("invalid_language")
            languages.add(language)
        result.append((language, _text(item.text)))
    return result


def _preserve_xmp(packet):
    if not packet:
        return {}
    try:
        if not isinstance(packet, bytes) or len(packet) > MAX_XMP_BYTES:
            raise ValueError("xmp_too_large")
        root = ET.fromstring(packet, parser=ET.XMLParser(target=_BoundedXml()))
    except Exception:
        _diagnostic("metadata.xmp_dropped", errorCode="invalid_xmp")
        return {}
    result, dropped = {}, 0
    # Only RDF property positions count; a private nested structure cannot impersonate DC.
    descriptions = root.findall(f".//{{{RDF}}}RDF/{{{RDF}}}Description")
    if root.tag == f"{{{RDF}}}RDF":
        descriptions = root.findall(f"{{{RDF}}}Description")
    for description in descriptions:
        for name, container in _DC_ARRAYS.items():
            tag = f"{{{DC}}}{name}"
            try:
                value = _read_property(description, tag, container)
                if value is not None and tag not in result:
                    result[tag] = [("x-default" if container == "Alt" else None, value)] \
                        if isinstance(value, str) else value
            except (ValueError, TypeError):
                dropped += 1
        for name in ("Rating", "Label"):
            tag = f"{{{XMP}}}{name}"
            try:
                value = _read_property(description, tag)
                if value is not None:
                    if name == "Rating":
                        rating = float(value)
                        if not math.isfinite(rating) or not -1 <= rating <= 5:
                            raise ValueError("invalid_rating")
                        value = format(rating, "g")
                    result.setdefault(tag, value)
            except (ValueError, TypeError):
                dropped += 1
    if dropped:
        _diagnostic("metadata.fields_dropped", fieldCount=dropped)
    return result


def prepare_metadata(source: bytes, rendered: RenderedImage, timestamp: datetime) -> tuple[bytes, bytes]:
    # Source validation is owned by the artifact/decoder boundary, not optional metadata parsing.
    with Image.open(BytesIO(source)) as image:
        root, capture, gps = _preserve_exif(image)
        user_xmp = _preserve_xmp(image.info.get("xmp"))
    exif = Image.Exif()
    exif.update(root)
    exif.update({B.Software: "GenzoRoom", B.Orientation: 1,
                 B.DateTime: timestamp.strftime("%Y:%m:%d %H:%M:%S")})
    capture.update({B.ExifImageWidth: rendered.width, B.ExifImageHeight: rendered.height,
                    B.ColorSpace: 1, B.OffsetTime: "+00:00"})
    exif[ExifTags.IFD.Exif] = capture
    if gps:
        exif[ExifTags.IFD.GPSInfo] = gps
    meta = ET.Element("{adobe:ns:meta/}xmpmeta")
    rdf = ET.SubElement(meta, f"{{{RDF}}}RDF")
    description = ET.SubElement(rdf, f"{{{RDF}}}Description", {f"{{{RDF}}}about": ""})
    # Preserve subsecond run identity so consecutive exports do not share a checksum by truncation.
    date = timestamp.isoformat(timespec="milliseconds" if timestamp.microsecond else "seconds").replace("+00:00", "Z")
    for name, value in (("CreatorTool", "GenzoRoom"), ("ModifyDate", date), ("MetadataDate", date)):
        ET.SubElement(description, f"{{{XMP}}}{name}").text = value
    for tag, value in sorted(user_xmp.items()):
        field = ET.SubElement(description, tag)
        if isinstance(value, str):
            field.text = value
        else:
            container = _DC_ARRAYS[tag.split("}")[1]]
            array = ET.SubElement(field, f"{{{RDF}}}{container}")
            for language, text in value:
                item = ET.SubElement(array, f"{{{RDF}}}li", {XML_LANG: language} if language else {})
                item.text = text
    try:
        encoded_exif = exif.tobytes()
        encoded_xmp = ET.tostring(meta, encoding="utf-8")
    except Exception as error:
        raise JpegCodecError("metadata_encode_failed") from error
    if len(encoded_exif) > MAX_EXIF_BYTES or len(encoded_xmp) > MAX_XMP_BYTES:
        _diagnostic("metadata.size_rejected", errorCode="metadata_too_large")
        raise JpegCodecError("metadata_too_large")
    return encoded_exif, encoded_xmp
