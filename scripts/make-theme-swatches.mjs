// Draws the theme-swatch strip that the welcome note embeds, and writes it out as
// a base64 data URL module (src/lib/welcome-image.ts).
//
// The welcome note needs a real embedded image to demonstrate inline images, and
// inline images are always data URLs (see src/lib/images.ts) — so the bytes have
// to live in the source. This script is how they get there:
//
//   node scripts/make-theme-swatches.mjs
//
// Each swatch mirrors `.theme-preview` in styles.css (background, a surface bar,
// an accent bar) using the same colours as the `themes` list in App.tsx. The
// background is transparent so the strip sits well in all seven themes.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// [background, surface, accent] — keep in step with `themes` in src/App.tsx.
const THEMES = [
  ["#f9f2e6", "#f4ecdc", "#9d6d38"],
  ["#f6f7f9", "#eef1f5", "#5d6a7d"],
  ["#191a1d", "#22242a", "#c7d0de"],
  ["#eceff4", "#e5e9f0", "#5e81ac"],
  ["#fdf6e3", "#eee8d5", "#268bd2"],
  ["#282a36", "#343746", "#bd93f9"],
  ["#282828", "#3c3836", "#fabd2f"],
];

const CARD = { width: 76, height: 54, gap: 8, radius: 5 };
const PAD = 3;
const SCALE = 2; // Final image is 2x for crisp rendering on retina displays.
const SUPERSAMPLE = 3; // Rendered at 3x the final size, then averaged down for anti-aliasing.

const width = THEMES.length * CARD.width + (THEMES.length - 1) * CARD.gap + PAD * 2;
const height = CARD.height + PAD * 2;

// --- A very small rasterizer ---------------------------------------------------

const factor = SCALE * SUPERSAMPLE;
const bigWidth = width * factor;
const bigHeight = height * factor;
const pixels = new Uint8Array(bigWidth * bigHeight * 4); // Transparent to begin with.

function parseColor(color) {
  if (color.startsWith("rgba")) {
    const [r, g, b, a] = color.slice(5, -1).split(",").map(Number);
    return [r, g, b, Math.round(a * 255)];
  }
  const hex = color.slice(1);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
}

function blend(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= bigWidth || y >= bigHeight || a === 0) return;
  const at = (y * bigWidth + x) * 4;
  const source = a / 255;
  const destination = (pixels[at + 3] / 255) * (1 - source);
  const alpha = source + destination;
  for (const [channel, value] of [r, g, b].entries()) {
    pixels[at + channel] = Math.round((value * source + pixels[at + channel] * destination) / alpha);
  }
  pixels[at + 3] = Math.round(alpha * 255);
}

// Rounded rectangle in logical (pre-scale) coordinates.
function roundedRect(x, y, w, h, radius, color) {
  const rgba = parseColor(color);
  const [left, top, right, bottom] = [x * factor, y * factor, (x + w) * factor, (y + h) * factor];
  const r = radius * factor;
  for (let py = Math.floor(top); py < Math.ceil(bottom); py += 1) {
    for (let px = Math.floor(left); px < Math.ceil(right); px += 1) {
      // Distance from the nearest corner circle's centre, for the four corners only.
      const cornerX = px < left + r ? left + r : px > right - r ? right - r : px;
      const cornerY = py < top + r ? top + r : py > bottom - r ? bottom - r : py;
      const dx = px + 0.5 - cornerX;
      const dy = py + 0.5 - cornerY;
      if (dx * dx + dy * dy <= r * r) blend(px, py, rgba);
    }
  }
}

// --- The strip -----------------------------------------------------------------

THEMES.forEach(([background, surface, accent], index) => {
  const x = PAD + index * (CARD.width + CARD.gap);
  const y = PAD;
  // Border first, fill inset by 1px on top of it — same look as the 1px border in
  // `.theme-preview`, without needing a stroke primitive.
  roundedRect(x, y, CARD.width, CARD.height, CARD.radius, "rgba(0,0,0,0.14)");
  roundedRect(x + 1, y + 1, CARD.width - 2, CARD.height - 2, CARD.radius - 1, background);
  // Two surface bars and an accent bar: a note, abstracted.
  roundedRect(x + 8, y + 11, 44, 5, 2.5, surface);
  roundedRect(x + 8, y + 21, 33, 5, 2.5, surface);
  roundedRect(x + 8, y + CARD.height - 16, 26, 5, 2.5, accent);
});

// --- Downsample + encode -------------------------------------------------------

const finalWidth = width * SCALE;
const finalHeight = height * SCALE;
const image = new Uint8Array(finalWidth * finalHeight * 4);
for (let y = 0; y < finalHeight; y += 1) {
  for (let x = 0; x < finalWidth; x += 1) {
    const totals = [0, 0, 0, 0];
    for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
      for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
        const at = ((y * SUPERSAMPLE + sy) * bigWidth + (x * SUPERSAMPLE + sx)) * 4;
        for (let channel = 0; channel < 4; channel += 1) totals[channel] += pixels[at + channel];
      }
    }
    const samples = SUPERSAMPLE * SUPERSAMPLE;
    const at = (y * finalWidth + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) image[at + channel] = Math.round(totals[channel] / samples);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(finalWidth, 0);
header.writeUInt32BE(finalHeight, 4);
header[8] = 8; // bit depth
header[9] = 6; // colour type: RGBA
// 10-12: compression, filter, interlace — all zero.

// One filter byte (0 = None) per scanline.
const raw = Buffer.alloc(finalHeight * (finalWidth * 4 + 1));
for (let y = 0; y < finalHeight; y += 1) {
  const at = y * (finalWidth * 4 + 1);
  raw[at] = 0;
  Buffer.from(image.buffer, y * finalWidth * 4, finalWidth * 4).copy(raw, at + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

writeFileSync(
  new URL("../src/lib/welcome-image.ts", import.meta.url),
  `// Generated by scripts/make-theme-swatches.mjs — do not edit by hand.\n` +
    `// The seven theme swatches, embedded in the welcome note the same way any\n` +
    `// pasted image is: a base64 data URL living in the note's Markdown.\n` +
    `export const themeSwatchesImage =\n  "${dataUrl}";\n`,
);

console.log(`${finalWidth}×${finalHeight} · ${(png.length / 1024).toFixed(1)} KB · ${(dataUrl.length / 1024).toFixed(1)} KB as a data URL`);
