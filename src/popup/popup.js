/**
 * LangLearn — Popup Logic
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage.
 * Never calls AnkiConnect directly (all requests routed through the service worker).
 *
 * Persists the selected deck to chrome.storage.local.
 */

import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const statusBadge    = document.getElementById('status-badge');
const statusText     = document.getElementById('status-text');
const offlineBanner  = document.getElementById('offline-banner');
const btnRetry       = document.getElementById('btn-retry');
const mainContent    = document.getElementById('main-content');

const deckSelect     = document.getElementById('deck-select');
const btnSync        = document.getElementById('btn-sync');
const syncStatus     = document.getElementById('sync-status');
const btnRecord      = document.getElementById('btn-record');
const recordStatus   = document.getElementById('record-status');
const cbLocalAudio   = document.getElementById('cb-local-audio');
const fieldLocalAudioUrl = document.getElementById('field-local-audio-url');
const fieldWord      = document.getElementById('field-word');
const fieldReading   = document.getElementById('field-reading');
const fieldSentence  = document.getElementById('field-sentence');
const btnAdd         = document.getElementById('btn-add');
const feedback       = document.getElementById('feedback');

/** Whether the rolling audio buffer is currently active. */
let isRecording = false;

/**
 * Check if recording is already active (e.g. from a previous popup session).
 * Uses chrome.storage.session which persists across popup open/close.
 */
