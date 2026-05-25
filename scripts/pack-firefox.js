'use strict';
const fs                  = require('fs');
const path                = require('path');
const { ZipArchive }      = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, 'dist');
const XPI  = path.join(DIST, 'nomusic-firefox.xpi');

// All files/dirs that belong in the extension (paths relative to ROOT)
const ENTRIES = [
  'content.js',
  'background.js',
  'popup',
  'options',
  'icons',
  'audio/processor.worklet.js',
  'audio/df_bg.wasm',
  'audio/deepfilter3.tar.gz',
];

function buildFirefoxManifest() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  // Firefox MV3 does not enable background.service_worker by default; use
  // background.scripts (runs as an event page, same API surface).
  delete base.background.service_worker;
  delete base.background.type;
  base.background.scripts = ['background.js'];

  base.browser_specific_settings = {
    gecko: {
      id: 'nomusic@nomusic',
      strict_min_version: '109.0',
    },
  };

  return JSON.stringify(base, null, 2);
}

function pack() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(DIST, { recursive: true });

    const output  = fs.createWriteStream(XPI);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Patched manifest goes in first
    archive.append(buildFirefoxManifest(), { name: 'manifest.json' });

    for (const entry of ENTRIES) {
      const full = path.join(ROOT, entry);
      if (!fs.existsSync(full)) {
        console.warn(`  [warn] missing: ${entry} — skipped`);
        continue;
      }
      if (fs.statSync(full).isDirectory()) {
        archive.directory(full, entry);
      } else {
        archive.file(full, { name: entry });
      }
    }

    archive.finalize();
  });
}

async function main() {
  console.log('[pack-firefox] Packaging …');
  await pack();
  const mb = (fs.statSync(XPI).size / 1024 / 1024).toFixed(1);
  console.log(`[pack-firefox] Done: dist/nomusic-firefox.xpi (${mb} MB)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
