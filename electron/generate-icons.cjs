// Generates a simple on-brand PNG icon (a spiky dark blob, like the app's
// own visual) with zero external dependencies, using only Node's builtin
// zlib for PNG compression. Run via `npm run icons`.
const fs = require("fs");
const path = require("path");
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

function pixelFn(x, y, w, h) {
  const cx = w / 2,
    cy = h / 2;
  const dx = x - cx,
    dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const spikes = 11;
  const baseR = w * 0.3;
  const spikeAmt = 0.55;
  const r = baseR * (1 + spikeAmt * Math.pow(Math.max(0, Math.cos(angle * spikes)), 1.6));

  if (dist > r) return [0, 0, 0, 0];

  const hlx = cx - w * 0.12,
    hly = cy - h * 0.14;
  const hdist = Math.sqrt((x - hlx) ** 2 + (y - hly) ** 2) / (w * 0.42);
  const hl = Math.max(0, 1 - hdist);
  const base = 10;
  const rC = Math.min(255, base + hl * 150);
  const gC = Math.min(255, base + hl * 170);
  const bC = Math.min(255, base + 20 + hl * 190);
  return [rC, gC, bC, 255];
}

const png = makePNG(256, pixelFn);
fs.writeFileSync(path.join(__dirname, "icon.png"), png);
console.log("Wrote electron/icon.png");
