"""JPEG acquisition/color normalization and encoding, independent of Recipe math."""

from io import BytesIO
import warnings

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from rendered_image import RenderedImage


JPEG_APP1_MAX_BYTES = 65533
JPEG_XMP_MAX_BYTES = JPEG_APP1_MAX_BYTES - 29


class JpegCodecError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _srgb_profile() -> ImageCms.ImageCmsProfile:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))


def inspect_jpeg_source(source: bytes) -> dict:
    """Header-only diagnostic metadata; decoding/color validation still belongs to decode_jpeg."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(source)) as image:
                if image.format != "JPEG":
                    raise JpegCodecError("not_jpeg")
                return {"sourceWidth": image.width, "sourceHeight": image.height,
                        "sourceIcc": "embedded" if "icc_profile" in image.info else "absent"}
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise JpegCodecError("invalid_jpeg") from error


def decode_jpeg(source: bytes) -> RenderedImage:
    """Apply orientation and embedded ICC before exposing sRGB bytes to a renderer."""
    try:
        with warnings.catch_warnings():
            # Resource-limit warnings are failures here, never implicit partial decodes.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(source)) as image:
                if image.format != "JPEG":
                    raise JpegCodecError("not_jpeg")
                image.load()
                profile = image.info.get("icc_profile")
                # A present but empty ICC marker is not equivalent to an untagged JPEG.
                has_profile = "icc_profile" in image.info
                ImageOps.exif_transpose(image, in_place=True)
                if has_profile:
                    try:
                        if not profile:
                            raise ValueError("empty_profile")
                        embedded = ImageCms.ImageCmsProfile(BytesIO(profile))
                        with ImageCms.profileToProfile(image, embedded, _srgb_profile(), outputMode="RGB") as rgb:
                            return RenderedImage(rgb.width, rgb.height, rgb.tobytes())
                    except (ImageCms.PyCMSError, OSError, ValueError, TypeError) as error:
                        # Do not silently discard a profile: that would produce plausible wrong colors.
                        raise JpegCodecError("invalid_icc_profile") from error
                if image.mode not in ("RGB", "L"):
                    # Untagged CMYK has no defined sRGB interpretation.
                    raise JpegCodecError("unsupported_jpeg_color_space")
                with image.convert("RGB") as rgb:
                    return RenderedImage(rgb.width, rgb.height, rgb.tobytes())
    except JpegCodecError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise JpegCodecError("invalid_jpeg") from error


def encode_jpeg(image: RenderedImage, *, exif: bytes = b"", xmp: bytes = b"") -> bytes:
    """Fixed RGB/sRGB encoding; optional metadata must be freshly prepared by the caller."""
    # APP1 lengths include their two-byte length word; XMP also has a namespace header.
    if len(exif) > JPEG_APP1_MAX_BYTES or len(xmp) > JPEG_XMP_MAX_BYTES:
        raise JpegCodecError("metadata_too_large")
    try:
        with Image.frombytes("RGB", (image.width, image.height), image.pixels) as rgb:
            output = BytesIO()
            rgb.save(output, format="JPEG", quality=95, subsampling=0,
                     icc_profile=_srgb_profile().tobytes(), exif=exif, xmp=xmp)
            return output.getvalue()
    except (OSError, ValueError, ImageCms.PyCMSError) as error:
        raise JpegCodecError("jpeg_encode_failed") from error
