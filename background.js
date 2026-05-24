// Service worker — state management and message relay.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.storage.local.set({
      enabled:   false,
      strength:  0.7,
      mode:      'all',      // 'all' | 'blacklist'
      blacklist: [],         // array of URL glob patterns
    });
  }
});

// ─── Message hub ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'GET_STATUS': {
      chrome.storage.local.get(['enabled', 'strength', 'mode', 'blacklist'], (data) => {
        sendResponse({
          enabled:   !!data.enabled,
          strength:  data.strength  ?? 0.7,
          mode:      data.mode      ?? 'all',
          blacklist: data.blacklist ?? [],
        });
      });
      return true;
    }

    case 'SET_STATUS': {
      chrome.storage.local.set({ enabled: message.enabled }, async () => {
        await relayToActiveTab({ type: 'SET_STATUS', enabled: message.enabled });
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'SET_STRENGTH': {
      chrome.storage.local.set({ strength: message.strength }, async () => {
        await relayToActiveTab({ type: 'SET_STRENGTH', strength: message.strength });
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'SET_MODE': {
      chrome.storage.local.set({ mode: message.mode }, async () => {
        await relayToActiveTab({ type: 'RECHECK' });
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'ADD_TO_BLACKLIST': {
      chrome.storage.local.get('blacklist', ({ blacklist = [] }) => {
        if (blacklist.includes(message.pattern)) {
          sendResponse({ ok: true, added: false });
          return;
        }
        const next = [...blacklist, message.pattern];
        chrome.storage.local.set({ blacklist: next }, async () => {
          await relayToActiveTab({ type: 'RECHECK' });
          sendResponse({ ok: true, added: true, blacklist: next });
        });
      });
      return true;
    }

    case 'REMOVE_FROM_BLACKLIST': {
      chrome.storage.local.get('blacklist', ({ blacklist = [] }) => {
        const next = blacklist.filter(p => p !== message.pattern);
        chrome.storage.local.set({ blacklist: next }, async () => {
          await relayToActiveTab({ type: 'RECHECK' });
          sendResponse({ ok: true, blacklist: next });
        });
      });
      return true;
    }

    case 'CONTENT_STATUS': {
      chrome.runtime.sendMessage({
        type:    'CONTENT_STATUS',
        enabled: message.enabled,
        count:   message.count,
      }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    default:
      break;
  }
});

// Re-check blacklist when SPAs navigate via pushState/replaceState
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return; // main frame only
  chrome.tabs.sendMessage(tabId, { type: 'RECHECK' }).catch(() => {});
});

async function relayToActiveTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}
