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

  // ── Firefox fix: nothing large in processorOptions ───────────────────────────
  // Firefox rejects structured-clone of both large ArrayBuffers AND
  // WebAssembly.Module objects when passed via AudioWorkletNode processorOptions.
  // Solution: processorOptions carries only the plain number suppressionLevel;
  // WASM module and model bytes are delivered via port.postMessage after the node
  // is created, which uses a separate (working) cross-thread transfer path.

  // Patch 1 — constructor: strip entire try/catch, just store suppressionLevel
  // and always set up port.onmessage so messages can be received immediately.
  decoded = decoded.replace(
    `            try {\n                // Initialize WASM from pre-compiled module\n                initSync(options.processorOptions.wasmModule);\n                const modelBytes = new Uint8Array(options.processorOptions.modelBytes);\n                const handle = df_create(modelBytes, options.processorOptions.suppressionLevel ?? 50);\n                const frameLength = df_get_frame_length(handle);\n                this.dfModel = { handle, frameLength };\n                this.bufferSize = frameLength * 4;\n                this.inputBuffer = new Float32Array(this.bufferSize);\n                this.outputBuffer = new Float32Array(this.bufferSize);\n                // Pre-allocate temp frame buffer for processing\n                this.tempFrame = new Float32Array(frameLength);\n                this.isInitialized = true;\n                this.port.onmessage = (event) => {\n                    this.handleMessage(event.data);\n                };\n            }\n            catch (error) {\n                console.error('Failed to initialize DeepFilter in AudioWorklet:', error);\n                this.isInitialized = false;\n            }`,
    `            this._suppressionLevel = options.processorOptions?.suppressionLevel ?? 50;\n            this.port.onmessage = (event) => {\n                this.handleMessage(event.data);\n            };`
  );

  // Patch 2 — handleMessage: add LOAD_WASM (initSync) and LOAD_MODEL (df_create)
  decoded = decoded.replace(
    `case WorkletMessageTypes.SET_BYPASS:\n                    this.bypass = Boolean(data.value);\n                    break;\n            }\n        }`,
    `case WorkletMessageTypes.SET_BYPASS:\n                    this.bypass = Boolean(data.value);\n                    break;\n                case 'LOAD_WASM':\n                    try {\n                        initSync(data.wasmModule);\n                    } catch (_e) {\n                        console.error('[NoMusic] WASM init failed:', _e);\n                    }\n                    break;\n                case 'LOAD_MODEL':\n                    try {\n                        const _mb = new Uint8Array(data.modelBytes);\n                        const _h = df_create(_mb, this._suppressionLevel);\n                        const _fl = df_get_frame_length(_h);\n                        this.dfModel = { handle: _h, frameLength: _fl };\n                        this.bufferSize = _fl * 4;\n                        this.inputBuffer = new Float32Array(this.bufferSize);\n                        this.outputBuffer = new Float32Array(this.bufferSize);\n                        this.tempFrame = new Float32Array(_fl);\n                        this.isInitialized = true;\n                    } catch (_e) {\n                        console.error('[NoMusic] Model load failed:', _e);\n                    }\n                    break;\n            }\n        }`
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
