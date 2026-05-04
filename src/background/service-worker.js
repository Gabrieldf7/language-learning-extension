/**
 * LangLearn — Background Service Worker
 *
 * Message router that sits between the popup / content scripts and:
 *   1. The AnkiConnect HTTP client (Phase 1)
 *   2. The offscreen document running kuromoji (Phase 2)
 *
 * Every response follows a uniform envelope:
 *   Success → { success: true,  data: <result> }
 *   Failure → { success: false, error: { code: string, message: string } }
 */

import { ping, getDeckNames, addNote, findNotes, notesInfo, AnkiConnectError } from '../lib/anki-connect.js';
import { db } from '../lib/db.js';
import { log } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Service Worker Keepalive (prevents MV3 dormancy during recording)
// ---------------------------------------------------------------------------

let keepaliveInterval = null;

/** Start pinging the offscreen document every 20s to keep both contexts alive. */
function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(async () => {
    try {
      const res = await sendToOffscreen('audio:ping');
      log.debug(`[Keepalive] Offscreen ping response:`, res);
    } catch (e) {
      log.warn(`[Keepalive] Ping failed:`, e.message);
    }
  }, 20_000); // every 20 seconds
  log.info('[Keepalive] Started.');
}

/** Stop the keepalive interval. */
function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
    log.info('[Keepalive] Stopped.');
  }
}

// ---------------------------------------------------------------------------
// chrome.alarms — Failsafe keepalive that survives service worker dormancy
// ---------------------------------------------------------------------------

const ALARM_NAME = 'langlearn-audio-keepalive';

/**
 * Start a chrome.alarms-based keepalive. Unlike setInterval, alarms fire
 * even after the service worker goes dormant — they WAKE IT UP.
 * This is the last line of defense for the audio pipeline.
 */
function startAlarmKeepalive() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~24 seconds
  log.info('[Alarm Keepalive] Created.');
}

/** Stop the alarm-based keepalive. */
function stopAlarmKeepalive() {
  chrome.alarms.clear(ALARM_NAME);
  log.info('[Alarm Keepalive] Cleared.');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // Only act if we believe a recording is active
  const stored = await chrome.storage.session.get('activeRecordingTabId');
  if (!stored.activeRecordingTabId) {
    // No active recording — clean up the alarm
    stopAlarmKeepalive();
    return;
  }

  // Ping the offscreen document to keep it alive
  try {
    await ensureOffscreen();
    const res = await sendToOffscreen('audio:ping');
    log.debug('[Alarm Keepalive] Ping result:', res?.data);

    // Recover in-memory state if service worker restarted
    if (activeRecordingTabId === null) {
      activeRecordingTabId = stored.activeRecordingTabId;
      startKeepalive();
      log.info(`[Alarm Keepalive] Recovered activeRecordingTabId=${activeRecordingTabId}`);
    }
  } catch (e) {
    log.warn('[Alarm Keepalive] Ping failed:', e.message);
  }
});

// ---------------------------------------------------------------------------
// Error → envelope helper
// ---------------------------------------------------------------------------

/**
 * Convert any thrown error into the uniform failure envelope.
 * @param {Error} err
 * @returns {{ success: false, error: { code: string, message: string } }}
 */
function errorEnvelope(err) {
  if (err instanceof AnkiConnectError) {
    return {
      success: false,
      error: { code: err.code, message: err.message },
    };
  }

  return {
    success: false,
    error: { code: 'UNKNOWN', message: err.message || 'An unexpected error occurred.' },
  };
}

// ---------------------------------------------------------------------------
// Offscreen Document lifecycle
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

/**
 * Ensure the offscreen document exists. Creates it if not.
 * Guards against concurrent creation with a module-level promise.
 */
async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');

  // Check if it already exists
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (contexts.length > 0) {
    return; // Already running
  }

  // Create it (guarded against concurrent calls)
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  log.info('Creating offscreen document…');
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['WORKERS', 'AUDIO_PLAYBACK'],
    justification: 'Kuromoji tokenizer and tab audio capture with loopback playback',
  });

  await creatingOffscreen;
  creatingOffscreen = null;
  log.info('Offscreen document created.');
}

/**
 * Send a message to the offscreen document and return the response.
 *
 * @param {string} action
 * @param {object} [payload]
 * @returns {Promise<{ success: boolean, data?: any, error?: object }>}
 */
