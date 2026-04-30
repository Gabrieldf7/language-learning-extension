/**
 * LangLearn — Offscreen Document Script
 *
 * Runs inside the offscreen document (extension origin, full browser APIs).
 * Loads kuromoji.js, initialises the tokenizer once, and handles parse
 * requests relayed from the service worker.
 *
 * Message protocol (via chrome.runtime.onMessage):
 *   Inbound:  { target: "offscreen", action: "parse:init" | "parse:tokenize", payload? }
 *   Outbound: { success: true, data } | { success: false, error: { code, message } }
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tokenizer = null;
let initPromise = null;

let mediaRecorder = null;
let recordingStream = null;
let audioContext = null;          // For loopback playback
let rollingChunks = [];           // Array of { data: Blob, timestamp: number }

/** Maximum age (ms) of audio chunks kept in the rolling buffer. */
const BUFFER_DURATION_MS = 10_000;  // 10 seconds

/** How often (ms) the MediaRecorder emits data chunks. */
const CHUNK_INTERVAL_MS = 1_000;    // 1 second

/** Self-keepalive interval ID (keeps offscreen doc + service worker alive). */
let selfKeepaliveId = null;

// ---------------------------------------------------------------------------
// Tokenizer initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the kuromoji tokenizer. Safe to call multiple times —
 * subsequent calls return the same promise.
 *
 * @returns {Promise<void>}
 */
function initTokenizer() {
  if (tokenizer) return Promise.resolve();
  if (initPromise) return initPromise;

  const startTime = performance.now();

  initPromise = new Promise((resolve, reject) => {
    // dicPath is relative to this HTML file's location
    // (src/offscreen/offscreen.html) → ../../dict/
    // eslint-disable-next-line no-undef
    kuromoji.builder({ dicPath: '../../dict/' }).build((err, built) => {
      if (err) {
        console.error('[LangLearn] [ERROR] Tokenizer init failed:', err);
        initPromise = null; // Allow retry on next call
        reject(err);
        return;
      }

      tokenizer = built;
      const elapsed = (performance.now() - startTime).toFixed(0);
      console.info(`[LangLearn] [INFO] Tokenizer initialised (took ${elapsed}ms)`);
      resolve();
    });
  });

  return initPromise;
}

// ---------------------------------------------------------------------------
// Token mapping
// ---------------------------------------------------------------------------

/**
 * Tokenize Japanese text and return a clean token array.
 *
 * @param {string} text
 * @returns {{ surface: string, dictForm: string, reading: string, pos: string, pos_detail: string }[]}
 */
function tokenize(text) {
  const raw = tokenizer.tokenize(text);

  return raw.map((t) => ({
    surface:    t.surface_form,
    dictForm:   (t.basic_form && t.basic_form !== '*') ? t.basic_form : t.surface_form,
    reading:    (t.reading    && t.reading    !== '*') ? t.reading    : t.surface_form,
    pos:        t.pos          || '*',
    pos_detail: t.pos_detail_1 || '*',
  }));
}

// ---------------------------------------------------------------------------
// Self-Keepalive (prevents offscreen doc GC + service worker dormancy)
// ---------------------------------------------------------------------------

/**
 * Start a self-sustaining keepalive that:
 *   1. Keeps this offscreen document alive (active JS timer = not idle)
 *   2. Resumes AudioContext if Chrome suspends it (autoplay policy)
 *   3. Pings the service worker to prevent MV3 dormancy
 *
 * This is the PRIMARY mechanism for keeping the audio pipeline alive.
 * The service worker's own keepalive and chrome.alarms are backups.
 */
function startSelfKeepalive() {
  stopSelfKeepalive();

  selfKeepaliveId = setInterval(() => {
    // ── 1. Resume AudioContext if suspended ──
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
      console.warn('[LangLearn] [AUDIO:KEEPALIVE] AudioContext was suspended — resumed.');
    }

    // ── 2. Verify stream health ──
    if (recordingStream) {
      const tracks = recordingStream.getAudioTracks();
      const deadTracks = tracks.filter(t => t.readyState === 'ended');
      if (deadTracks.length > 0 && deadTracks.length === tracks.length) {
        console.error('[LangLearn] [AUDIO:KEEPALIVE] ALL audio tracks are dead! Stream lost.');
      }
    }

    // ── 3. Log heartbeat ──
    console.debug('[LangLearn] [AUDIO:KEEPALIVE] ♥', {
      recorder: mediaRecorder?.state ?? 'null',
      chunks: rollingChunks.length,
      ctx: audioContext?.state ?? 'null',
    });

    // ── 4. Ping service worker to keep IT alive (fire-and-forget) ──
    try {
      chrome.runtime.sendMessage({ action: 'audio:heartbeat' });
    } catch { /* service worker may be restarting */ }
  }, 10_000); // every 10 seconds

  console.info('[LangLearn] [AUDIO:KEEPALIVE] Started (10s interval).');
}

