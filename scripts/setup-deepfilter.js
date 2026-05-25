'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CDN_BASE  = 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3';
const WASM_URL  = `${CDN_BASE}/v2/pkg/df_bg.wasm`;
const MODEL_URL = `${CDN_BASE}/v2/models/DeepFilterNet3_onnx.tar.gz`;

const audioDir   = path.resolve(__dirname, '..', 'audio');
const WASM_DST   = path.join(audioDir, 'df_bg.wasm');
const MODEL_DST  = path.join(audioDir, 'deepfilter3.tar.gz');
const WORKLET_DST = path.join(audioDir, 'processor.worklet.js');

// ── Extract and patch worklet code ───────────────────────────────────────────

function extractWorkletCode() {
  const src  = path.resolve(__dirname, '..', 'node_modules', 'deepfilternet3-noise-filter', 'dist', 'index.esm.js');
  const text = fs.readFileSync(src, 'utf8');

  const start = text.indexOf('workletCode = ') + 'workletCode = '.length;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"')  break;
    i++;
  }
  let decoded = JSON.parse(text.slice(start, i + 1));

  // Rename so our content.js can always address 'nomusic-enhancer'
  decoded = decoded.replace(
    "registerProcessor('deepfilter-audio-processor',",
    "registerProcessor('nomusic-enhancer',"
  );

  return decoded;
}

// ── Download with redirect support ───────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  skip (exists): ${path.basename(dest)}`);
      return resolve();
    }
    process.stdout.write(`  downloading:   ${path.basename(dest)} … `);
    const file = fs.createWriteStream(dest);

    function get(u) {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', chunk => {
          received += chunk.length;
          if (total) process.stdout.write(`\r  downloading:   ${path.basename(dest)} … ${Math.round(received / total * 100)}%`);
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); console.log('  done'); resolve(); });
        file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
      }).on('error', (e) => { fs.unlinkSync(dest); reject(e); });
    }
    get(url);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[setup-deepfilter] Writing worklet …');
  fs.writeFileSync(WORKLET_DST, extractWorkletCode());
  console.log('  wrote audio/processor.worklet.js');

  console.log('[setup-deepfilter] Fetching WASM …');
  await download(WASM_URL, WASM_DST);

  console.log('[setup-deepfilter] Fetching model (may be large) …');
  await download(MODEL_URL, MODEL_DST);

  console.log('[setup-deepfilter] Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
