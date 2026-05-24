const toggle      = document.getElementById('toggle');
const badge       = document.getElementById('status-badge');
const modeSeg     = document.getElementById('mode-seg');
const blacklistRow = document.getElementById('blacklist-row');
const pageStatus  = document.getElementById('page-status');
const addPageBtn  = document.getElementById('add-page-btn');
const strengthEl  = document.getElementById('strength');
const strengthVal = document.getElementById('strength-val');
const activeRow   = document.getElementById('active-row');
const activeLabel = document.getElementById('active-label');
const optionsLink = document.getElementById('options-link');

let currentMode      = 'all';
let currentBlacklist = [];
let currentTabUrl    = '';

// ─── Init ─────────────────────────────────────────────────────────────────────

// Load settings and current tab URL in parallel
Promise.all([
  new Promise(res =>
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res)
  ),
  new Promise(res =>
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => res(tab))
  ),
]).then(([status, tab]) => {
  currentTabUrl    = tab?.url ?? '';
  currentMode      = status.mode ?? 'all';
  currentBlacklist = status.blacklist ?? [];

  applyEnabled(status.enabled);
  applyMode(currentMode);
  applyStrength(Math.round((status.strength ?? 0.7) * 100));
  refreshBlacklistRow();
});

// Live element count from content script
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    updateActiveRow(res.enabled, res.count);
  });
});

// ─── Controls ────────────────────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_STATUS', enabled: toggle.checked });
  applyEnabled(toggle.checked);
});

modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode === currentMode) return;
  currentMode = mode;
  applyMode(mode);
  refreshBlacklistRow();
  chrome.runtime.sendMessage({ type: 'SET_MODE', mode });
});

addPageBtn.addEventListener('click', () => {
  if (!currentTabUrl) return;
  let pattern;
  try {
    const u = new URL(currentTabUrl);
    pattern = u.origin + '/*';
  } catch {
    pattern = currentTabUrl;
  }
  addPageBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'ADD_TO_BLACKLIST', pattern }, (res) => {
    if (res?.blacklist) currentBlacklist = res.blacklist;
    refreshBlacklistRow();
  });
});

let strengthDebounce = null;
strengthEl.addEventListener('input', () => {
  const pct = Number(strengthEl.value);
  strengthVal.textContent = pct + '%';
  clearTimeout(strengthDebounce);
  strengthDebounce = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'SET_STRENGTH', strength: pct / 100 });
  }, 80);
});

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Live status updates pushed from content script via background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CONTENT_STATUS') {
    updateActiveRow(msg.enabled, msg.count);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function applyEnabled(on) {
  toggle.checked      = on;
  badge.textContent   = on ? 'on' : 'off';
  badge.className     = 'badge ' + (on ? 'on' : 'off');
  strengthEl.disabled = !on;
  if (!on) activeRow.classList.add('hidden');
}

function applyMode(mode) {
  modeSeg.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  if (mode === 'blacklist') {
    blacklistRow.classList.remove('hidden');
    optionsLink.textContent = 'Manage page list';
  } else {
    blacklistRow.classList.add('hidden');
    optionsLink.textContent = 'Options';
  }
}

function applyStrength(pct) {
  strengthEl.value        = pct;
  strengthVal.textContent = pct + '%';
}

function refreshBlacklistRow() {
  if (currentMode !== 'blacklist') return;

  if (!currentTabUrl) {
    pageStatus.textContent = 'No page URL available';
    pageStatus.className   = 'page-status';
    addPageBtn.disabled    = true;
    return;
  }

  const alreadyAdded = currentBlacklist.some(p => {
    try {
      const u = new URL(currentTabUrl);
      return p === u.origin + '/*' || p === currentTabUrl;
    } catch { return false; }
  });

  if (alreadyAdded) {
    let host = currentTabUrl;
    try { host = new URL(currentTabUrl).hostname; } catch { /* */ }
    pageStatus.textContent = '✓ Active on ' + host;
    pageStatus.className   = 'page-status active-page';
    addPageBtn.textContent  = 'Added';
    addPageBtn.disabled     = true;
  } else {
    let host = currentTabUrl;
    try { host = new URL(currentTabUrl).hostname; } catch { /* */ }
    pageStatus.textContent = 'Inactive on ' + host;
    pageStatus.className   = 'page-status';
    addPageBtn.textContent  = '+ Add this site';
    addPageBtn.disabled     = false;
  }
}

function updateActiveRow(enabled, count) {
  if (enabled && count > 0) {
    activeRow.classList.remove('hidden');
    activeLabel.textContent = `Processing ${count} stream${count !== 1 ? 's' : ''}`;
  } else {
    activeRow.classList.add('hidden');
  }
}
