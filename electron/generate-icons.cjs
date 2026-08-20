// Generates the on-brand "Aro" icon — a white ring on a dark rounded
// square — with zero external dependencies, using only Node's builtin
// zlib for PNG compression. Run via `npm run icons`.
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePNG(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// Rounded-square signed distance field (negative inside, 0 on the edge,
// positive outside) — used both to draw the background and to know how
// far a sample point is from the corner curve for anti-aliasing.
function roundedRectSDF(px, py, w, h, r) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = Math.abs(px - cx) - (cx - r);
  const dy = Math.abs(py - cy) - (cy - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

const BG = [0x0a, 0x0b, 0x0e];
const RING = [0xea, 0xf0, 0xf7];
const SUPERSAMPLE = 4; // 4x4 per pixel — keeps the thin ring stroke and
// rounded corners smooth instead of jagged, especially at the small .ico
// sizes.

// brand/icon.svg: rect rx = 22% of side, ring r = 32% of side. strokeFraction
// is the one number that varies by call site (thicker at 16px so the ring
// doesn't dissolve when the OS shrinks it further, e.g. taskbar scaling).
function ringPixelFn(strokeFraction) {
  const cornerFraction = 0.22;
  const ringRFraction = 0.32;
  return function pixelFn(x, y, w, h) {
    const cornerR = w * cornerFraction;
    const ringR = w * ringRFraction;
    const strokeW = w * strokeFraction;
    let ringCoverage = 0;
    let bgCoverage = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy++) {
      for (let sx = 0; sx < SUPERSAMPLE; sx++) {
        const px = x + (sx + 0.5) / SUPERSAMPLE;
        const py = y + (sy + 0.5) / SUPERSAMPLE;
        const dx = px - w / 2;
        const dy = py - h / 2;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(dist - ringR) <= strokeW / 2) {
          ringCoverage++;
        } else if (roundedRectSDF(px, py, w, h, cornerR) <= 0) {
          bgCoverage++;
        }
      }
    }
    const total = SUPERSAMPLE * SUPERSAMPLE;
    ringCoverage /= total;
    bgCoverage /= total;
    const r = RING[0] * ringCoverage + BG[0] * bgCoverage;
    const g = RING[1] * ringCoverage + BG[1] * bgCoverage;
    const b = RING[2] * ringCoverage + BG[2] * bgCoverage;
    const a = (ringCoverage + bgCoverage) * 255;
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(a)];
  };
}

const STANDARD_STROKE = 0.078; // matches brand/icon.svg exactly
const TRAY_STROKE = 0.11; // matches brand/favicon.svg's thickened logic

// The canonical 256px asset — used directly as the app/window icon, and as
// the source Electron's own nativeImage resize draws the system tray icon
// from (see main.cjs).
const iconPng = makePNG(256, ringPixelFn(STANDARD_STROKE));
fs.writeFileSync(path.join(__dirname, "icon.png"), iconPng);
console.log("Wrote electron/icon.png");

// One exactly-sized PNG per size the .ico needs. png-to-ico's single-file
// mode only ever emits 4 fixed sizes (256/48/32/16) by resizing that one
// source — getting the full 16/24/32/48/64/128/256 set means handing it
// one already-correctly-sized file per size instead. Written to a fixed,
// predictable temp path so the separate make-ico.cjs process (run right
// after this one by `npm run icons`) can find them without any IPC.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const iconSizesDir = path.join(os.tmpdir(), "nikkiro-icon-sizes");
fs.mkdirSync(iconSizesDir, { recursive: true });
for (const size of ICO_SIZES) {
  const stroke = size <= 16 ? TRAY_STROKE : STANDARD_STROKE;
  const png = size === 256 ? iconPng : makePNG(size, ringPixelFn(stroke));
  fs.writeFileSync(path.join(iconSizesDir, `icon-${size}.png`), png);
}
console.log(`Wrote ${ICO_SIZES.length} sized PNGs to ${iconSizesDir}`);