/** Stop the self-keepalive interval. */
function stopSelfKeepalive() {
  if (selfKeepaliveId) {
    clearInterval(selfKeepaliveId);
    selfKeepaliveId = null;
    console.info('[LangLearn] [AUDIO:KEEPALIVE] Stopped.');
  }
}

// ---------------------------------------------------------------------------
// Rolling Audio Buffer (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Prune chunks older than BUFFER_DURATION_MS from the rolling buffer.
 */
function pruneBuffer() {
  const cutoff = Date.now() - BUFFER_DURATION_MS;
  rollingChunks = rollingChunks.filter(c => c.timestamp >= cutoff);
}

/**
 * Forcefully tear down all audio resources.
 * Safe to call multiple times and in any state.
 */
function teardownAudio() {
  console.info('[LangLearn] [AUDIO] Running full teardown…');

  // 0. Stop self-keepalive FIRST
  stopSelfKeepalive();

  // 1. Stop MediaRecorder
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    } catch { /* already stopped */ }
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onerror = null;
    mediaRecorder.onstop = null;
    mediaRecorder = null;
  }

  // 2. Stop all tracks on the stream (releases the tab capture)
  if (recordingStream) {
    recordingStream.getTracks().forEach(t => {
      t.stop();
      console.debug(`[LangLearn] [AUDIO] Track stopped: ${t.kind} (${t.label})`);
    });
    recordingStream = null;
  }

  // 3. Close AudioContext (stops loopback playback)
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  rollingChunks = [];
  console.info('[LangLearn] [AUDIO] Teardown complete.');
}

/**
 * Start continuous audio capture from the given tab stream.
 * Uses a rolling buffer: chunks older than 10 s are discarded.
 *
 * CRITICAL: Routes audio back to speakers via AudioContext loopback
 * so the user doesn't hear silence when tabCapture starts.
 *
 * @param {string} streamId  Chrome tabCapture media stream ID.
 * @returns {Promise<string>} Resolves with 'recording'.
 */
async function startAudio(streamId) {
  // Already recording — no-op
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    console.info('[LangLearn] [AUDIO] Already recording, skipping init.');
    return 'already_recording';
  }

  // Clean up any stale state from a previous session
  if (mediaRecorder || recordingStream || audioContext) {
    console.warn('[LangLearn] [AUDIO] Stale audio state detected, tearing down first.');
    teardownAudio();
  }

  console.info(`[LangLearn] [AUDIO] Calling getUserMedia with streamId: ${streamId.substring(0, 30)}…`);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
  } catch (err) {
    console.error(`[LangLearn] [AUDIO] getUserMedia FAILED:`, err.name, err.message);
    throw err;
  }

  recordingStream = stream;

  // ── Diagnostic: log track info to confirm audio is flowing ──
  const tracks = stream.getAudioTracks();
  console.info(`[LangLearn] [AUDIO] getUserMedia succeeded. Audio tracks: ${tracks.length}`);
  tracks.forEach((t, i) => {
    console.info(`[LangLearn] [AUDIO]   Track ${i}: label="${t.label}", enabled=${t.enabled}, readyState=${t.readyState}, muted=${t.muted}`);
  });

  // ── Monitor track health: detect stream death early ──
  tracks.forEach(t => {
    t.addEventListener('ended', () => {
      console.warn(`[LangLearn] [AUDIO] Track ended unexpectedly: "${t.label}". Stream may be lost.`);
    });
  });

  // ── LOOPBACK: Route captured audio back to the user's speakers ──
  // Without this, tabCapture diverts the audio away from the speakers,
  // causing the tab to go silent.
  audioContext = new AudioContext();

  // CRITICAL: Force resume — Chrome may suspend AudioContext without user
  // gesture in an offscreen document. Without this, the loopback is silent
  // AND Chrome considers the document "idle" → eligible for GC.
  if (audioContext.state !== 'running') {
    console.warn(`[LangLearn] [AUDIO] AudioContext state is "${audioContext.state}" — forcing resume.`);
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);
  console.info(`[LangLearn] [AUDIO] Loopback connected. AudioContext state: ${audioContext.state}`);

  // Negotiate MIME type: prefer audio/webm, fall back to browser default
  let mimeType = 'audio/webm';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = '';  // let browser choose
      console.warn('[LangLearn] [AUDIO] No preferred MIME supported, using browser default.');
    }
  }
  console.info(`[LangLearn] [AUDIO] Using MIME type: "${mimeType || '(browser default)'}"`);

  const recorderOptions = mimeType ? { mimeType } : undefined;
  mediaRecorder = new MediaRecorder(stream, recorderOptions);
  rollingChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      rollingChunks.push({ data: e.data, timestamp: Date.now() });
      pruneBuffer();
      console.debug(`[LangLearn] [AUDIO] Chunk received: ${e.data.size} bytes | Buffer: ${rollingChunks.length} chunks`);
    }
  };

  mediaRecorder.onerror = (e) => {
    console.error('[LangLearn] [AUDIO] MediaRecorder error:', e.error);
  };

  // timeslice → emit a chunk every CHUNK_INTERVAL_MS
  mediaRecorder.start(CHUNK_INTERVAL_MS);
  console.info(`[LangLearn] [AUDIO] Rolling buffer started. State: ${mediaRecorder.state}`);

  // ── Start self-sustaining keepalive (independent of service worker) ──
  startSelfKeepalive();

  return 'recording';
}