async function restoreRecordingState() {
  try {
    const stored = await chrome.storage.session.get('activeRecordingTabId');
    if (stored.activeRecordingTabId) {
      // Verify recording is actually alive via audio:status
      const status = await sendMessage('audio:status');
      if (status.success && status.data?.hasRecorder) {
        isRecording = true;
        btnRecord.textContent = '⏹ Stop Recording';
        recordStatus.textContent = '🔴 Recording…';
        recordStatus.style.color = '#d13438';
        log.info(`Recording already active for tab ${stored.activeRecordingTabId}.`);
      } else {
        // Stale state — clean up
        log.warn('Stale recording state found. Cleaning up.');
        chrome.storage.session.remove('activeRecordingTabId');
      }
    }
  } catch (e) {
    log.warn('restoreRecordingState failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to the background service worker and return the response.
 * @param {string} action
 * @param {object} [payload]
 * @returns {Promise<{ success: boolean, data?: any, error?: { code: string, message: string } }>}
 */
function sendMessage(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      // If the service worker is unreachable (e.g. not started yet)
      if (chrome.runtime.lastError) {
        log.error('sendMessage failed:', chrome.runtime.lastError.message);
        resolve({
          success: false,
          error: { code: 'UNKNOWN', message: chrome.runtime.lastError.message },
        });
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Update the visual status indicator.
 * @param {'online'|'offline'|'warning'|'connecting'} state
 * @param {string} label
 */
function setStatus(state, label) {
  // Remove all state classes
  statusBadge.className = `status-badge status-${state}`;
  statusText.textContent = label;
}

/**
 * Show a feedback message below the Add button.
 * @param {'success'|'error'} type
 * @param {string} message
 */
function showFeedback(type, message) {
  feedback.textContent = message;
  feedback.className = `feedback feedback-${type}`;
  feedback.hidden = false;

  // Auto-hide success messages after 4s
  if (type === 'success') {
    setTimeout(() => { feedback.hidden = true; }, 4000);
  }
}

function hideFeedback() {
  feedback.hidden = true;
}

// ---------------------------------------------------------------------------
// Core flows
// ---------------------------------------------------------------------------

/**
 * Ping AnkiConnect via the service worker.
 * If online, fetch decks and enable the UI.
 * If offline, show the banner and disable controls.
 */
async function checkConnection() {
  setStatus('connecting', 'Connecting');
  hideFeedback();
  offlineBanner.hidden = true; // Clear any stale offline banner immediately

  const result = await sendMessage('anki:ping');

  if (result.success && result.data === true) {
    // ── ONLINE ── Clear ALL error UI explicitly
    setStatus('online', 'Online');
    offlineBanner.hidden = true;
    hideFeedback();
    mainContent.style.opacity = '1';
    mainContent.style.pointerEvents = 'auto';

    await loadDecks();
  } else {
    // ── OFFLINE ──
    setStatus('offline', 'Offline');
    offlineBanner.hidden = false;
    mainContent.style.opacity = '0.4';
    mainContent.style.pointerEvents = 'none';
    deckSelect.disabled = true;
    btnAdd.disabled = true;
  }
}

/**
 * Fetch deck names from Anki, populate the dropdown,
 * and restore the previously-selected deck from storage.
 */
async function loadDecks() {
  const result = await sendMessage('anki:getDeckNames');

  if (!result.success) {
    setStatus('warning', 'Error');
    showFeedback('error', result.error.message);
    return;
  }

  const decks = result.data;

  // Populate dropdown
  deckSelect.replaceChildren();
  decks.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    deckSelect.appendChild(opt);
  });
  deckSelect.disabled = false;

  // Restore saved selection
  const stored = await chrome.storage.local.get(['selectedDeck', 'localAudioEnabled', 'localAudioUrl']);
  const savedDeck = stored.selectedDeck;

  cbLocalAudio.checked = stored.localAudioEnabled || false;
  fieldLocalAudioUrl.value = stored.localAudioUrl || 'http://127.0.0.1:5050/?term={term}&reading={reading}';

  if (savedDeck && decks.includes(savedDeck)) {
    deckSelect.value = savedDeck;
  } else {
    // Stale or missing — fall back to first deck and clear storage
    deckSelect.selectedIndex = 0;
    if (savedDeck) {
      log.warn(`Saved deck "${savedDeck}" no longer exists. Falling back to "${decks[0]}".`);
      await chrome.storage.local.remove('selectedDeck');
    }
  }

  btnAdd.disabled = false;
  btnSync.disabled = false;
  btnRecord.disabled = false;
}

/**
 * Add a note using the current field values and selected deck.
 */
async function handleAddCard() {
  const deck = deckSelect.value;
  const fields = {
    Word:     fieldWord.value.trim(),
    Reading:  fieldReading.value.trim(),
    Sentence: fieldSentence.value.trim(),
  };

  if (!fields.Word) {
    showFeedback('error', 'The "Word" field is required.');
    return;
  }

  // UI loading state
  hideFeedback();
  btnAdd.classList.add('btn-loading');
  btnAdd.disabled = true;

  const result = await sendMessage('anki:addNote', { deck, fields });

  btnAdd.classList.remove('btn-loading');
  btnAdd.disabled = false;

  if (result.success) {
    showFeedback('success', `✓ Card added! (ID: ${result.data})`);
    log.info('Note added:', result.data);

    // Clear fields after successful add
    fieldWord.value = '';
    fieldReading.value = '';
    fieldSentence.value = '';
    fieldWord.focus();
  } else {
    showFeedback('error', result.error.message);
    log.error('addNote failed:', result.error);
  }
}

/**
 * Sync notes from the selected deck into the local IndexedDB.
 */
async function handleSync() {
  const deck = deckSelect.value;
  if (!deck) return;

  btnSync.disabled = true;
  btnAdd.disabled = true;
  syncStatus.textContent = 'Syncing... Please wait.';

  const result = await sendMessage('anki:sync', { deck });

  btnSync.disabled = false;
  btnAdd.disabled = false;

  if (result.success) {
    syncStatus.textContent = `✓ Synced ${result.data} words.`;
    syncStatus.style.color = '#107c10';
  } else {
    syncStatus.textContent = '✗ Sync failed.';
    syncStatus.style.color = '#d13438';
    log.error('Sync failed:', result.error);
    showFeedback('error', result.error.message);
  }

  // Clear success styling after a bit
  setTimeout(() => {
    if (syncStatus.textContent && syncStatus.textContent.startsWith('✓')) {
      syncStatus.textContent = '';
      syncStatus.style.color = '#888';
    }
  }, 4000);
}

/**
 * Start or stop the rolling audio buffer.
 * This MUST be triggered from the popup (user gesture) to satisfy MV3
 * tabCapture requirements. The active tab's ID is sent to the service worker.
 */
async function handleRecord() {
  if (isRecording) {
    // ── STOP ──
    btnRecord.disabled = true;
    recordStatus.textContent = 'Stopping…';

    const result = await sendMessage('audio:stop');

    isRecording = false;
    btnRecord.disabled = false;
    btnRecord.textContent = '🎙 Record Tab Audio';

    if (result.success) {
      recordStatus.textContent = '⏹ Stopped';
      recordStatus.style.color = '#888';
      log.info('Audio recording stopped.');
    } else {
      recordStatus.textContent = '✗ Stop failed';
      recordStatus.style.color = '#d13438';
      log.error('audio:stop failed:', result.error);
    }
    return;
  }

  // ── START ──
  btnRecord.disabled = true;
  recordStatus.textContent = 'Starting…';

  // Get the currently active tab to pass its ID to the service worker
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab || !activeTab.id) {
    recordStatus.textContent = '✗ No active tab';
    recordStatus.style.color = '#d13438';
    btnRecord.disabled = false;
    return;
  }

  log.info(`Starting audio capture for tab ${activeTab.id}: ${activeTab.url}`);

  const result = await sendMessage('audio:init', { tabId: activeTab.id });

  btnRecord.disabled = false;

  if (result.success) {
    isRecording = true;
    btnRecord.textContent = '⏹ Stop Recording';
    recordStatus.textContent = '🔴 Recording…';
    recordStatus.style.color = '#d13438';
    log.info('Audio recording started.');
  } else {
    recordStatus.textContent = `✗ ${result.error?.message || 'Failed'}`;
    recordStatus.style.color = '#d13438';
    log.error('audio:init failed:', result.error);
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Retry connection
btnRetry.addEventListener('click', () => {
  log.info('Retry clicked');
  checkConnection();
});

// Add card
btnAdd.addEventListener('click', () => {
  handleAddCard();
});

// Sync
btnSync.addEventListener('click', () => {
  handleSync();
});

// Record audio
btnRecord.addEventListener('click', () => {
  handleRecord();
});

// Persist deck selection on change
deckSelect.addEventListener('change', () => {
  const selected = deckSelect.value;
  chrome.storage.local.set({ selectedDeck: selected });
  log.info(`Deck selection saved: ${selected}`);
});

// Persist Local Audio settings on change
cbLocalAudio.addEventListener('change', () => {
  chrome.storage.local.set({ localAudioEnabled: cbLocalAudio.checked });
  log.info(`Local Audio Enabled: ${cbLocalAudio.checked}`);
});

fieldLocalAudioUrl.addEventListener('change', () => {
  chrome.storage.local.set({ localAudioUrl: fieldLocalAudioUrl.value });
  log.info(`Local Audio URL saved: ${fieldLocalAudioUrl.value}`);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

log.info('Popup opened');
checkConnection();
restoreRecordingState();
