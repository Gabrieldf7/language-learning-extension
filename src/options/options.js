// LangLearn — Options Page Logic
// Saves/loads AI provider + API key from chrome.storage.local.

const providerSelect = document.getElementById('ai-provider');
const providerInfo   = document.getElementById('provider-info');
const keyInput       = document.getElementById('ai-key');
const btnSave        = document.getElementById('btn-save');
const btnClear       = document.getElementById('btn-clear');
const keyStatus      = document.getElementById('key-status');
const toastEl        = document.getElementById('toast');

// ── Provider metadata ────────────────────────────────────────────────────────

const PROVIDERS = {
  groq: {
    name: 'Groq',
    placeholder: 'gsk_...',
    prefix: 'gsk_',
    info: '30 req/min free tier. Get a key at <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>',
    storageKey: 'groqApiKey',
  },
  gemini: {
    name: 'Gemini',
    placeholder: 'AIzaSy...',
    prefix: 'AIza',
    info: '15 req/min free tier. Get a key at <a href="https://aistudio.google.com/app/apikey" target="_blank">AI Studio</a>',
    storageKey: 'geminiApiKey',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toastEl.className = 'toast'; }, 2200);
}

function updateStatus(hasKey) {
  if (hasKey) {
    keyStatus.textContent = '✓ Key saved and active';
    keyStatus.className = 'key-status active';
  } else {
    keyStatus.textContent = 'No key configured';
    keyStatus.className = 'key-status';
  }
}

function currentProvider() {
  return PROVIDERS[providerSelect.value];
}

function refreshProviderUI() {
  const p = currentProvider();
  providerInfo.innerHTML = p.info;
  keyInput.placeholder = p.placeholder;

  // Load existing key for this provider
  chrome.storage.local.get([p.storageKey], (result) => {
    if (result[p.storageKey]) {
      keyInput.value = '•'.repeat(Math.min(result[p.storageKey].length, 32));
      keyInput.dataset.saved = 'true';
      updateStatus(true);
    } else {
      keyInput.value = '';
      keyInput.dataset.saved = 'false';
      updateStatus(false);
    }
  });
}

// ── Load saved state on page open ────────────────────────────────────────────

chrome.storage.local.get('aiProvider', (result) => {
  if (result.aiProvider && PROVIDERS[result.aiProvider]) {
    providerSelect.value = result.aiProvider;
  }
  refreshProviderUI();
});

// ── Provider change ──────────────────────────────────────────────────────────

providerSelect.addEventListener('change', () => {
  chrome.storage.local.set({ aiProvider: providerSelect.value });
  refreshProviderUI();
});

// When user focuses on a masked field, clear it for fresh input
keyInput.addEventListener('focus', () => {
  if (keyInput.dataset.saved === 'true') {
    keyInput.value = '';
    keyInput.dataset.saved = 'false';
  }
});

// ── Save ─────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', () => {
  const key = keyInput.value.trim();
  const p = currentProvider();

  if (!key || key.includes('•')) {
    showToast('Please enter a valid API key.', true);
    return;
  }

  if (!key.startsWith(p.prefix)) {
    showToast(`Key should start with "${p.prefix}…"`, true);
    return;
  }

  const data = { aiProvider: providerSelect.value };
  data[p.storageKey] = key;

  chrome.storage.local.set(data, () => {
    keyInput.value = '•'.repeat(Math.min(key.length, 32));
    keyInput.dataset.saved = 'true';
    updateStatus(true);
    showToast(`✓ ${p.name} API key saved!`);
  });
});

// ── Clear ────────────────────────────────────────────────────────────────────

btnClear.addEventListener('click', () => {
  const p = currentProvider();
  chrome.storage.local.remove(p.storageKey, () => {
    keyInput.value = '';
    keyInput.dataset.saved = 'false';
    updateStatus(false);
    showToast('Key removed.');
  });
});