/**
 * Flush the rolling buffer: compile all chunks within the last 10 s into a
 * single base64-encoded audio/webm data-URL.  Recording continues.
 *
 * @returns {Promise<string|null>}  data:audio/webm;base64,… or null.
 */
function flushAudio() {
  return new Promise((resolve) => {
    pruneBuffer();

    console.info(`[LangLearn] [AUDIO:FLUSH] Chunks in buffer: ${rollingChunks.length}`);
    console.info(`[LangLearn] [AUDIO:FLUSH] MediaRecorder state: ${mediaRecorder?.state ?? 'null'}`);

    if (!mediaRecorder || rollingChunks.length === 0) {
      console.warn('[LangLearn] [AUDIO:FLUSH] Nothing to flush — no recorder or empty buffer.');
      return resolve(null);
    }

    const blob = new Blob(rollingChunks.map(c => c.data), { type: 'audio/webm' });
    console.info(`[LangLearn] [AUDIO:FLUSH] Compiled blob: ${blob.size} bytes, type: "${blob.type}"`);

    if (blob.size === 0) {
      console.warn('[LangLearn] [AUDIO:FLUSH] Blob is 0 bytes — MediaRecorder produced no data.');
      return resolve(null);
    }

    const reader = new FileReader();

    reader.onloadend = () => {
      if (reader.readyState !== FileReader.DONE) {
        console.error('[LangLearn] [AUDIO:FLUSH] FileReader did not complete.');
        return resolve(null);
      }

      const result = reader.result;
      if (!result || typeof result !== 'string') {
        console.error('[LangLearn] [AUDIO:FLUSH] FileReader result is empty or not a string.');
        return resolve(null);
      }

      console.info(`[LangLearn] [AUDIO:FLUSH] Data URL length: ${result.length} chars`);
      console.info(`[LangLearn] [AUDIO:FLUSH] Data URL prefix: "${result.substring(0, 60)}…"`);
      resolve(result);
    };

    reader.onerror = (err) => {
      console.error('[LangLearn] [AUDIO:FLUSH] FileReader error:', err);
      resolve(null);
    };

    reader.readAsDataURL(blob);
  });
}

/**
 * Stop the rolling buffer entirely and release ALL audio resources.
 * Returns the final buffered audio as a base64 data-URL.
 *
 * @returns {Promise<string|null>}
 */
