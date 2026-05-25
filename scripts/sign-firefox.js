'use strict';
/**
 * Signs the Firefox extension via AMO and saves a signed .xpi to dist/.
 * Requires AMO API credentials — set them in .env or export before running.
 *
 * Get keys: https://addons.mozilla.org/developers/addon/api/key/
 */
const fs   = require('fs');
const path = require('path');

// Load .env if present
try {
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
} catch {}

const { AMO_JWT_ISSUER, AMO_JWT_SECRET } = process.env;

const ROOT    = path.resolve(__dirname, '..');
const DIST    = path.resolve(ROOT, 'dist');
const STAGING = path.join(DIST, '_firefox-staging');

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
  delete base.background.service_worker;
  delete base.background.type;
  base.background.scripts = ['background.js'];
  base.browser_specific_settings = {
    gecko: { id: 'nomusic@nomusic', strict_min_version: '109.0' },
  };
  return JSON.stringify(base, null, 2);
}

function stage() {
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  fs.writeFileSync(path.join(STAGING, 'manifest.json'), buildFirefoxManifest());

  for (const entry of ENTRIES) {
    const src = path.join(ROOT, entry);
    const dst = path.join(STAGING, entry);
    if (!fs.existsSync(src)) { console.warn(`  [warn] missing: ${entry}`); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.statSync(src).isDirectory()
      ? fs.cpSync(src, dst, { recursive: true })
      : fs.copyFileSync(src, dst);
  }
}

async function main() {
  if (!AMO_JWT_ISSUER || !AMO_JWT_SECRET) {
    console.error('Missing env vars: AMO_JWT_ISSUER and AMO_JWT_SECRET  (see .env.example)');
    console.error('Get keys: https://addons.mozilla.org/developers/addon/api/key/');
    process.exit(1);
  }

  console.log('[sign-firefox] Staging extension files …');
  stage();

  console.log('[sign-firefox] Signing via AMO (may take 1–2 minutes) …');
  const webExt = require('web-ext');
  try {
    await webExt.cmd.sign(
      {
        amoBaseUrl:   'https://addons.mozilla.org/api/v5/',
        sourceDir:    STAGING,
        artifactsDir: DIST,
        channel:      'unlisted',
        apiKey:       AMO_JWT_ISSUER,
        apiSecret:    AMO_JWT_SECRET,
      },
      { shouldExitProgram: false }
    );
    console.log('[sign-firefox] Signed XPI saved to dist/');
  } finally {
    fs.rmSync(STAGING, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
