"""Phase 5B artifact preparation, without Queue or Immich orchestration."""

from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import chain
import re
from typing import Iterable

from backend_logging import backend_logger
from jpeg_codec import JpegCodecError, decode_jpeg, encode_jpeg
from jpeg_metadata import prepare_metadata
from rendered_image import RenderedImage


_SUFFIX = re.compile(r"-Genzo([0-9]+)$")
_JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def filename_family(filename: str) -> str | None:
    """Mirror frontend stackCandidateDetection.filenameFamily (Phase 0)."""
    if not isinstance(filename, str):
        return None
    dot = filename.find(".")
    if dot <= 0 or filename.endswith("."):
        return None
    base = _SUFFIX.sub("", filename[:dot])
    return base if base.strip(_JS_WHITESPACE) else None


def next_export_filename(source_filename: str, family_filenames: Iterable[str]) -> str:
    base = filename_family(source_filename)
    if base is None or re.search(r'[\x00-\x1f\x7f/\\:*?"<>|]', base):
        raise JpegCodecError("invalid_export_filename")
    maximum = "0"
    # Decimal strings avoid Python's int/string digit limit without inventing a numbering cap.
    for filename in chain((source_filename,), family_filenames):
        if filename_family(filename) != base:
            continue
        match = _SUFFIX.search(filename.split(".", 1)[0])
        if match:
            number = match[1].lstrip("0") or "0"
            if (len(number), number) > (len(maximum), maximum):
                maximum = number
    digits = bytearray(maximum, "ascii")
    index = len(digits) - 1
    while index >= 0 and digits[index] == ord("9"):
        digits[index] = ord("0")
        index -= 1
    if index < 0:
        digits[:0] = b"1"
    else:
        digits[index] += 1
    return f"{base}-Genzo{digits.decode('ascii').zfill(2)}.jpg"


@dataclass(frozen=True)
class ExportArtifact:
    filename: str
    jpeg: bytes


def create_export_artifact(source: bytes, source_filename: str,
                           family_filenames: Iterable[str], rendered: RenderedImage,
                           *, timestamp: datetime | None = None) -> ExportArtifact:
    try:
        filename = next_export_filename(source_filename, family_filenames)
        instant = datetime.now(timezone.utc) if timestamp is None else timestamp
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise JpegCodecError("invalid_export_timestamp")
        # The standalone boundary cannot assume its caller validated JPEG pixels or critical ICC.
        # Discard this validation buffer before preparing/encoding the caller's rendered pixels.
        decode_jpeg(source)
        exif, xmp = prepare_metadata(source, rendered, instant.astimezone(timezone.utc))
        return ExportArtifact(filename, encode_jpeg(rendered, exif=exif, xmp=xmp))
    except JpegCodecError as error:
        try:
            backend_logger.add(level="error", component="export_artifact", event="artifact.failed",
                               context={"errorCode": error.code})
        except Exception:
            pass
        raise
