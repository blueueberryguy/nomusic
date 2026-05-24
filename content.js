/**
 * NoMusic content script.
 *
 * Intercepts every <audio> and <video> element on the page, routes their audio
 * through the AudioWorklet speech-enhancer, and keeps the visual/playback state
 * of the original element intact.
 *
 * Interception strategy (tried in order):
 *   1. createMediaElementSource() — cleanest; automatically silences the element
 *      and routes audio to the AudioContext graph.
 *   2. element.captureStream() — fallback for cross-origin CORS failures; we
 *      mute the element ourselves and play through the processed MediaStream.
 */

const WORKLET_URL = chrome.runtime.getURL('audio/processor.worklet.js');

// ─── URL pattern matching ─────────────────────────────────────────────────────

/**
 * Returns true if url matches the glob pattern.
 * Only * is treated as a wildcard; all other regex chars are escaped.
 * Example patterns: "https://twitch.tv/*", "https://www.youtube.com/watch?v=*"
 */
function urlMatches(url, pattern) {
  try {
    const regexStr = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp('^' + regexStr + '$', 'i').test(url);
  } catch {
    return false;
  }
}

function shouldActivate({ enabled, mode, blacklist }) {
  if (!enabled) return false;
  if (mode === 'all' || !mode) return true;
  return (blacklist ?? []).some(p => urlMatches(window.location.href, p));
}

// ─── AudioInterceptor ────────────────────────────────────────────────────────

class AudioInterceptor {
  constructor() {
    this.ctx          = null;
    this.workletReady = false;
    /** @type {Map<HTMLMediaElement, object>} */
    this.handles      = new Map();
    this.enabled      = false;
    this.strength     = 0.7;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async setup() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    this.workletReady = true;
  }

  async enable() {
    this.enabled = true;
    try { await this.setup(); } catch (e) {
      console.error('[NoMusic] AudioContext setup failed:', e);
      return;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    for (const el of document.querySelectorAll('audio, video')) {
      this._attach(el);
    }
    this._startObserver();
    this._broadcastStatus();
  }

  disable() {
    this.enabled = false;
    this._stopObserver();
    for (const [el, h] of this.handles) {
      h.workletNode.disconnect();
      h.source.disconnect();
      if (h.strategy === 'capture') el.muted = false;
    }
    this.handles.clear();
    // Closing the context releases createMediaElementSource bindings,
    // which restores each element's native audio output.
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.workletReady = false;
    }
    this._broadcastStatus();
  }

  setStrength(strength) {
    this.strength = strength;
    const overSubtract = 1.0 + strength * 2.5;
    for (const h of this.handles.values()) {
      h.workletNode.port.postMessage({ overSubtract });
    }
  }

  // ── Element attachment ─────────────────────────────────────────────────────

  _attach(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (this.handles.has(el)) return;
    if (!this.workletReady) return;

    let handle = null;

    try {
      const source      = this.ctx.createMediaElementSource(el);
      const workletNode = this._makeWorkletNode();
      source.connect(workletNode);
      workletNode.connect(this.ctx.destination);
      handle = { source, workletNode, strategy: 'element' };
    } catch {
      try {
        const stream = el.captureStream?.();
        if (!stream) throw new Error('captureStream not available');
        const source      = this.ctx.createMediaStreamSource(stream);
        const workletNode = this._makeWorkletNode();
        source.connect(workletNode);
        workletNode.connect(this.ctx.destination);
        el.muted = true;
        handle = { source, workletNode, strategy: 'capture' };
      } catch (capErr) {
        console.warn('[NoMusic] Could not intercept element:', capErr.message);
        return;
      }
    }

    this.handles.set(el, handle);
    this._broadcastStatus();
  }

  _detach(el) {
    const h = this.handles.get(el);
    if (!h) return;
    h.workletNode.disconnect();
    h.source.disconnect();
    if (h.strategy === 'element') {
      try { h.source.connect(this.ctx.destination); } catch (_) {}
    } else if (h.strategy === 'capture') {
      el.muted = false;
    }
    this.handles.delete(el);
    this._broadcastStatus();
  }

  _makeWorkletNode() {
    const node = new AudioWorkletNode(this.ctx, 'nomusic-enhancer', {
      numberOfInputs:   1,
      numberOfOutputs:  1,
      channelCount:     2,
      channelCountMode: 'explicit',
    });
    node.port.postMessage({
      overSubtract:  1.0 + this.strength * 2.5,
      noiseAlpha:    0.9997,
      spectralFloor: 0.05,
      enabled:       true,
    });
    return node;
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  _startObserver() {
    if (this._observer) return;
    this._observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node instanceof HTMLMediaElement) {
            this._attach(node);
          } else {
            node.querySelectorAll?.('audio, video').forEach(el => this._attach(el));
          }
        }
        for (const node of m.removedNodes) {
          if (node instanceof HTMLMediaElement) this._detach(node);
        }
      }
    });
    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  _stopObserver() {
    this._observer?.disconnect();
    this._observer = null;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  _broadcastStatus() {
    chrome.runtime.sendMessage({
      type:    'CONTENT_STATUS',
      enabled: this.enabled,
      count:   this.handles.size,
    }).catch(() => {});
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const interceptor = new AudioInterceptor();

const resumeOnGesture = () => interceptor.ctx?.resume().catch(() => {});
document.addEventListener('click',     resumeOnGesture, { passive: true });
document.addEventListener('keydown',   resumeOnGesture, { passive: true });
document.addEventListener('touchstart', resumeOnGesture, { passive: true });

// Initial state load
chrome.storage.local.get(['enabled', 'strength', 'mode', 'blacklist'], (data) => {
  if (data.strength !== undefined) interceptor.strength = data.strength;
  if (shouldActivate(data)) interceptor.enable();
});

// React to storage changes (mode toggle, blacklist edits, master enable)
chrome.storage.onChanged.addListener((changes) => {
  if (!('enabled' in changes) && !('mode' in changes) && !('blacklist' in changes)) return;
  chrome.storage.local.get(['enabled', 'mode', 'blacklist'], (data) => {
    const active = shouldActivate(data);
    if (active && !interceptor.enabled)  interceptor.enable();
    if (!active && interceptor.enabled)  interceptor.disable();
  });
});

// Message handler
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'SET_STATUS': {
      chrome.storage.local.get(['mode', 'blacklist'], (data) => {
        const active = shouldActivate({ enabled: msg.enabled, ...data });
        if (active)  interceptor.enable();
        else         interceptor.disable();
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'SET_STRENGTH': {
      interceptor.setStrength(msg.strength);
      sendResponse({ ok: true });
      break;
    }

    // Background tells us to re-evaluate (mode or blacklist changed)
    case 'RECHECK': {
      chrome.storage.local.get(['enabled', 'mode', 'blacklist'], (data) => {
        const active = shouldActivate(data);
        if (active && !interceptor.enabled)  interceptor.enable();
        if (!active && interceptor.enabled)  interceptor.disable();
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'GET_STATUS': {
      sendResponse({ enabled: interceptor.enabled, count: interceptor.handles.size });
      break;
    }

    default:
      break;
  }
  return true;
});
