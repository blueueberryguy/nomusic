'use strict';
/**
 * Uploads dist/nomusic-chrome.zip to the Chrome Web Store and triggers a
 * publish (review submission).  Requires four env vars — set them in .env
 * or export them before running.
 *
 * One-time OAuth setup:
 *   https://developer.chrome.com/docs/webstore/using-api#beforeyoubegin
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

const {
  CHROME_EXTENSION_ID,
  CHROME_CLIENT_ID,
  CHROME_CLIENT_SECRET,
  CHROME_REFRESH_TOKEN,
} = process.env;

const ZIP = path.resolve(__dirname, '..', 'dist', 'nomusic-chrome.zip');

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CHROME_CLIENT_ID,
      client_secret: CHROME_CLIENT_SECRET,
      refresh_token: CHROME_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function main() {
  for (const [k, v] of [
    ['CHROME_EXTENSION_ID',  CHROME_EXTENSION_ID],
    ['CHROME_CLIENT_ID',     CHROME_CLIENT_ID],
    ['CHROME_CLIENT_SECRET', CHROME_CLIENT_SECRET],
    ['CHROME_REFRESH_TOKEN', CHROME_REFRESH_TOKEN],
  ]) {
    if (!v) { console.error(`Missing env var: ${k}  (see .env.example)`); process.exit(1); }
  }
  if (!fs.existsSync(ZIP)) {
    console.error('dist/nomusic-chrome.zip not found — run: npm run pack:chrome');
    process.exit(1);
  }

  console.log('[publish-chrome] Fetching OAuth access token …');
  const token = await getAccessToken();

  console.log('[publish-chrome] Uploading …');
  const uploadRes = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CHROME_EXTENSION_ID}`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
      body:    fs.readFileSync(ZIP),
    }
  );
  const upload = await uploadRes.json();
  console.log('  uploadState:', upload.uploadState);
  if (upload.uploadState !== 'SUCCESS') {
    console.error('  detail:', JSON.stringify(upload.itemError ?? upload, null, 2));
    process.exit(1);
  }

  console.log('[publish-chrome] Submitting for review …');
  const pubRes = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${CHROME_EXTENSION_ID}/publish`,
    {
      method:  'POST',
      headers: {
        Authorization:    `Bearer ${token}`,
        'x-goog-api-version': '2',
        'Content-Length': '0',
      },
    }
  );
  const pub = await pubRes.json();
  console.log('  status:', pub.status);
  if (!pub.status?.includes('OK')) {
    console.error('  detail:', JSON.stringify(pub, null, 2));
    process.exit(1);
  }
  console.log('[publish-chrome] Done — submitted for Google review (typically 1–3 days).');
}

main().catch(e => { console.error(e.message); process.exit(1); });
