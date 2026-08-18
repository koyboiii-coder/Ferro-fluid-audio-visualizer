const pngToIco = require("png-to-ico");
const fs = require("fs");
const path = require("path");

pngToIco(path.join(__dirname, "icon.png")).then((buf) => {
  fs.writeFileSync(path.join(__dirname, "icon.ico"), buf);
  console.log("Wrote electron/icon.ico");
});
