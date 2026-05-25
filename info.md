# NoMusic — Extension Info

## What It Does

NoMusic is a Chrome extension that removes background music from video and audio streams in real time, leaving only the human voice. It works on any site without requiring page-specific configuration.

---

## How Background Audio Suppression Works

Suppression runs entirely in-browser using a DeepFilterNet3 AudioWorklet processor (`audio/processor.worklet.js`). No audio data leaves your machine.

### Algorithm — DeepFilterNet3

NoMusic uses **DeepFilterNet3**, a deep neural network trained to separate speech from all types of background noise — including tonal music, which simpler signal-processing approaches struggle with. The model runs inside a Web Audio `AudioWorkletProcessor` compiled to WebAssembly.

DeepFilterNet3 operates in two stages on every audio frame:
- **ERB-based sub-band filtering** — The spectrum is decomposed into Equivalent Rectangular Bandwidth bands that match human auditory perception. A recurrent network estimates a complex ratio filter for each band, attenuating non-speech energy while preserving speech harmonics and formants.
- **Deep filtering** — A second network refines the output in the high-frequency region where tonal music artifacts concentrate, applying a frame-level complex mask that would be too expensive to apply across all bands.

The result is clean, natural-sounding speech even in the presence of broadcast-level background music — something a hand-tuned Wiener filter cannot reliably achieve.

### Pipeline

1. **Intercept** — The content script attaches to every `<audio>` and `<video>` element on the page.
   - First attempt: `createMediaElementSource()` — cleanest path; Chrome silences the element and routes audio into the Web Audio graph automatically.
   - Fallback: `captureStream()` — used when the first attempt fails due to CORS restrictions. The element is muted manually and its stream is fed into the graph instead.

2. **Worklet init** — On first enable, the content script fetches `df_bg.wasm` (the compiled DeepFilterNet3 Rust module) and `deepfilter3.tar.gz` (the ONNX model weights) from the extension's local files and passes them into the `AudioWorkletNode` via `processorOptions`. The worklet calls `initSync()` and `df_create()` once to set up the model state. All subsequent processing happens on the AudioWorklet thread, keeping the main thread free.

3. **Frame processing** — The worklet processes audio at 48 kHz in mono. Each call to `process()` feeds samples into the DeepFilterNet3 frame buffer, and the model outputs filtered samples with a small, fixed latency.

4. **Strength slider** — The popup slider (0–100%) maps directly to DeepFilterNet3's attenuation limit (`suppressionLevel` 0–100). Lower values let some background music through; 100 applies maximum suppression.

5. **Output** — Filtered audio flows to `AudioContext.destination` and plays normally. The visual and playback state of the original element (seek position, pause/play, volume) is unaffected.

### AudioContext Lifecycle

- The `AudioContext` is created on first enable and **kept alive** for the lifetime of the page. Closing it would sever the `createMediaElementSource` binding and freeze the stream, so disable instead puts the worklet into bypass mode (`SET_BYPASS: true`), passing audio through unmodified without tearing down the graph.
- Re-enabling sends `SET_BYPASS: false` to resume DeepFilterNet3 processing immediately.
- If the context is suspended (browser policy before user gesture), it resumes on the next click, keydown, or touchstart event.
- A `MutationObserver` watches for dynamically added/removed `<audio>` and `<video>` elements so streams that appear after page load are also intercepted.

---

## Blacklist Setting

The extension has two operating modes, switchable from the popup or the Options page.

### All Sites (default)
NoMusic is active on every page when enabled. No configuration needed.

### Blacklist Mode
NoMusic is active **only** on pages whose URL matches a pattern in the blacklist. All other pages are left unprocessed.

**Managing the blacklist:**
- In the popup (when Blacklist mode is selected), click **+ Add this site** to add the current page's origin (e.g., `https://twitch.tv/*`) in one click.
- Open **Options** (or **Manage page list** in the popup) for full CRUD — add patterns manually, remove individual entries, and save.
- Changes take effect immediately on already-open tabs without a reload. Single-page apps that navigate via `pushState`/`replaceState` are also rechecked automatically.

---

## URL Pattern Qualifications

Blacklist entries are glob patterns. Only the `*` character is treated as a wildcard — all other regex characters are matched literally.

**Rules:**
- Must start with `https://`, `http://`, or `*`.
- `*` expands to match any sequence of characters (including slashes).
- Matching is case-insensitive and anchored (the full URL must match from start to end).

**Examples:**

| Pattern | Matches |
|---|---|
| `https://twitch.tv/*` | All pages on twitch.tv |
| `https://www.youtube.com/watch?v=*` | YouTube watch pages only |
| `https://example.com/live` | That exact URL only |
| `*://*.example.com/*` | Any subdomain of example.com, any protocol |

When you click **+ Add this site** in the popup, the pattern is automatically set to `origin/*` (e.g., `https://twitch.tv/*`), which covers the entire domain.

---

## Installation (Developer Mode)

NoMusic is not on the Chrome Web Store. Install it manually by loading the unpacked extension.

**Requirements:**
- Google Chrome or any Chromium-based browser (Edge, Brave, Arc, etc.)
- Node.js 18+ and npm (for the one-time build step)

**Steps:**

1. Download or clone this repository to a folder on your computer.

2. In a terminal, navigate to the repository root and run:
   ```
   npm install
   npm run build
   ```
   This downloads the DeepFilterNet3 WASM binary (~9.6 MB) and model weights (~7.9 MB) into the `audio/` folder. It only needs to run once; re-run it if you update the package or delete the `audio/` assets.

3. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

4. Enable **Developer mode** using the toggle in the top-right corner of the Extensions page.

5. Click **Load unpacked**.

6. Select the root folder of this repository (the folder that contains `manifest.json`).

7. The NoMusic extension will appear in your extensions list. Pin it to the toolbar for quick access by clicking the puzzle-piece icon and pinning NoMusic.

**Note on first use:** The first time you enable NoMusic on a tab, the extension loads ~17 MB of WASM and model data. Expect a brief delay (1–3 seconds on most machines) before audio processing begins.

**To update after pulling new changes:** re-run `npm install && npm run build` if `package.json` changed, then go to `chrome://extensions` and click the refresh icon on the NoMusic card.

**To uninstall:** click **Remove** on the NoMusic card in `chrome://extensions`.
