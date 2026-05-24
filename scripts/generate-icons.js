// Generates placeholder PNG icons using pure Node.js (no external deps).
// Run: node scripts/generate-icons.js
// Replace icons/icon*.png with your real artwork when ready.

const fs = require("fs");
const path = require("path");

const SIZES = [16, 48, 128];
const OUT_DIR = path.join(__dirname, "..", "icons");

fs.mkdirSync(OUT_DIR, { recursive: true });

// Builds a minimal uncompressed PNG for a solid-color square.
function buildPNG(size, r, g, b) {
  const { createHash } = require("crypto");

  function adler32(buf) {
    let s1 = 1, s2 = 0;
    for (let i = 0; i < buf.length; i++) {
      s1 = (s1 + buf[i]) % 65521;
      s2 = (s2 + s1) % 65521;
    }
    return (s2 << 16) | s1;
  }

  function crc32(buf) {
    const table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u32be(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, "ascii");
    const crc = crc32(Buffer.concat([typeBytes, data]));
    return Buffer.concat([u32be(data.length), typeBytes, data, u32be(crc)]);
  }

  // IHDR
  const ihdr = Buffer.concat([u32be(size), u32be(size), Buffer.from([8, 2, 0, 0, 0])]);

  // Raw image data: filter byte (0) + RGB pixels per row
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rawRows.push(row);
  }
  const raw = Buffer.concat(rawRows);

  // zlib deflate (uncompressed block — valid but uncompressed)
  function zlibUncompressed(data) {
    const blocks = [];
    const BLOCK = 65535;
    for (let i = 0; i < data.length; i += BLOCK) {
      const block = data.slice(i, i + BLOCK);
      const last = i + BLOCK >= data.length ? 1 : 0;
      const header = Buffer.from([last, block.length & 0xff, (block.length >> 8) & 0xff,
        (~block.length) & 0xff, (~block.length >> 8) & 0xff]);
      blocks.push(header, block);
    }
    const deflate = Buffer.concat(blocks);
    const cmf = 0x78, flg = 0x01; // zlib header
    const adr = adler32(data);
    return Buffer.concat([
      Buffer.from([cmf, flg]),
      deflate,
      u32be(adr)
    ]);
  }

  const idat = zlibUncompressed(raw);
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Dark blue-ish color to match the extension theme
const [R, G, B] = [15, 52, 96]; // #0f3460

for (const size of SIZES) {
  const png = buildPNG(size, R, G, B);
  const out = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`  wrote ${out} (${png.length} bytes)`);
}

console.log("Icons generated. Replace with real artwork when ready.");
