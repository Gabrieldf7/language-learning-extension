/**
 * LangLearn — AnkiConnect HTTP Client
 *
 * Pure ES module with ZERO Chrome API dependencies.
 * All communication uses the AnkiConnect JSON-RPC-style envelope.
 *
 * This module is designed to run inside the background service worker,
 * which has host_permissions for http://127.0.0.1:8765.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ANKI_CONNECT_URL = 'http://127.0.0.1:8765';
export const ANKI_CONNECT_VERSION = 6;

const REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

export class AnkiConnectError extends Error {
  /**
   * @param {string} message
   * @param {'ANKI_OFFLINE'|'ANKI_TIMEOUT'|'ANKI_API_ERROR'|'ANKI_INVALID_RESPONSE'|'UNKNOWN'} code
   */
  constructor(message, code = 'UNKNOWN') {
    super(message);
    this.name = 'AnkiConnectError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal: JSON-RPC envelope builder + fetcher
// ---------------------------------------------------------------------------

/**
 * Send a single action to AnkiConnect and return the unwrapped result.
 *
 * @param {string} action  — AnkiConnect action name
 * @param {object} [params] — action-specific parameters
 * @returns {Promise<any>}  — the `result` field from the response
 * @throws {AnkiConnectError}
 */
async function _invoke(action, params = {}) {
  const body = JSON.stringify({
    action,
    version: ANKI_CONNECT_VERSION,
    params,
  });

  // -- Diagnostic: log the request (truncate base64 media for readability) --
  try {
    const debugParams = JSON.parse(JSON.stringify(params));
    if (debugParams.note) {
      if (debugParams.note.audio) {
        debugParams.note.audio = debugParams.note.audio.map(a => ({
          ...a,
          data: a.data ? `[base64: ${a.data.length} chars]` : '(empty)',
        }));
      }
      if (debugParams.note.picture) {
        debugParams.note.picture = debugParams.note.picture.map(p => ({
          ...p,
          data: p.data ? `[base64: ${p.data.length} chars]` : '(empty)',
        }));
      }
    }
    console.info(`[LangLearn] [AnkiConnect] → ${action}`, JSON.stringify(debugParams, null, 2));
  } catch { /* non-critical logging */ }

  // --- Timeout via AbortController ---
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ANKI_CONNECT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AnkiConnectError(
        'Anki is not responding. It may be busy syncing.',
        'ANKI_TIMEOUT',
      );
    }
    // Network-level failure (Anki not running, port closed, etc.)
    throw new AnkiConnectError(
      'Anki is not running. Please open Anki and make sure AnkiConnect is installed.',
      'ANKI_OFFLINE',
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // --- Parse response ---
  let json;
  try {
    json = await response.json();
  } catch {
    throw new AnkiConnectError(
      'Received an unexpected response from AnkiConnect.',
      'ANKI_INVALID_RESPONSE',
    );
  }

  // AnkiConnect always returns { result, error }
  if (json.error !== null && json.error !== undefined) {
    throw new AnkiConnectError(String(json.error), 'ANKI_API_ERROR');
  }

  return json.result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ping AnkiConnect to verify it is reachable and the protocol version matches.
 * Uses the lightweight "version" action.
 *
 * @returns {Promise<boolean>} — true if reachable, false otherwise
 */
export async function ping() {
  try {
    const version = await _invoke('version');
    return typeof version === 'number';
  } catch {
    return false;
  }
}

/**
 * Retrieve the list of deck names from Anki.
 *
 * @returns {Promise<string[]>}
 * @throws {AnkiConnectError}
 */
export async function getDeckNames() {
  const result = await _invoke('deckNames');

  if (!Array.isArray(result)) {
    throw new AnkiConnectError(
      'Received an unexpected response from AnkiConnect.',
      'ANKI_INVALID_RESPONSE',
    );
  }

  return result;
}

/**
 * Add a new note to Anki using the JP Mining Note (JPMN) template.
 *
 * @param {string} deckName  — target deck (e.g. "Japanese::Vocab")
 * @param {{ Word: string, WordReading: string, Sentence: string }} fields
 * @param {Array|null} audio   — AnkiConnect audio array (inline base64)
 * @param {Array|null} picture — AnkiConnect picture array (inline base64)
 * @returns {Promise<number>} — the new note's ID
 * @throws {AnkiConnectError}
 */
export async function addNote(deckName, fields, audio = null, picture = null) {
  const note = {
    deckName,
    modelName: 'JP Mining Note',
    fields: {
      Word:        fields.Word        || '',
      Key:         fields.Word        || '',  // JPMN requires Key for duplicate-checking
      WordReading: fields.WordReading || '',
      Sentence:    fields.Sentence    || '',
    },
    options: {
      allowDuplicate: false,
      duplicateScope: 'deck',
    },
    tags: ['lang-learn-ext'],
  };

  if (audio) {
    note.audio = audio;
  }

  if (picture) {
    note.picture = picture;
  }

  const noteId = await _invoke('addNote', { note });

  return noteId;
}

/**
 * Find notes using an Anki query string.
 *
 * @param {string} query
 * @returns {Promise<number[]>} — array of note IDs
 * @throws {AnkiConnectError}
 */
export async function findNotes(query) {
  const result = await _invoke('findNotes', { query });
  return result;
}

/**
 * Get note information for an array of note IDs.
 *
 * @param {number[]} notes
 * @returns {Promise<any[]>} — array of note info objects
 * @throws {AnkiConnectError}
 */
export async function notesInfo(notes) {
  const result = await _invoke('notesInfo', { notes });
  return result;
}
