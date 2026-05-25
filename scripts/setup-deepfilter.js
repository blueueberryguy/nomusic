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
  // Keep the auto-generated WASM glue verbatim (everything before WorkletMessageTypes),
  // then replace the entire processor class with our Firefox-compatible version.
  // This avoids brittle regex patching against the npm package's class internals.
  const wasmEnd = code.indexOf('\n    const WorkletMessageTypes');
  if (wasmEnd === -1) throw new Error('[setup-deepfilter] Cannot locate WorkletMessageTypes in worklet');

  return code.slice(0, wasmEnd) + `
    const WorkletMessageTypes = {
        SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',
        SET_BYPASS: 'SET_BYPASS'
    };

    // Module-level caches shared across all instances in this AudioWorkletGlobalScope.
    let _wasmInitialized = false;
    let _modelBuffer = null;

    class DeepFilterAudioProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super();
            this.dfModel = null;
            this.inputWritePos = 0;
            this.inputReadPos = 0;
            this.outputWritePos = 0;
            this.outputReadPos = 0;
            this.bypass = false;
            this.isInitialized = false;
            this.tempFrame = null;
            this.bufferSize = 8192;
            this.inputBuffer = new Float32Array(this.bufferSize);
            this.outputBuffer = new Float32Array(this.bufferSize);
            this._suppressionLevel = 50;
            this._buffersReceived = 0;
            // Firefox extension sandbox cannot structured-clone objects to the AudioWorklet
            // thread. content.js sends WASM+model as raw ArrayBuffers (no object wrapper),
            // which bypasses the DataCloneError restriction. Strings are safe primitives.
            this.port.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    this.handleMessage(JSON.parse(event.data));
                } else if (event.data instanceof ArrayBuffer) {
                    this._handleBuffer(event.data);
                }
            };
        }
        _handleBuffer(buf) {
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
        handleMessage(data) {
            switch (data.type) {
                case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:
                    if (typeof data.value === 'number') {
                        const level = Math.max(0, Math.min(100, Math.floor(data.value)));
                        this._suppressionLevel = level;
                        if (this.dfModel) {
                            df_set_atten_lim(this.dfModel.handle, level);
                        }
                    }
                    break;
                case WorkletMessageTypes.SET_BYPASS:
                    this.bypass = Boolean(data.value);
                    break;
            }
        }
        getInputAvailable() {
            return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;
        }
        getOutputAvailable() {
            return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;
        }
        process(inputList, outputList) {
            const sourceLimit = Math.min(inputList.length, outputList.length);
            const input = inputList[0]?.[0];
            if (!input) {
                return true;
            }
            if (!this.isInitialized || !this.dfModel || this.bypass || !this.tempFrame) {
                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
                    const output = outputList[inputNum];
                    const channelCount = output.length;
                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {
                        output[channelNum].set(input);
                    }
                }
                return true;
            }
            for (let i = 0; i < input.length; i++) {
                this.inputBuffer[this.inputWritePos] = input[i];
                this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
            }
            const frameLength = this.dfModel.frameLength;
            while (this.getInputAvailable() >= frameLength) {
                for (let i = 0; i < frameLength; i++) {
                    this.tempFrame[i] = this.inputBuffer[this.inputReadPos];
                    this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
                }
                const processed = df_process_frame(this.dfModel.handle, this.tempFrame);
                for (let i = 0; i < processed.length; i++) {
                    this.outputBuffer[this.outputWritePos] = processed[i];
                    this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
                }
            }
            const outputAvailable = this.getOutputAvailable();
            if (outputAvailable >= 128) {
                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
                    const output = outputList[inputNum];
                    const channelCount = output.length;
                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {
                        const outputChannel = output[channelNum];
                        let readPos = this.outputReadPos;
                        for (let i = 0; i < 128; i++) {
                            outputChannel[i] = this.outputBuffer[readPos];
                            readPos = (readPos + 1) % this.bufferSize;
                        }
                    }
                }
                this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;
            }
            return true;
        }
    }
    registerProcessor('nomusic-enhancer', DeepFilterAudioProcessor);

})();
`;
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
