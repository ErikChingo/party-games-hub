// Draws the site icon (dark tile with a gold «Х») as real files, because
// Google shows a site's icon in search results only when it is a file at a
// stable address (data: URIs are ignored) and its size is a multiple of 48 px:
//   favicon.svg, favicon.ico (16/32/48), icon-192.png, icon-512.png,
//   apple-touch-icon.png (180)
// into the project root; build.js copies them to the site.
//
// Run after changing the icon, and commit the files:
//   cd dev && node make-icons.js
// (needs @resvg/resvg-js from dev/package.json; uses the computer's fonts.)

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const ROOT = path.resolve(__dirname, "..");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#0f172a"/><text x="96" y="134" font-family="Arial, Helvetica, sans-serif" font-size="118" font-weight="800" fill="#e8b545" text-anchor="middle">X</text></svg>\n`;

function png(size) {
  const r = new Resvg(SVG, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" } });
  return r.render().asPng();
}

// An .ico file may hold PNG images directly (every browser and Google read it).
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(sizes[i] % 256, e);
    header.writeUInt8(sizes[i] % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...images]);
}

fs.writeFileSync(path.join(ROOT, "favicon.svg"), SVG);
fs.writeFileSync(path.join(ROOT, "favicon.ico"), ico([16, 32, 48]));
fs.writeFileSync(path.join(ROOT, "icon-192.png"), png(192));
fs.writeFileSync(path.join(ROOT, "icon-512.png"), png(512));
fs.writeFileSync(path.join(ROOT, "apple-touch-icon.png"), png(180));
console.log("make-icons.js: wrote favicon.svg, favicon.ico, icon-192.png, icon-512.png, apple-touch-icon.png");
