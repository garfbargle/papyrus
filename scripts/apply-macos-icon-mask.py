#!/usr/bin/env python3
"""Prepare a macOS app icon with Apple's inset tile and squircle mask."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


# Apple HIG uses an 824pt keyline on a 1024pt canvas (~80.5%).
DEFAULT_TILE_SCALE = 824 / 1024


def superellipse_polygon(size: int, n: float, points: int = 720) -> list[tuple[float, float]]:
    cx = cy = size / 2
    radius = size / 2
    polygon: list[tuple[float, float]] = []
    for i in range(points):
        t = 2 * math.pi * i / points
        cos_t, sin_t = math.cos(t), math.sin(t)
        x = radius * math.copysign(abs(cos_t) ** (2 / n), cos_t)
        y = radius * math.copysign(abs(sin_t) ** (2 / n), sin_t)
        polygon.append((cx + x, cy + y))
    return polygon


def squircle_mask(size: int, n: float) -> Image.Image:
    scale = 4
    big = size * scale
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon(superellipse_polygon(big, n), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def apply_macos_squircle(
    src: Path,
    dst: Path,
    size: int = 1024,
    tile_scale: float = DEFAULT_TILE_SCALE,
    squircle_n: float = 3.8,
) -> None:
    source = Image.open(src).convert("RGBA")
    tile_size = max(1, round(size * tile_scale))
    tile_offset = (size - tile_size) // 2

    tile = source.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
    tile_mask = squircle_mask(tile_size, squircle_n)
    masked_tile = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
    masked_tile.paste(tile, (0, 0), tile_mask)

    output = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    output.paste(masked_tile, (tile_offset, tile_offset), masked_tile)
    output.save(dst, "PNG")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Square source icon (PNG/JPEG)")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("app-icon.png"),
        help="Output PNG path (default: app-icon.png)",
    )
    parser.add_argument("--size", type=int, default=1024, help="Output size in pixels")
    parser.add_argument(
        "--tile-scale",
        type=float,
        default=DEFAULT_TILE_SCALE,
        help="Squircle tile scale on canvas (default: 824/1024)",
    )
    parser.add_argument(
        "--squircle-n",
        type=float,
        default=3.8,
        help="Superellipse exponent; lower = rounder corners (default: 3.8)",
    )
    args = parser.parse_args()
    apply_macos_squircle(
        args.input,
        args.output,
        size=args.size,
        tile_scale=args.tile_scale,
        squircle_n=args.squircle_n,
    )
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
