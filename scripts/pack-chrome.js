'use strict';
const fs             = require('fs');
const path           = require('path');
const { ZipArchive } = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, 'dist');
const ZIP  = path.join(DIST, 'nomusic-chrome.zip');

const ENTRIES = [
  'manifest.json',
  'content.js',
  'background.js',
  'popup',
  'options',
  'icons',
  'audio/processor.worklet.js',
  'audio/df_bg.wasm',
  'audio/deepfilter3.tar.gz',
];

async function main() {
  console.log('[pack-chrome] Packaging …');
  fs.mkdirSync(DIST, { recursive: true });

  await new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(ZIP);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    for (const entry of ENTRIES) {
      const full = path.join(ROOT, entry);
      if (!fs.existsSync(full)) { console.warn(`  [warn] missing: ${entry}`); continue; }
      fs.statSync(full).isDirectory()
        ? archive.directory(full, entry)
        : archive.file(full, { name: entry });
    }
    archive.finalize();
  });

  const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
  console.log(`[pack-chrome] Done: dist/nomusic-chrome.zip (${mb} MB)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
