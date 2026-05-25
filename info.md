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

## Installation

NoMusic is not on any browser extension store. Install it manually using the instructions below.

**Requirements:**
- Node.js 18+ and npm (for the one-time build step)
- Chrome / Chromium 88+ **or** Firefox 128+

---

### Step 1 — Build

In a terminal, navigate to the repository root and run:

```
npm install
npm run build
```

This does three things:
1. Downloads the DeepFilterNet3 WASM binary (~9.6 MB) and model weights (~7.9 MB) into the `audio/` folder.
2. Packages `dist/nomusic-chrome.zip` for Chrome Web Store upload.
3. Packages `dist/nomusic-firefox.xpi` for Firefox (unsigned, for temporary/dev install).

Only needs to run once. Re-run if you update packages or delete the `audio/` assets.

---

### Chrome / Chromium (unpacked)

Works in Chrome, Edge, Brave, Arc, and any Chromium-based browser.

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the repository root folder (the one containing `manifest.json`).
5. NoMusic will appear in your extensions list. Pin it to the toolbar via the puzzle-piece icon.

**To update after pulling changes:** re-run `npm install && npm run build` if `package.json` changed, then click the refresh icon on the NoMusic card at `chrome://extensions`.

---

### Firefox 128+ (XPI)

The build produces `dist/nomusic-firefox.xpi` — a self-contained package with the Firefox manifest already inside.

**Temporary install (no signing required — development use):**

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `dist/nomusic-firefox.xpi`.
4. NoMusic will appear in the Add-ons bar for this browser session. It is removed when Firefox closes; repeat step 3 to reload it.

**Permanent install (requires AMO signing or `xpinstall.signatures.required = false`):**

For personal/developer use without going through the Mozilla Add-on store:
1. In Firefox, navigate to `about:config`
2. Set `xpinstall.signatures.required` to `false` (only available in Firefox Developer Edition or Nightly).
3. Drag and drop `dist/nomusic-firefox.xpi` onto a Firefox window, or open it via **File → Open File**.

---

**Note on first use:** The first time you enable NoMusic on a tab, the extension loads ~17 MB of WASM and model data into the AudioWorklet. Expect a 1–3 second delay before audio processing begins.

**To uninstall Chrome:** click **Remove** on the NoMusic card at `chrome://extensions`.
**To uninstall Firefox:** go to `about:addons` and remove NoMusic.

---

## Publishing (Store Release)

These steps sign and submit the extension to the Chrome Web Store and AMO (Firefox). Run `npm run build` first so the zip/xpi packages are current.

### Credential setup (one-time)

Copy `.env.example` to `.env` and fill in the values. The `.env` file is gitignored — never commit it.

```
cp .env.example .env
```

**Firefox (AMO):**
1. Go to https://addons.mozilla.org/developers/addon/api/key/
2. Generate a new JWT API credential pair.
3. Set `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in `.env`.

**Chrome Web Store:**
1. Go to https://chrome.google.com/webstore/devconsole and create the extension entry (first time only — upload the zip manually to get an extension ID).
2. Follow the OAuth setup guide at https://developer.chrome.com/docs/webstore/using-api#beforeyoubegin to create a Google Cloud project, OAuth2 client, and obtain a refresh token with the `chromewebstore` scope.
3. Set `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, and `CHROME_REFRESH_TOKEN` in `.env`.

---

### Release commands

| Command | What it does |
|---|---|
| `npm run build` | Download assets + package both zips |
| `npm run pack:chrome` | Re-package `dist/nomusic-chrome.zip` only |
| `npm run pack:firefox` | Re-package `dist/nomusic-firefox.xpi` only |
| `npm run publish:chrome` | Upload zip to CWS + submit for Google review |
| `npm run sign:firefox` | Sign XPI via AMO → saves signed `.xpi` to `dist/` |
| `npm run release` | Full pipeline: build → publish Chrome → sign Firefox |

**Chrome review timeline:** Google typically takes 1–3 business days to review and publish an update.

**Firefox signing:** `npm run sign:firefox` submits the extension to AMO's automated signing service and downloads the signed XPI back to `dist/`. For an unlisted extension (self-hosted), this usually completes in under 2 minutes. The signed file will be named something like `nomusic-1.0.0.xpi` in `dist/`.
