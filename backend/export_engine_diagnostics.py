"""Single-run developer diagnostic; no persistence or Immich writes."""

from time import perf_counter

from backend_logging import backend_logger
from jpeg_codec import JpegCodecError, decode_jpeg, encode_jpeg, inspect_jpeg_source
from jpeg_renderer import JpegRenderer


class ExportEngineError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def diagnostic_failure(code: str, phase: str) -> None:
    # Only bounded engine codes/phase are retained; never identities or exception text.
    try:
        backend_logger.add(level="error", component="export_engine", event="diagnostic.failed",
                           context={"errorCode": code, "phase": phase})
    except Exception:
        pass  # Diagnostics must not change failure handling if logging itself fails.


def generate_diagnostic(source: bytearray, recipe: dict) -> tuple[bytes, dict]:
    """Called as one threadpool operation so decode/render/encode cannot block ASGI."""
    total_started = perf_counter()
    phase = "decode"
    try:
        started = perf_counter()
        metadata = inspect_jpeg_source(source)
        image = decode_jpeg(source)
        # This request-owned buffer has no other consumers after decode.
        source.clear()
        metadata["decodeMs"] = (perf_counter() - started) * 1000
        phase = "render"
        started = perf_counter()
        rendered = JpegRenderer().render(image, recipe)
        image = None
        metadata["renderMs"] = (perf_counter() - started) * 1000
        phase = "encode"
        started = perf_counter()
        jpeg = encode_jpeg(rendered)
        metadata["encodeMs"] = (perf_counter() - started) * 1000
        metadata.update(outputWidth=rendered.width, outputHeight=rendered.height,
                        outputColorSpace="sRGB", recipeVersion=recipe["version"], outputBytes=len(jpeg),
                        quality=95, subsampling="4:4:4", totalMs=(perf_counter() - total_started) * 1000)
        return jpeg, metadata
    except Exception as error:
        code = "invalid_icc" if isinstance(error, JpegCodecError) and error.code == "invalid_icc_profile" \
            else f"{phase}_failed"
        diagnostic_failure(code, phase)
        raise ExportEngineError(code) from error


def decode_diagnostic(source: bytearray) -> tuple[bytes, dict]:
    """Return the decoder's RGB bytes directly, without any renderer or image encoder."""
    started = perf_counter()
    try:
        metadata = inspect_jpeg_source(source)
        image = decode_jpeg(source)
        source.clear()
        metadata.update(width=image.width, height=image.height, pixelFormat="rgb8",
                        orientationNormalized=True, backendDecodeMs=(perf_counter() - started) * 1000)
        return image.pixels, metadata
    except Exception as error:
        diagnostic_failure("backend_decode_failed", "decode")
        raise ExportEngineError("backend_decode_failed") from error
