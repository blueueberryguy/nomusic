const modeRadios   = document.querySelectorAll('input[name="mode"]');
const listSection  = document.getElementById('list-section');
const newUrlInput  = document.getElementById('new-url');
const addBtn       = document.getElementById('add-btn');
const urlList      = document.getElementById('url-list');
const emptyMsg     = document.getElementById('empty-msg');
const saveBtn      = document.getElementById('save-btn');
const statusMsg    = document.getElementById('status-msg');

let blacklist = [];  // working copy; only committed on Save

// ─── Load ─────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['mode', 'blacklist'], ({ mode, blacklist: saved }) => {
  setMode(mode ?? 'all');
  blacklist = saved ? [...saved] : [];
  renderList();
});

// ─── Mode selection ───────────────────────────────────────────────────────────

modeRadios.forEach(radio => {
  radio.addEventListener('change', () => setMode(radio.value));
});

function setMode(mode) {
  modeRadios.forEach(r => { r.checked = r.value === mode; });
  listSection.classList.toggle('disabled', mode !== 'blacklist');
}

function getMode() {
  return [...modeRadios].find(r => r.checked)?.value ?? 'all';
}

// ─── Blacklist CRUD ───────────────────────────────────────────────────────────

addBtn.addEventListener('click', addEntry);
newUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addEntry();
});

function addEntry() {
  const raw = newUrlInput.value.trim();
  if (!raw) return;

  // Basic validation: must look like a URL (start with protocol or *)
  if (!/^(\*|https?:\/\/).+/.test(raw)) {
    newUrlInput.setCustomValidity('Must start with https://, http://, or *');
    newUrlInput.reportValidity();
    return;
  }
  newUrlInput.setCustomValidity('');

  if (blacklist.includes(raw)) {
    flash(newUrlInput);
    return;
  }

  blacklist.push(raw);
  newUrlInput.value = '';
  renderList();
}

function removeEntry(pattern) {
  blacklist = blacklist.filter(p => p !== pattern);
  renderList();
}

function renderList() {
  urlList.innerHTML = '';
  emptyMsg.classList.toggle('hidden', blacklist.length > 0);

  blacklist.forEach(pattern => {
    const li = document.createElement('li');
    li.className = 'url-item';

    const span = document.createElement('span');
    span.className   = 'url-text';
    span.textContent = pattern;
    span.title       = pattern;

    const btn = document.createElement('button');
    btn.className   = 'remove-btn';
    btn.textContent = '×';
    btn.title       = 'Remove';
    btn.setAttribute('aria-label', 'Remove ' + pattern);
    btn.addEventListener('click', () => removeEntry(pattern));

    li.append(span, btn);
    urlList.appendChild(li);
  });
}

// ─── Save ─────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const mode = getMode();
  chrome.storage.local.set({ mode, blacklist: [...blacklist] }, () => {
    // Notify active tabs to recheck
    chrome.runtime.sendMessage({ type: 'SET_MODE', mode });
    showStatus('Saved!');
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showStatus(text) {
  statusMsg.textContent = text;
  statusMsg.classList.add('visible');
  setTimeout(() => statusMsg.classList.remove('visible'), 2200);
}

function flash(el) {
  el.style.borderColor = '#ef4444';
  setTimeout(() => { el.style.borderColor = ''; }, 600);
}