function sendToOffscreen(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { target: 'offscreen', action, payload },
      (response) => {
        if (chrome.runtime.lastError) {
          log.error('sendToOffscreen failed:', chrome.runtime.lastError.message);
          resolve({
            success: false,
            error: { code: 'OFFSCREEN_ERROR', message: chrome.runtime.lastError.message },
          });
          return;
        }
        resolve(response);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Jisho Dictionary Integration
// ---------------------------------------------------------------------------

/**
 * Scrape data from JPDB.io.
 * @param {string} keyword The Japanese word to look up.
 * @returns {Promise<Object>} Object containing frequency rank and pitch accent array.
 */
async function fetchJPDBData(keyword) {
  try {
    const url = `https://jpdb.io/search?q=${encodeURIComponent(keyword)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { frequency: null, pitch: null };
    const text = await response.text();
    
    // Frequency
    const freqMatch = text.match(/>Top (\d+)</i);
    const frequency = freqMatch && freqMatch[1] ? freqMatch[1] : null;

    // Pitch accent
    let pitch = null;
    const pitchSectionMatch = text.match(/<h6 class="subsection-label">Pitch accent<\/h6>[\s\S]*?(<div style="word-break: keep-all; display: flex;">[\s\S]*?<\/div><\/div><\/div>)/);
    if (pitchSectionMatch) {
      pitch = [];
      const pitchHtml = pitchSectionMatch[1];
      const nodeRegex = /background-image: linear-gradient\([^,]+,var\(--pitch-(high|low)-s\)[^>]*><div[^>]*>([^<]+)<\/div>/g;
      let nodeMatch;
      while ((nodeMatch = nodeRegex.exec(pitchHtml)) !== null) {
        pitch.push({
          pitch: nodeMatch[1], // "high" or "low"
          char: nodeMatch[2].trim()
        });
      }
      
      // Heuristic: JPDB uses padding/margins or specific gradients for Odaka drops.
      // If the last character is high and has a 'to bottom' gradient but no following character, it's an Odaka drop.
      const lastDivRegex = /<div style="display: flex; background-image: linear-gradient\(to bottom,var\(--pitch-high-s\)[^>]*><div[^>]*>[^<]+<\/div><\/div>$/;
      if (pitch.length > 0 && pitch[pitch.length - 1].pitch === 'high') {
         // Check if the html ends with a drop gradient
         if (lastDivRegex.test(pitchHtml.trim())) {
            pitch.push({ pitch: 'low', char: '' });
         }
      }
    }

    return { frequency, pitch };
  } catch (error) {
    log.error('fetchJPDBData error:', error.message);
    return { frequency: null, pitch: null };
  }
}

/**
 * Fetch English definitions from Jisho.org API.
 * Extracts up to the top 3 senses and maps them into a clean HTML ordered list.
 *
 * @param {string} keyword The Japanese word to look up.
 * @returns {Promise<string>} The formatted HTML string of definitions or a fallback message.
 */
async function fetchJishoDefinition(keyword) {
  try {
    const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(keyword)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Jisho API HTTP error: ${response.status}`);
    }
    const json = await response.json();
    
    if (!json.data || json.data.length === 0 || !json.data[0].senses) {
      return "Definition not found.";
    }

    const senses = json.data[0].senses.slice(0, 3);
    if (senses.length === 0) {
      return "Definition not found.";
    }

    let html = "<ol>";
    for (const sense of senses) {
      if (sense.english_definitions && sense.english_definitions.length > 0) {
        html += `<li>${sense.english_definitions.join(', ')}</li>`;
      }
    }
    html += "</ol>";

    if (html === "<ol></ol>") {
      return "Definition not found.";
    }
    
    return html;
  } catch (error) {
    log.error('fetchJishoDefinition error:', error.message);
    return "Error fetching definition.";
  }
}

/**
 * Scrape hidden WaniKani audio URLs from Jisho.org's HTML.
 * @param {string} keyword The Japanese word to look up.
 * @returns {Promise<string|null>}
 */
