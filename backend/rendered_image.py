"""Small engine boundary: packed, row-major 8-bit sRGB RGB, without metadata."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RenderedImage:
    width: int
    height: int
    pixels: bytes

    def __post_init__(self):
        if type(self.width) is not int or type(self.height) is not int \
                or self.width <= 0 or self.height <= 0:
            raise ValueError("invalid_image_dimensions")
        # Immutable bytes keep ownership and source preservation explicit across engines.
        if type(self.pixels) is not bytes or len(self.pixels) != self.width * self.height * 3:
            raise ValueError("invalid_rgb_pixels")


class Renderer(Protocol):
    def render(self, source: RenderedImage, recipe: dict) -> RenderedImage: ...
