#!/usr/bin/env python3
"""Prepare a full-bleed square icon for macOS, keeping the artwork full size."""

import argparse
import importlib.util
from pathlib import Path

from PIL import Image

_MASK_PATH = Path(__file__).with_name("apply-macos-icon-mask.py")
_MASK_SPEC = importlib.util.spec_from_file_location("apply_macos_icon_mask", _MASK_PATH)
if _MASK_SPEC is None or _MASK_SPEC.loader is None:
    raise RuntimeError(f"Unable to load {_MASK_PATH}")
_MASK_MODULE = importlib.util.module_from_spec(_MASK_SPEC)
_MASK_SPEC.loader.exec_module(_MASK_MODULE)

DEFAULT_TILE_SCALE = _MASK_MODULE.DEFAULT_TILE_SCALE
squircle_mask = _MASK_MODULE.squircle_mask


def round_full(
    src: Path,
    dst: Path,
    size: int = 1024,
    tile_scale: float = DEFAULT_TILE_SCALE,
    squircle_n: float = 3.8,
) -> None:
    source = Image.open(src).convert("RGBA")
    tile_size = max(1, round(size * tile_scale))
    tile_offset = (size - tile_size) // 2

    # Use the whole source as the tile art; do not re-fit or shrink the artwork.
    tile = source.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
    mask = squircle_mask(tile_size, squircle_n)
    masked = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
    masked.paste(tile, (0, 0), mask)

    output = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    output.paste(masked, (tile_offset, tile_offset), masked)
    output.save(dst, "PNG")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("-o", "--output", type=Path, default=Path("app-icon.png"))
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--tile-scale", type=float, default=DEFAULT_TILE_SCALE)
    parser.add_argument("--squircle-n", type=float, default=3.8)
    args = parser.parse_args()
    round_full(args.input, args.output, args.size, args.tile_scale, args.squircle_n)
    print(f"Wrote {args.output}")