function stopAudio() {
  return new Promise((resolve) => {
    if (!mediaRecorder) {
      console.warn('[LangLearn] [AUDIO:STOP] No active MediaRecorder.');
      teardownAudio(); // clean up any partial state anyway
      return resolve(null);
    }

    mediaRecorder.onstop = () => {
      const blob = new Blob(rollingChunks.map(c => c.data), { type: 'audio/webm' });
      console.info(`[LangLearn] [AUDIO:STOP] Final blob: ${blob.size} bytes from ${rollingChunks.length} chunks`);

      // Full teardown (stops tracks, closes AudioContext, stops keepalive)
      teardownAudio();

      if (blob.size === 0) {
        console.warn('[LangLearn] [AUDIO:STOP] Final blob is 0 bytes.');
        return resolve(null);
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.readyState === FileReader.DONE && typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          console.error('[LangLearn] [AUDIO:STOP] FileReader did not produce a valid result.');
          resolve(null);
        }
      };
      reader.onerror = () => {
        console.error('[LangLearn] [AUDIO:STOP] FileReader error.');
        resolve(null);
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.stop();
    console.info('[LangLearn] [AUDIO:STOP] Rolling audio buffer stopping…');
  });
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only handle messages explicitly targeted at the offscreen document
  if (message.target !== 'offscreen') return;

  const { action, payload } = message;

  if (action === 'parse:init') {
    initTokenizer()
      .then(() => {
        sendResponse({ success: true, data: 'ready' });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: { code: 'PARSE_INIT_FAILED', message: err.message || 'Failed to initialise the Japanese tokenizer.' },
        });
      });
    return true; // async response
  }

  if (action === 'parse:tokenize') {
    const text = payload?.text;

    if (!text || typeof text !== 'string') {
      sendResponse({
        success: false,
        error: { code: 'PARSE_ERROR', message: 'No text provided for tokenization.' },
      });
      return false;
    }

    // Ensure tokenizer is ready before parsing
    initTokenizer()
      .then(() => {
        const tokens = tokenize(text);
        sendResponse({ success: true, data: tokens });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: { code: 'PARSE_INIT_FAILED', message: err.message || 'Failed to initialise the Japanese tokenizer.' },
        });
      });
    return true; // async response
  }

  if (action === 'audio:start') {
    startAudio(payload.streamId)
      .then((status) => {
        const diag = {
          recorderState: mediaRecorder?.state ?? 'null',
          trackCount: recordingStream?.getAudioTracks()?.length ?? 0,
          audioCtxState: audioContext?.state ?? 'null',
        };
        sendResponse({ success: true, data: status, diagnostics: diag });
      })
      .catch((err) => sendResponse({ success: false, error: { code: 'AUDIO_START_ERR', message: err.message } }));
    return true;
  }

  if (action === 'audio:flush') {
    // Capture diagnostic state BEFORE flushing
    const diag = {
      hasRecorder: !!mediaRecorder,
      recorderState: mediaRecorder?.state ?? 'null',
      chunksCount: rollingChunks.length,
      hasStream: !!recordingStream,
      streamTrackStates: recordingStream?.getAudioTracks()?.map(t => ({
        enabled: t.enabled, readyState: t.readyState, muted: t.muted
      })) ?? [],
      audioCtxState: audioContext?.state ?? 'null',
    };
    console.info('[LangLearn] [AUDIO:FLUSH] Diagnostics:', JSON.stringify(diag));

    flushAudio()
      .then((b64) => sendResponse({ success: true, data: b64, diagnostics: diag }))
      .catch((err) => sendResponse({ success: false, error: { code: 'AUDIO_FLUSH_ERR', message: err.message }, diagnostics: diag }));
    return true;
  }

  if (action === 'audio:teardown') {
    // Force-clean all audio resources without encoding any data.
    // Used by audio:init before requesting a new tabCapture stream.
    teardownAudio();
    sendResponse({ success: true, data: 'teardown_complete' });
    return false; // synchronous
  }

  if (action === 'audio:stop') {
    stopAudio()
      .then((b64) => sendResponse({ success: true, data: b64 }))
      .catch((err) => sendResponse({ success: false, error: { code: 'AUDIO_STOP_ERR', message: err.message } }));
    return true;
  }

  if (action === 'audio:ping') {
    // Keepalive handler — returns current recording state to keep the
    // service worker ↔ offscreen document connection alive in MV3.
    const state = {
      hasRecorder: !!mediaRecorder,
      recorderState: mediaRecorder?.state ?? 'null',
      chunksCount: rollingChunks.length,
      hasStream: !!recordingStream,
      audioCtxState: audioContext?.state ?? 'null',
    };
    console.debug('[LangLearn] [AUDIO:PING]', JSON.stringify(state));
    sendResponse({ success: true, data: state });
    return false; // synchronous
  }

  if (action === 'audio:status') {
    // Lightweight status query — used by content script pre-flush check
    const state = {
      hasRecorder: !!mediaRecorder,
      recorderState: mediaRecorder?.state ?? 'null',
      chunksCount: rollingChunks.length,
      hasStream: !!recordingStream,
      audioCtxState: audioContext?.state ?? 'null',
      keepaliveActive: selfKeepaliveId !== null,
    };
    sendResponse({ success: true, data: state });
    return false; // synchronous
  }
});

console.info('[LangLearn] [INFO] Offscreen document loaded.');
