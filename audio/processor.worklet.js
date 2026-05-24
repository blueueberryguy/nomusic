/**
 * AudioWorkletProcessor — real-time music suppression via STFT Wiener filtering.
 *
 * Algorithm:
 *   1. Buffer input into overlapping frames (512 samples, 50% hop).
 *   2. Apply Hann analysis window and forward FFT.
 *   3. Maintain a slow-adapting power estimate of the background (≈ music).
 *   4. Apply a per-bin Wiener gain that suppresses the background estimate
 *      while protecting bins in the 300–3500 Hz speech range.
 *   5. IFFT + overlap-add for continuous output.
 *
 * The Hann window at 50% overlap satisfies COLA (sum = 1), so no synthesis
 * window or extra scale factor is needed for OLA reconstruction.
 */

const FFT_SIZE = 512;
const HOP_SIZE = 256; // 50% overlap

// ─── Pure Cooley-Tukey DIT FFT ───────────────────────────────────────────────
function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -Math.PI / half;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(ang * k);
        const sin = Math.sin(ang * k);
        const tRe = cos * re[i + k + half] - sin * im[i + k + half];
        const tIm = cos * im[i + k + half] + sin * re[i + k + half];
        re[i + k + half] = re[i + k] - tRe;
        im[i + k + half] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
      }
    }
  }
}

function ifft(re, im) {
  const n = re.length;
  // Conjugate → FFT → conjugate → normalise
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { im[i] = -im[i]; re[i] /= n; im[i] /= n; }
}

// ─── Per-channel processing state ────────────────────────────────────────────
function makeChannelState(fftSize, sampleRate) {
  const N2 = fftSize / 2 + 1;

  // Voice-frequency protection weight per FFT bin.
  // Higher = protect this bin more (less aggressive suppression).
  const binHz = sampleRate / fftSize;
  const voiceWeight = new Float32Array(N2);
  for (let k = 0; k < N2; k++) {
    const hz = k * binHz;
    if      (hz <  80)   voiceWeight[k] = 0.00;  // sub-bass: suppress freely
    else if (hz <  300)  voiceWeight[k] = 0.20;  // low fundamentals
    else if (hz < 3500)  voiceWeight[k] = 0.85;  // core speech formants: protect
    else if (hz < 8000)  voiceWeight[k] = 0.50;  // sibilants / upper harmonics
    else                 voiceWeight[k] = 0.10;  // high freq: mostly music
  }

  return {
    inBuf:      new Float32Array(fftSize),
    inFill:     0,
    outQueue:   [],
    olaBuf:     new Float32Array(fftSize * 2), // double-length ring buffer
    olaPos:     0,
    noiseEst:   new Float32Array(N2).fill(1e-8),
    initialized: false,
    voiceWeight,
  };
}

// ─── Processor ───────────────────────────────────────────────────────────────
class SpeechEnhancer extends AudioWorkletProcessor {
  constructor() {
    super();

    this.fftSize  = FFT_SIZE;
    this.hopSize  = HOP_SIZE;
    this.enabled  = true;

    // Wiener filter parameters (tunable at runtime from popup)
    this.noiseAlpha    = 0.9997; // background estimation rate (~3 s half-life at 48 kHz)
    this.overSubtract  = 2.2;    // aggressiveness (higher → more suppression)
    this.spectralFloor = 0.05;   // minimum Wiener gain (prevents full silence)

    // Hann analysis window
    this.window = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.fftSize));
    }

    // Working arrays (re-used every frame to avoid GC)
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);

    // Up to 2 channels of per-channel state
    this.chState = [
      makeChannelState(this.fftSize, sampleRate),
      makeChannelState(this.fftSize, sampleRate),
    ];

    this.port.onmessage = ({ data }) => {
      if (data.noiseAlpha    !== undefined) this.noiseAlpha    = data.noiseAlpha;
      if (data.overSubtract  !== undefined) this.overSubtract  = data.overSubtract;
      if (data.spectralFloor !== undefined) this.spectralFloor = data.spectralFloor;
      if (data.enabled       !== undefined) this.enabled       = data.enabled;
    };
  }

  /** Process one 512-sample frame for a single channel. */
  processFrame(st) {
    const N  = this.fftSize;
    const N2 = N / 2 + 1;
    const re = this.re;
    const im = this.im;

    // Windowed input
    for (let i = 0; i < N; i++) { re[i] = st.inBuf[i] * this.window[i]; im[i] = 0; }

    fft(re, im);

    // Power spectrum + phase
    const power = new Float32Array(N2);
    const phase = new Float32Array(N2);
    for (let k = 0; k < N2; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // First frame: seed the noise estimate
    if (!st.initialized) { st.noiseEst.set(power); st.initialized = true; }

    // Slow background power estimate.
    // At voice bins, adapt even more slowly so momentary speech doesn't
    // corrupt the music estimate.
    for (let k = 0; k < N2; k++) {
      const alpha = this.noiseAlpha + (1 - this.noiseAlpha) * st.voiceWeight[k] * 0.6;
      st.noiseEst[k] = alpha * st.noiseEst[k] + (1 - alpha) * power[k];
    }

    // Per-bin Wiener gain: H(k) = max(floor, 1 − α·noise/signal)
    // Reduce oversubtraction aggressiveness at protected voice bins.
    for (let k = 0; k < N2; k++) {
      const sig = Math.max(power[k], 1e-12);
      const alpha = this.overSubtract * (1 - st.voiceWeight[k] * 0.75);
      const H = Math.max(this.spectralFloor, 1 - alpha * st.noiseEst[k] / sig);
      const mag = Math.sqrt(power[k]) * H;
      re[k] = mag * Math.cos(phase[k]);
      im[k] = mag * Math.sin(phase[k]);
    }
    // Conjugate symmetry for real IFFT
    for (let k = N2; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }

    ifft(re, im);

    // Overlap-add (no synthesis window needed; Hann COLA at 50% overlap = 1)
    const olaLen = st.olaBuf.length;
    for (let j = 0; j < N; j++) {
      st.olaBuf[(st.olaPos + j) % olaLen] += re[j];
    }
    for (let j = 0; j < this.hopSize; j++) {
      const pos = (st.olaPos + j) % olaLen;
      st.outQueue.push(st.olaBuf[pos]);
      st.olaBuf[pos] = 0;
    }
    st.olaPos = (st.olaPos + this.hopSize) % olaLen;

    // Shift input buffer by one hop
    st.inBuf.copyWithin(0, this.hopSize);
    st.inFill = N - this.hopSize;
  }

  process(inputs, outputs) {
    const inputChannels  = (inputs[0]  || []);
    const outputChannels = (outputs[0] || []);
    const numCh = Math.min(Math.max(inputChannels.length, 1), 2);

    for (let c = 0; c < numCh; c++) {
      const inData = inputChannels[c];
      if (!inData) continue;
      const st = this.chState[c];

      if (!this.enabled) {
        // Bypass: copy input straight through
        if (outputChannels[c]) outputChannels[c].set(inData);
        continue;
      }

      // Buffer incoming 128-sample block
      for (let i = 0; i < inData.length; i++) {
        st.inBuf[st.inFill++] = inData[i];
        if (st.inFill >= this.fftSize) this.processFrame(st);
      }

      // Drain the output queue into the output buffer
      const out = outputChannels[c];
      if (out) {
        for (let i = 0; i < out.length; i++) {
          out[i] = st.outQueue.length ? st.outQueue.shift() : 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('nomusic-enhancer', SpeechEnhancer);