async function fetchJishoAudio(keyword) {
  try {
    const url = `https://jisho.org/word/${encodeURIComponent(keyword)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const text = await response.text();
    
    const match = text.match(/<source src="([^"]+\.mp3)"/);
    if (match && match[1]) {
      return `https:${match[1]}`;
    }
    return null;
  } catch (err) {
    log.error('fetchJishoAudio error:', err.message);
    return null;
  }
}


// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

const handlers = {
  // ── Phase 6: Dictionary ──
  'dictionary:fetch': async (payload) => {
    const { keyword } = payload;
    if (!keyword) {
      return { success: false, error: { code: 'MISSING_KEYWORD', message: 'No keyword provided.' } };
    }
    const definitionHtml = await fetchJishoDefinition(keyword);
    return { success: true, data: definitionHtml };
  },

  'dictionary:jpdb': async (payload) => {
    const { keyword } = payload;
    if (!keyword) {
      return { success: false, error: { code: 'MISSING_KEYWORD', message: 'No keyword provided.' } };
    }
    const data = await fetchJPDBData(keyword);
    return { success: true, data };
  },

  // ── Phase 1: AnkiConnect ──

  'anki:ping': async () => {
    const isAlive = await ping();
    return { success: true, data: isAlive };
  },

  'anki:getDeckNames': async () => {
    const decks = await getDeckNames();
    return { success: true, data: decks };
  },

  'anki:addNote': async (payload) => {
    const { deck, fields, audio, picture } = payload;

    if (!deck) {
      return {
        success: false,
        error: { code: 'ANKI_API_ERROR', message: 'No deck name provided.' },
      };
    }

    const noteId = await addNote(deck, fields, audio, picture);
    return { success: true, data: noteId };
  },

  'anki:sync': async (payload) => {
    const { deck } = payload;
    if (!deck) {
      return { success: false, error: { code: 'SYNC_ERROR', message: 'No deck provided to sync.' } };
    }

    // Step 1: Query IDs
    const query = `deck:"${deck}" -is:new -is:suspended`;
    const noteIds = await findNotes(query);
    if (!noteIds || noteIds.length === 0) {
      log.info(`Sync complete, 0 notes found in deck ${deck}.`);
      await db.putAll([]);
      return { success: true, data: 0 };
    }

    // Step 2: Fetch Card Data
    const notesData = await notesInfo(noteIds);
    
    // Step 3: Extract the word from known fields
    const words = notesData.map(note => {
      const targetFields = ['Word', 'Vocab', 'Vocabulary', 'Expression', 'Target', 'kanjis', 'japanese_kana', 'Kanji', 'Japanese'];
      for (const fieldName of targetFields) {
        if (note.fields[fieldName] && note.fields[fieldName].value) {
          // Strip HTML tags just in case the field was formatted
          const rawValue = note.fields[fieldName].value.replace(/<[^>]*>?/gm, '').trim();
          if (rawValue) return rawValue;
        }
      }
      return null;
    }).filter(word => word !== null && word !== '');

    // Step 4: Save to Database
    await db.putAll(words);

    return { success: true, data: words.length };
  },

  'db:getKnownWords': async () => {
    const words = await db.getAll();
    return { success: true, data: Array.from(words) };
  },

  // ── Phase 2: Japanese Parsing ──

  'parse:tokenize': async (payload) => {
    await ensureOffscreen();
    return sendToOffscreen('parse:tokenize', payload);
  },

  // ── Smart Audio Fallback ──
  
  'dictionary:audio': async (payload) => {
    const { keyword } = payload;
    if (!keyword) {
      return { success: false, error: { code: 'MISSING_KEYWORD', message: 'No keyword provided.' } };
    }
    
    const url = await fetchJishoAudio(keyword);
    return { success: true, data: url };
  },

  'audio:getValidAudios': async (payload) => {
    const { word, reading, fastestOnly } = payload;
    if (!word) return { success: false, error: { code: 'MISSING_WORD', message: 'No word provided.' } };
    
    const kanji = encodeURIComponent(word);
    const kana = encodeURIComponent(reading || '');
    const jpodUrl = `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=${kanji}&kana=${kana}`;
    
    const settings = await chrome.storage.local.get(['localAudioEnabled', 'localAudioUrl']);
    
    const checkLocalAudio = async () => {
      if (!settings.localAudioEnabled) throw new Error('Local audio disabled');
      let localUrlTemplate = settings.localAudioUrl || 'http://127.0.0.1:5050/?term={term}&reading={reading}';
      
      // If the word is pure kana (kanji === kana), the local audio server expects reading to be empty
      const queryReading = (kanji === kana) ? '' : kana;
      const localUrl = localUrlTemplate
        .replace('{term}', kanji)
        .replace('{reading}', queryReading);
        
      const response = await fetch(localUrl, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error('Local audio not found or server offline');
      
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        // Yomichan's Local Audio Server returns JSON: { type: "audioSourceList", audioSources: [ { url: "..." } ] }
        if (data && data.audioSources && data.audioSources.length > 0) {
          return data.audioSources[0].url;
        }
        throw new Error('Local JSON returned no audio sources');
      }
      
      // If the server was configured to return the MP3 directly
      return localUrl;
    };
    
    const checkJpod = async () => {
      const response = await fetch(jpodUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      // Valid if redirected (valid JPod audio on CDN) or size is not exactly 52288 (the silence mp3 size)
      if (response.ok && (response.redirected || (contentLength > 0 && contentLength !== 52288))) {
        return response.url;
      }
      throw new Error('JPod101 invalid or empty');
    };
    
    const checkJisho = async () => {
      const url = await fetchJishoAudio(word);
      if (url) return url;
      throw new Error('Jisho audio not found');
    };

    const checkGoogleTts = async () => {
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=${kanji}`;
      // Google TTS does not support CORS for fetch requests in the service worker.
      // However, the browser's <audio> element can play it just fine.
      // So we skip the HEAD request check and just return the URL directly.
      return ttsUrl;
    };

    if (fastestOnly) {
      try {
        const fastestUrl = await Promise.any([checkLocalAudio(), checkJpod(), checkJisho()]);
        return { success: true, data: [fastestUrl] };
      } catch (e) {
        // Both human audios failed, try TTS as absolute fallback
        try {
          const ttsUrl = await checkGoogleTts();
          return { success: true, data: [ttsUrl] };
        } catch (ttsErr) {
          return { success: true, data: [] };
        }
      }
    } else {
      const results = await Promise.allSettled([checkLocalAudio(), checkJpod(), checkJisho()]);
      const urls = [];
      if (results[0].status === 'fulfilled' && results[0].value) urls.push(results[0].value);
      if (results[1].status === 'fulfilled' && results[1].value) urls.push(results[1].value);
      if (results[2].status === 'fulfilled' && results[2].value) urls.push(results[2].value);
      
      // Fallback to TTS for Anki export if no human audio is found
      if (urls.length === 0) {
        try {
          const ttsUrl = await checkGoogleTts();
          urls.push(ttsUrl);
        } catch (e) {}
      }
      
      return { success: true, data: urls };
    }
  },

  // ── Phase 5: Audio Routing ──
  // audio:init MUST be triggered from the extension's own UI (popup/action click)
  // to satisfy MV3 tabCapture permission requirements. The popup sends the
  // active tab's ID via the payload.

  'audio:init': async (payload, sender) => {
    // Accept tabId from popup payload, or fall back to sender.tab (for edge cases)
    const tabId = payload.tabId || sender?.tab?.id;

    if (!tabId) {
      log.error('audio:init called without a tabId. This must be triggered from the popup.');
      return { success: false, error: { code: 'NO_TAB', message: 'No tab ID provided. Open the popup and click "Start Recording".' } };
    }

    log.info(`audio:init starting for tab ${tabId}…`);

    // ── CRITICAL: Always teardown any existing stream first ──
    // Chrome will reject getMediaStreamId if there's already an active
    // capture on any tab. Force-clean before requesting a new one.
    await ensureOffscreen();
    log.info('audio:init tearing down previous session (if any)…');
    await sendToOffscreen('audio:teardown');

    // Small delay to let Chrome fully release the stream handle
    await new Promise(r => setTimeout(r, 200));

    return new Promise((resolve) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          const errMsg = chrome.runtime.lastError?.message || 'Failed to capture stream ID';
          log.error(`audio:init tabCapture failed: ${errMsg}`);
          resolve({ success: false, error: { code: 'TAB_CAPTURE_ERROR', message: errMsg } });
          return;
        }

        log.info(`audio:init got streamId: ${streamId.substring(0, 30)}…`);

        const startRes = await sendToOffscreen('audio:start', { streamId });
        log.info('audio:init offscreen response:', startRes);

        // ── Start ALL keepalive mechanisms ──
        if (startRes.success) {
          startKeepalive();
          startAlarmKeepalive();

          // Persist to session storage so state survives service worker restart
          activeRecordingTabId = tabId;
          chrome.storage.session.set({ activeRecordingTabId: tabId });
        }

        resolve(startRes);
      });
    });
  },

  'audio:flush': async () => {
    await ensureOffscreen();
    return sendToOffscreen('audio:flush');
  },

  'audio:stop': async () => {
    await ensureOffscreen();
    stopKeepalive();
    stopAlarmKeepalive();

    // Clear persisted recording state
    activeRecordingTabId = null;
    chrome.storage.session.remove('activeRecordingTabId');

    // Teardown fully releases the stream so a new capture can start later
    return sendToOffscreen('audio:stop');
  },

  'audio:status': async () => {
    await ensureOffscreen();
    return sendToOffscreen('audio:status');
  },

  // Heartbeat from offscreen self-keepalive — just acknowledge to keep SW alive
  'audio:heartbeat': async () => {
    return { success: true, data: 'ack' };
  },
};

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Skip messages targeted at the offscreen document (they pass through here)
  if (message.target === 'offscreen') return;

  const { action, payload } = message;

  log.info(`Message received: ${action}`);

  const handler = handlers[action];

  if (!handler) {
    log.warn(`Unknown action: ${action}`);
    sendResponse({
      success: false,
      error: { code: 'UNKNOWN', message: `Unknown action: ${action}` },
    });
    return false;
  }

  // Run the async handler and send the response when done.
  handler(payload || {}, _sender)
    .then((result) => {
      log.info(`Action ${action} succeeded`);
      sendResponse(result);
    })
    .catch((err) => {
      log.error(`Action ${action} failed:`, err);
      sendResponse(errorEnvelope(err));
    });

  // Return true to indicate we will call sendResponse asynchronously.
  return true;
});

