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

  // Firefox fix: the AudioWorkletNode constructor passes processorOptions from the
  // extension content-script sandbox to the worklet thread via structured clone.
  // Firefox rejects this cross-compartment clone even for plain objects, causing
  // processorOptions to arrive as undefined (or throwing DataCloneError). The fix:
  //   1. Remove all reliance on processorOptions / postMessage binary transfers.
  //   2. Have the worklet self-bootstrap by fetching resources at relative URLs
  //      (resolves to the extension's audio/ dir inside AudioWorkletGlobalScope).
  //   3. Accept all messages as JSON strings (strings are primitives, always safe).
  decoded = patchWorkletForFirefox(decoded);

  return decoded;
}

function patchWorkletForFirefox(code) {
  // ── 1. Add module-level caches before the class definition ──────────────────
  code = code.replace(
    '\n    class DeepFilterAudioProcessor extends AudioWorkletProcessor {',
    `\n    // Module-level caches shared across all instances in this AudioWorkletGlobalScope.
    let _wasmInitialized = false;
    let _modelBuffer = null;

    class DeepFilterAudioProcessor extends AudioWorkletProcessor {`
  );

  // ── 2. Replace the broken constructor body ───────────────────────────────────
  // The npm package embeds initSync(processorOptions.wasmModule) in a try/catch.
  // Firefox cannot structured-clone ANY object from the extension sandbox, so
  // processorOptions always arrives as undefined. Replace the whole try/catch with
  // a buffer-receiver pattern: content.js fetches WASM+model and sends them as raw
  // ArrayBuffers (no object wrapper), which bypasses the DataCloneError restriction.
  code = code.replace(
    /(\s+this\.inputBuffer = new Float32Array\(this\.bufferSize\);\s+this\.outputBuffer = new Float32Array\(this\.bufferSize\);)\s+try \{[\s\S]*?\}\s+catch \([^)]+\) \{[\s\S]*?\}\s+(this\.port\.onmessage)/,
    (_, bufInit, portPart) => `${bufInit}
            this._suppressionLevel = 50;
            this._buffersReceived = 0;
            ${portPart}`
  );

  // ── 3. Update port.onmessage to route strings to handleMessage, ArrayBuffers to _handleBuffer
  code = code.replace(
    'this.port.onmessage = (event) => {\n                this.handleMessage(event.data);\n            };',
    `this.port.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    this.handleMessage(JSON.parse(event.data));
                } else if (event.data instanceof ArrayBuffer) {
                    this._handleBuffer(event.data);
                }
            };`
  );

  // ── 4. Insert _handleBuffer and _initModel before handleMessage ───────────────
  const bufferMethods = `        _handleBuffer(buf) {
            this._buffersReceived++;
            if (this._buffersReceived === 1) {
                if (!_wasmInitialized) {
                    initSync(buf);
                    _wasmInitialized = true;
                }
            } else if (this._buffersReceived === 2) {
                if (!_modelBuffer) {
                    _modelBuffer = buf;
                }
                this._initModel();
            }
        }
        _initModel() {
            const mb = new Uint8Array(_modelBuffer);
            const h = df_create(mb, this._suppressionLevel);
            const fl = df_get_frame_length(h);
            this.dfModel = { handle: h, frameLength: fl };
            this.bufferSize = fl * 4;
            this.inputBuffer = new Float32Array(this.bufferSize);
            this.outputBuffer = new Float32Array(this.bufferSize);
            this.tempFrame = new Float32Array(fl);
            this.isInitialized = true;
        }
        `;
  code = code.replace('        handleMessage(data) {', bufferMethods + 'handleMessage(data) {');

  // ── 5. Update SET_SUPPRESSION_LEVEL to store level before model is ready ─────
  code = code.replace(
    /case WorkletMessageTypes\.SET_SUPPRESSION_LEVEL:\s+if \(this\.dfModel && typeof data\.value === 'number'\) \{/,
    `case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:
                    if (typeof data.value === 'number') {
                        this._suppressionLevel = Math.max(0, Math.min(100, Math.floor(data.value)));
                        if (this.dfModel) {`
  );
  // Close the extra if block for dfModel that was added
  code = code.replace(
    /(\s+df_set_atten_lim\(this\.dfModel\.handle,\s*level\);)\s+\}\s+break;\s+case WorkletMessageTypes\.SET_BYPASS:/,
    (_, atten) => `${atten}
                        }
                    }
                    break;
                case WorkletMessageTypes.SET_BYPASS:`
  );

  return code;
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
