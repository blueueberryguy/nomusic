# NoMusic — Extension Info

## What It Does

NoMusic is a Chrome extension that removes background music from video and audio streams in real time, leaving only the human voice. It works on any site without requiring page-specific configuration.

---

## How Background Audio Suppression Works

Suppression runs entirely in-browser using an AudioWorklet processor (`audio/processor.worklet.js`). No audio data leaves your machine.

### Pipeline

1. **Intercept** — The content script attaches to every `<audio>` and `<video>` element on the page.
   - First attempt: `createMediaElementSource()` — cleanest path; Chrome silences the element and routes audio into the Web Audio graph automatically.
   - Fallback: `captureStream()` — used when the first attempt fails due to CORS restrictions. The element is muted manually and its stream is fed into the graph instead.

2. **Buffer & Window** — Incoming audio is buffered into 512-sample frames with a 50% overlap (256-sample hop). A Hann window is applied to each frame before transform.

3. **FFT** — A pure Cooley-Tukey DIT FFT converts each windowed frame into the frequency domain.

4. **Background Estimation** — A slow-adapting per-bin power estimate tracks the background (i.e., music). The adaptation rate (`noiseAlpha ≈ 0.9997`) gives a ~3-second half-life, long enough to lock onto sustained music without tracking transient speech.
   - At voice-frequency bins, adaptation is further slowed so momentary speech doesn't corrupt the music estimate.

5. **Wiener Gain** — A per-bin gain is computed:
   ```
   H(k) = max(spectralFloor, 1 − overSubtract × noiseEst[k] / signal[k])
   ```
   - `overSubtract` controls aggressiveness. It is reduced at voice-protected bins to preserve speech.
   - `spectralFloor` (default 0.05) prevents any bin from going fully silent, which reduces musical noise artifacts.

6. **Voice-Frequency Protection** — Each FFT bin is assigned a protection weight based on its frequency:
   | Range | Weight | Behavior |
   |---|---|---|
   | < 80 Hz | 0.00 | Suppress freely (sub-bass) |
   | 80–300 Hz | 0.20 | Light protection (low fundamentals) |
   | 300–3500 Hz | 0.85 | Strong protection (core speech formants) |
   | 3500–8000 Hz | 0.50 | Moderate protection (sibilants) |
   | > 8000 Hz | 0.10 | Mostly suppress (high-frequency music) |

7. **IFFT + Overlap-Add** — The filtered spectrum is inverse-transformed and added back into a running output buffer. Because Hann at 50% overlap satisfies the COLA condition (sum = 1), no synthesis window or extra scaling is needed.

8. **Strength Slider** — The popup slider maps 0–100% to an `overSubtract` range of 1.0–3.5. Higher values are more aggressive but may affect voice quality at the extremes.

### AudioContext Lifecycle

- The `AudioContext` is created on first enable and closed on disable. Closing it automatically releases all `createMediaElementSource` bindings, restoring each element's native audio output with no leftover side effects.
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

**Requirements:** Google Chrome or any Chromium-based browser (Edge, Brave, Arc, etc.)

**Steps:**

1. Download or clone this repository to a folder on your computer.

2. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** using the toggle in the top-right corner of the Extensions page.

4. Click **Load unpacked**.

5. Select the root folder of this repository (the folder that contains `manifest.json`).

6. The NoMusic extension will appear in your extensions list. Pin it to the toolbar for quick access by clicking the puzzle-piece icon and pinning NoMusic.

**To update after pulling new changes:** go back to `chrome://extensions` and click the refresh icon on the NoMusic card, or click **Update** if the button appears.

**To uninstall:** click **Remove** on the NoMusic card in `chrome://extensions`.
