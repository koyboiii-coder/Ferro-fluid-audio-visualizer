const pngToIco = require("png-to-ico");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Reads the per-size PNGs generate-icons.cjs just wrote to a shared temp
// path (same npm-script run, separate process) — passing this exact array
// (rather than a single file) is what makes png-to-ico embed all seven
// sizes instead of its own hardcoded default set of four.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const iconSizesDir = path.join(os.tmpdir(), "nikkiro-icon-sizes");
const sources = ICO_SIZES.map((size) => path.join(iconSizesDir, `icon-${size}.png`));

pngToIco(sources).then((buf) => {
  fs.writeFileSync(path.join(__dirname, "icon.ico"), buf);
  console.log(`Wrote electron/icon.ico with sizes: ${ICO_SIZES.join(", ")}`);
  fs.rmSync(iconSizesDir, { recursive: true, force: true });
});