// ---------------------------------------------------------------------------
// Recording state tracking
// ---------------------------------------------------------------------------

/** Tab ID currently being recorded, or null. */
let activeRecordingTabId = null;

/**
 * Toggle recording for the given tab.
 * If already recording that tab, stop. Otherwise, start.
 *
 * @param {number} tabId
 * @returns {Promise<{ success: boolean, recording: boolean, error?: object }>}
 */
async function toggleRecording(tabId) {
  if (activeRecordingTabId === tabId) {
    // ── STOP ──
    log.info(`Stopping recording for tab ${tabId}…`);
    const result = await handlers['audio:stop']();
    activeRecordingTabId = null;
    return { success: result.success, recording: false };
  }

  // If recording a different tab, stop it first
  if (activeRecordingTabId !== null) {
    log.info(`Switching recording from tab ${activeRecordingTabId} to ${tabId}…`);
    await handlers['audio:stop']();
    activeRecordingTabId = null;
  }

  // ── START ──
  const result = await handlers['audio:init']({ tabId });
  if (result.success) {
    activeRecordingTabId = tabId;
  }
  return { success: result.success, recording: result.success, error: result.error };
}

// ---------------------------------------------------------------------------
// Global Hotkey: Alt+R → toggle recording on active tab
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;

  log.info('Hotkey toggle-recording triggered.');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.id) {
    log.warn('toggle-recording: No active tab found.');
    return;
  }

  const result = await toggleRecording(activeTab.id);
  log.info(`toggle-recording result: recording=${result.recording}, success=${result.success}`);
});

// ---------------------------------------------------------------------------
// Tab removal cleanup: prevent ghost streams
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeRecordingTabId) {
    log.info(`Recorded tab ${tabId} was closed. Stopping audio capture.`);
    handlers['audio:stop']().then(() => {
      activeRecordingTabId = null;
    });
  }
});

// ---------------------------------------------------------------------------
// Startup recovery: restore recording state after service worker restart
// ---------------------------------------------------------------------------

(async function recoverState() {
  try {
    const stored = await chrome.storage.session.get('activeRecordingTabId');
    if (stored.activeRecordingTabId) {
      activeRecordingTabId = stored.activeRecordingTabId;
      startKeepalive();
      // Alarm keepalive should still be running (persisted by chrome.alarms)
      log.info(`[Startup] Recovered active recording state for tab ${activeRecordingTabId}.`);
    }
  } catch (e) {
    log.warn('[Startup] State recovery failed:', e.message);
  }
})();

log.info('Service worker started.');
