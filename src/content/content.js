/**
 * LangLearn — Content Script (Phase 5 — Reactive Zero-DOM-Mutation)
 *
 * ARCHITECTURE PIVOT:
 *   Previous versions wrapped every Japanese text node with <span> tags via
 *   TreeWalker + MutationObserver. This caused catastrophic lag on YouTube
 *   and other dynamic SPA pages.
 *
 * New Strategy — Reactive Parsing:
 *   1. Leave the host page DOM completely untouched. Zero injected spans.
 *   2. Listen for Shift + mousemove globally.
 *   3. Use document.caretRangeFromPoint() to grab the exact TextNode and
 *      character offset under the cursor.
 *   4. Extract the surrounding sentence, send it to Kuromoji via the
 *      background service worker, and mathematically map the cursor's
 *      character offset to the correct returned token.
 *   5. Display a Shadow DOM tooltip near the cursor with the parsed word,
 *      its reading, POS, known/new status, and an "Add to Anki" button.
 */

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------
const JAPANESE_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F]/;
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);
const VALID_POS = new Set([
  '名詞',   // Nouns
  '動詞',   // Verbs
  '形容詞', // Adjectives
  '副詞',   // Adverbs
  '固有名詞', // Proper Nouns
  '未知語', // Unknown Words
  '感動詞', // Interjections
  '接続詞', // Conjunctions
  '連体詞', // Adnominals
  '助詞',   // Particles (の, から, を)
  '助動詞', // Auxiliary Verbs (た, ました, なら)
]);

/** Minimum time (ms) between processing consecutive mousemove events. */
const THROTTLE_MS = 60;

/** How long (ms) the tooltip stays visible after the cursor leaves the word region. */
const TOOLTIP_LINGER_MS = 300;

function containsJapanese(text) {
  return JAPANESE_REGEX.test(text);
}

/**
 * Converts Katakana string to Hiragana
 * @param {string} katakanaStr 
 * @returns {string}
 */
function convertKatakanaToHiragana(katakanaStr) {
  return katakanaStr.replace(/[\u30a1-\u30f6]/g, function(match) {
    var chr = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(chr);
  });
}

// ---------------------------------------------------------------------------
// Service Worker Communication
// ---------------------------------------------------------------------------
function sendMessage(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[LangLearn] sendMessage failed:', chrome.runtime.lastError.message);
        resolve({ success: false, error: { code: 'UNKNOWN', message: chrome.runtime.lastError.message } });
        return;
      }
      resolve(response);
    });
  });
}

// ---------------------------------------------------------------------------
// Sentence Extraction Utilities
// ---------------------------------------------------------------------------

/**
 * Japanese sentence-ending punctuation set.
 * Used to locate the sentence boundaries around the cursor.
 */
const SENTENCE_DELIMITERS = new Set(['。', '！', '？', '!', '?', '\n']);

/**
 * Given a string and a character offset, extract the sentence that contains
 * that offset. Sentences are delimited by SENTENCE_DELIMITERS.
 *
 * @param {string} fullText  The entire textContent of the TextNode.
 * @param {number} offset    The character index (0-based) of the cursor.
 * @returns {{ sentence: string, sentenceStart: number }}
 */
function extractSentence(fullText, offset) {
  // Walk backwards to find the sentence start
  let start = offset;
  while (start > 0 && !SENTENCE_DELIMITERS.has(fullText[start - 1])) {
    start--;
  }

  // Walk forwards to find the sentence end
  let end = offset;
  while (end < fullText.length && !SENTENCE_DELIMITERS.has(fullText[end])) {
    end++;
  }
  // Include the trailing delimiter if it's a punctuation mark (not newline)
  if (end < fullText.length && fullText[end] !== '\n') {
    end++;
  }

  return {
    sentence: fullText.slice(start, end),
    sentenceStart: start,
  };
}

/**
 * Given a list of Kuromoji tokens and a character offset *relative to the
 * sentence start*, find which token the cursor is on.
 *
 * @param {Array} tokens       Kuromoji token array (each has `.surface`).
 * @param {number} localOffset Character offset within the sentence.
 * @returns {object|null}      The matched token, or null.
 */
function tokenAtOffset(tokens, localOffset) {
  let cursor = 0;
  for (const token of tokens) {
    const tokenEnd = cursor + token.surface.length;
    if (localOffset >= cursor && localOffset < tokenEnd) {
      return token;
    }
    cursor = tokenEnd;
  }
  return null;
}

// ---------------------------------------------------------------------------
// YouTube / Video Overlay Sentence Stitching
// ---------------------------------------------------------------------------

/**
 * Calculate the text offset of a specific TextNode within a container element,
 * by walking all child text nodes in DOM order.
 *
 * @param {Element} container   Parent container.
 * @param {Text}    targetNode  The TextNode the cursor is in.
 * @param {number}  charOffset  Offset within that TextNode.
 * @returns {number}            Offset within the container's full textContent.
 */
function getTextOffsetInContainer(container, targetNode, charOffset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node === targetNode) return offset + charOffset;
    offset += node.textContent.length;
  }
  return charOffset; // fallback
}

/**
 * Calculate the offset of a character within the stitched text of all
 * .ytp-caption-segment elements, given a specific segment and local offset.
 *
 * @param {NodeList} allSegments   All .ytp-caption-segment elements.
 * @param {Element}  targetSegment The segment containing the cursor.
 * @param {number}   charOffset    Offset within the target segment's text.
 * @returns {number}
 */
function getSegmentStitchedOffset(allSegments, targetSegment, charOffset) {
  let offset = 0;
  for (const seg of allSegments) {
    if (seg === targetSegment || seg.contains(targetSegment)) {
      return offset + charOffset;
    }
    offset += seg.textContent.length;
  }
  return charOffset; // fallback
}

/**
 * Attempt to extract a full stitched sentence when hovering inside a video
 * subtitle context (our overlay or native YouTube captions).
 *
 * @param {Text}   textNode   The TextNode under the cursor.
 * @param {number} charOffset Character offset within that TextNode.
 * @returns {{ sentence: string, localOffset: number } | null}
 */
function extractVideoSentence(textNode, charOffset) {
  const parent = textNode.parentElement;
  if (!parent) return null;

  // Case 1: Inside our video.js subtitle overlay
  const subtitleContainer = parent.closest('.ll-subtitle-container');
  if (subtitleContainer) {
    const sentence = subtitleContainer.textContent;
    const localOffset = getTextOffsetInContainer(subtitleContainer, textNode, charOffset);
    return { sentence, localOffset };
  }

  // Case 2: Inside native YouTube caption segments
  const captionSegment = parent.closest('.ytp-caption-segment');
  if (captionSegment) {
    const allSegments = document.querySelectorAll('.ytp-caption-segment');
    const sentence = Array.from(allSegments).map(s => s.textContent).join('');
    const localOffset = getSegmentStitchedOffset(allSegments, captionSegment, charOffset);
    return { sentence, localOffset };
  }

  // Case 3: YouTube fallback — read the entire caption window container
  //         Catches edge cases where segment DOM structure changes.
  if (location.hostname.includes('youtube.com')) {
    const captionWindow = document.querySelector('.ytp-caption-window-container');
    if (captionWindow) {
      const sentence = captionWindow.innerText.trim();
      if (sentence && containsJapanese(sentence)) {
        const localOffset = getTextOffsetInContainer(captionWindow, textNode, charOffset);
        return { sentence, localOffset };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Video Canvas Screenshot
// ---------------------------------------------------------------------------

/**
 * Capture the current frame of the nearest visible <video> element as a
 * base64-encoded JPEG string (without the data-URL prefix).
 *
 * @returns {string|null}  Raw base64 JPEG, or null if no video is found.
 */
function captureVideoScreenshot() {
  // Find the most relevant video element on the page
  const videos = Array.from(document.querySelectorAll('video'));
  // Prefer the largest playing video; fall back to the largest paused one
  const video =
    videos.find(v => !v.paused && v.videoWidth > 0) ||
    videos.find(v => v.videoWidth > 0);

  if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Export as JPEG at 92% quality (good balance of size vs clarity)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

    // Strip the "data:image/jpeg;base64," prefix for AnkiConnect
    return dataUrl.split(',')[1] || null;
  } catch (err) {
    // Can fail on cross-origin videos (CORS)
    console.warn('[LangLearn] Screenshot capture failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shadow DOM Tooltip Architecture
// ---------------------------------------------------------------------------
let shadowHost, shadowRoot, tooltip;
let ttDictform, ttReading, ttPos, ttStatus, ttAudioStatus, ttDefinition, btnAdd, ttJpodBtn;
let activeToken = null;
let activeSentence = '';
let activeDefinitionHtml = '';

function setupTooltip() {
  shadowHost = document.createElement('div');
  shadowHost.id = 'langlearn-tooltip-host';
  // Ensure the host is invisible and non-interfering
  shadowHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(shadowHost);

  shadowRoot = shadowHost.attachShadow({ mode: 'open' });

  // ── Build tooltip DOM programmatically (Trusted Types safe) ──
  // YouTube enforces strict Trusted Types CSP that blocks innerHTML.
  // All DOM construction uses createElement + textContent instead.

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    #tooltip {
      position: fixed; z-index: 2147483647;
      background: #1a1a2e; color: #eee;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 14px 16px;
      font-family: "Segoe UI", "Hiragino Kaku Gothic ProN", "Meiryo", system-ui, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04);
      display: none; flex-direction: column; gap: 6px;
      min-width: 180px; max-width: 320px;
      pointer-events: auto;
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      animation: tt-fade-in 0.15s ease-out;
    }
    @keyframes tt-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .dictform { font-size: 22px; font-weight: 700; color: #fff; letter-spacing: 0.02em; }
    .reading { font-size: 14px; color: rgba(255,255,255,0.5); }
    .jpod-btn { cursor: pointer; font-size: 14px; opacity: 0.7; transition: all 0.2s; user-select: none; margin-top: 1px; }
    .jpod-btn:hover { opacity: 1; transform: scale(1.15); }
    .meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pos {
      font-size: 11px; color: rgba(255,255,255,0.7);
      background: rgba(255,255,255,0.08); padding: 2px 8px;
      border-radius: 4px; font-weight: 500;
    }
    .status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .status.known { background: rgba(52, 211, 153, 0.15); color: #34d399; }
    .status.new-word { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
    .audio-status {
      font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px;
      margin-left: auto;
      color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.08);
    }
    .audio-status.recording {
      color: #fca5a5; background: rgba(248, 113, 113, 0.15);
    }
    .divider { height: 1px; background: rgba(255,255,255,0.06); margin: 2px 0; }
    .definition {
      font-size: 13px; color: #e2e8f0; margin: 8px 0; line-height: 1.4;
      padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px;
    }
    .definition ol { margin: 0; padding-left: 20px; }
    .definition li { margin-bottom: 4px; }
    .definition li:last-child { margin-bottom: 0; }
    button {
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
      border: none; border-radius: 6px; padding: 7px 14px; cursor: pointer;
      font-weight: 600; font-size: 13px; transition: all 0.2s ease; letter-spacing: 0.01em;
    }
    button:hover {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99,102,241,0.3);
    }
    button:active { transform: translateY(0); }
    button:disabled {
      background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.3);
      cursor: not-allowed; transform: none; box-shadow: none;
    }
    button.success { background: linear-gradient(135deg, #059669, #10b981); }
    button.error { background: linear-gradient(135deg, #dc2626, #ef4444); }
  `;
  shadowRoot.appendChild(style);

  const ttEl = document.createElement('div');
  ttEl.id = 'tooltip';

  const header = document.createElement('div');
  header.className = 'header';
  const dfSpan = document.createElement('span');
  dfSpan.className = 'dictform';
  dfSpan.id = 'tt-dictform';
  
  const readingContainer = document.createElement('div');
  readingContainer.style.display = 'flex';
  readingContainer.style.alignItems = 'center';
  readingContainer.style.gap = '6px';
  
  const rdSpan = document.createElement('span');
  rdSpan.className = 'reading';
  rdSpan.id = 'tt-reading';
  
  const jpodBtn = document.createElement('span');
  jpodBtn.className = 'jpod-btn';
  jpodBtn.id = 'tt-jpod-btn';
  jpodBtn.textContent = '🔊';
  jpodBtn.title = 'Play native audio';
  
  readingContainer.appendChild(rdSpan);
  readingContainer.appendChild(jpodBtn);
  
  header.appendChild(dfSpan);
  header.appendChild(readingContainer);

  const metaRow = document.createElement('div');
  metaRow.className = 'meta-row';
  const posSpan = document.createElement('span');
  posSpan.className = 'pos';
  posSpan.id = 'tt-pos';
  const statusSpan = document.createElement('span');
  statusSpan.className = 'status';
  statusSpan.id = 'tt-status';
  
  const audioSpan = document.createElement('span');
  audioSpan.className = 'audio-status';
  audioSpan.id = 'tt-audio-status';

  metaRow.appendChild(posSpan);
  metaRow.appendChild(statusSpan);
  metaRow.appendChild(audioSpan);

  const divider = document.createElement('div');
  divider.className = 'divider';

  const definitionDiv = document.createElement('div');
  definitionDiv.className = 'definition';
  definitionDiv.id = 'tt-definition';

  const addBtn = document.createElement('button');
  addBtn.id = 'tt-add-btn';
  addBtn.textContent = 'Add to Anki';

  ttEl.appendChild(header);
  ttEl.appendChild(metaRow);
  ttEl.appendChild(divider);
  ttEl.appendChild(definitionDiv);
  ttEl.appendChild(addBtn);
  shadowRoot.appendChild(ttEl);

  tooltip  = shadowRoot.getElementById('tooltip');
  ttDictform = shadowRoot.getElementById('tt-dictform');
  ttReading  = shadowRoot.getElementById('tt-reading');
  ttPos      = shadowRoot.getElementById('tt-pos');
  ttStatus   = shadowRoot.getElementById('tt-status');
  ttAudioStatus = shadowRoot.getElementById('tt-audio-status');
  ttDefinition = shadowRoot.getElementById('tt-definition');
  ttJpodBtn  = shadowRoot.getElementById('tt-jpod-btn');
  btnAdd     = shadowRoot.getElementById('tt-add-btn');

  // Keep tooltip open while hovering over it
  tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tooltip.addEventListener('mouseleave', () => {
    hideTimer = setTimeout(hideTooltip, TOOLTIP_LINGER_MS);
  });

  // Native audio playback on click (Left-click = Smart Fastest, Shift/Right-click = Force Jisho)
  ttJpodBtn.addEventListener('click', async (e) => {
    if (!activeToken) return;
    
    const rawWord = activeToken.dictForm || activeToken.surface;
    const hiraganaReading = convertKatakanaToHiragana(activeToken.reading || '');
    
    ttJpodBtn.style.opacity = '0.5';
    ttJpodBtn.style.pointerEvents = 'none';

    try {
      // Jisho/WaniKani Fallback
      if (e.shiftKey) {
        const res = await sendMessage('dictionary:audio', { keyword: rawWord });
        if (res?.success && res.data) {
          await new Audio(res.data).play();
        } else {
          console.warn('[LangLearn] No Jisho audio found for:', rawWord);
        }
        return;
      }
      
      const res = await sendMessage('audio:getValidAudios', { word: rawWord, reading: hiraganaReading, fastestOnly: true });
      if (res?.success && res.data && res.data.length > 0) {
        await new Audio(res.data[0]).play();
      } else {
        console.warn('[LangLearn] No valid audio found anywhere for:', rawWord);
      }
    } catch (err) {
      console.warn('[LangLearn] Audio play failed:', err);
    } finally {
      ttJpodBtn.style.opacity = '';
      ttJpodBtn.style.pointerEvents = '';
    }
  });

  // Support Right-click for Jisho Audio Fallback directly
  ttJpodBtn.addEventListener('contextmenu', async (e) => {
    if (!activeToken) return;
    e.preventDefault(); // Prevent native context menu
    
    const rawWord = activeToken.dictForm || activeToken.surface;
    ttJpodBtn.style.opacity = '0.5';
    ttJpodBtn.style.pointerEvents = 'none';
    
    try {
      const res = await sendMessage('dictionary:audio', { keyword: rawWord });
      if (res?.success && res.data) {
        await new Audio(res.data).play();
      } else {
        console.warn('[LangLearn] No Jisho audio found for:', rawWord);
      }
    } catch (err) {
      console.warn('[LangLearn] Jisho audio play failed:', err);
    } finally {
      ttJpodBtn.style.opacity = '';
      ttJpodBtn.style.pointerEvents = '';
    }
  });

  setupAnkiButton();
}

// ---------------------------------------------------------------------------
// Anki "Add" Button
// ---------------------------------------------------------------------------
function resetButton() {
  btnAdd.textContent = 'Add to Anki';
  btnAdd.disabled = false;
  btnAdd.className = '';
}

function setupAnkiButton() {
  btnAdd.addEventListener('click', async () => {
    if (!activeToken) return;

    btnAdd.textContent = 'Adding…';
    btnAdd.disabled = true;

    const stored = await chrome.storage.local.get('selectedDeck');
    const selectedDeck = stored.selectedDeck;

    if (!selectedDeck) {
      btnAdd.textContent = 'No Deck Selected!';
      btnAdd.className = 'error';
      setTimeout(() => {
        btnAdd.textContent = 'Open popup → select deck';
      }, 1500);
      return;
    }

    // ── Snapshot the sentence at click-time (bulletproof) ──
    // Re-read YouTube caption container if we're on YouTube to catch
    // any race between hover-time capture and click-time reality.
    let sentence = activeSentence;
    if (location.hostname.includes('youtube.com')) {
      const captionWindow = document.querySelector('.ytp-caption-window-container');
      if (captionWindow) {
        const live = captionWindow.innerText.trim();
        if (live && containsJapanese(live)) {
          sentence = live;
        }
      }
    }

    // ── Pre-flush: check recording status for diagnostics ──
    const statusResult = await sendMessage('audio:status');
    console.info('[LangLearn] [EXPORT] Pre-flush audio status:', JSON.stringify(statusResult?.data ?? 'unavailable'));

    // ── Gather media in parallel: audio flush + video screenshot ──
    const [audioResult, screenshotB64] = await Promise.all([
      sendMessage('audio:flush'),
      Promise.resolve(captureVideoScreenshot()),
    ]);

    // ── DIAGNOSTIC: What did we actually receive? ──
    console.info('[LangLearn] [EXPORT] audioResult:', JSON.stringify({
      success: audioResult?.success,
      hasData: !!audioResult?.data,
      dataType: typeof audioResult?.data,
      dataLength: audioResult?.data?.length ?? 0,
      dataPrefix: String(audioResult?.data ?? '').substring(0, 80),
      error: audioResult?.error,
    }));
    console.info('[LangLearn] [EXPORT] audioResult.diagnostics:', JSON.stringify(audioResult?.diagnostics ?? 'none'));
    console.info('[LangLearn] [EXPORT] screenshotB64:', screenshotB64 ? `${screenshotB64.length} chars` : 'null');

    // ── Build payload (JP Mining Note fields) ──
    const payload = {
      deck: selectedDeck,
      fields: {
        Word: activeToken.dictForm,
        WordReading: activeToken.reading,
        Sentence: sentence,
        PrimaryDefinition: activeDefinitionHtml,
      },
    };

    // Audio (rolling buffer → base64 webm) → JPMN "SentenceAudio" field
    if (audioResult.success && audioResult.data) {
      // Robust prefix strip: indexOf handles MIME params with commas
      // e.g. "data:audio/webm;codecs=opus;base64,XXXX"
      const audioRaw = audioResult.data;
      console.info(`[LangLearn] [EXPORT] Audio data URL received. Length: ${audioRaw.length}`);
      console.info(`[LangLearn] [EXPORT] Audio data URL prefix: "${audioRaw.substring(0, 60)}…"`);

      const audioMarker = audioRaw.indexOf(';base64,');
      const audioB64 = audioMarker !== -1
        ? audioRaw.substring(audioMarker + 8)  // 8 = length of ';base64,'
        : audioRaw;  // fallback: assume raw base64

      console.info(`[LangLearn] [EXPORT] Stripped audio base64 length: ${audioB64.length}`);
      console.info(`[LangLearn] [EXPORT] Stripped audio first 50 chars: "${audioB64.substring(0, 50)}"`);

      if (audioB64) {
        payload.audio = [{
          data: audioB64,
          filename: `langlearn_audio_${Date.now()}.webm`,
          fields: ['SentenceAudio'],
        }];
      }
    } else {
      console.warn('[LangLearn] [EXPORT] No audio data available.', audioResult);
    }

    // ── Native Word Audio (JPod101 + Jisho WaniKani Scrape) ──
    payload.audio = payload.audio || [];
    if (activeToken.dictForm || activeToken.surface) {
      const hiraganaReading = convertKatakanaToHiragana(activeToken.reading || '');
      const rawWord = activeToken.dictForm || activeToken.surface;
      
      const audioRes = await sendMessage('audio:getValidAudios', { word: rawWord, reading: hiraganaReading, fastestOnly: false });
      
      if (audioRes?.success && audioRes.data && audioRes.data.length > 0) {
        audioRes.data.forEach((url, index) => {
          let sourceName = 'jpod';
          if (url.includes('translate.google')) sourceName = 'tts';
          else if (url.includes('127.0.0.1') || url.includes('localhost')) sourceName = 'local';
          else if (url.includes('jisho') || url.includes('cloudfront')) sourceName = 'jisho';
          
          payload.audio.push({
            url: url,
            filename: `${sourceName}_${rawWord}_${Date.now()}_${index}.mp3`,
            fields: ['WordAudio']
          });
        });
      } else {
        console.info('[LangLearn] [EXPORT] No dictionary audio found for:', rawWord);
      }
    }

    // Picture (video canvas screenshot → base64 jpeg) → JPMN "Picture" field
    if (screenshotB64) {
      console.info(`[LangLearn] [EXPORT] Screenshot base64 length: ${screenshotB64.length}`);
      payload.picture = [{
        data: screenshotB64,
        filename: `langlearn_screenshot_${Date.now()}.jpg`,
        fields: ['Picture'],
      }];
    } else {
      console.info('[LangLearn] [EXPORT] No video screenshot captured (no video element or CORS).');
    }

    // Log the full payload structure (truncate media data for readability)
    const debugPayload = {
      ...payload,
      audio: payload.audio ? payload.audio.map(a => ({ ...a, data: `[${a.data.length} chars]` })) : undefined,
      picture: payload.picture ? payload.picture.map(p => ({ ...p, data: `[${p.data.length} chars]` })) : undefined,
    };
    console.info('[LangLearn] [EXPORT] AnkiConnect payload:', JSON.stringify(debugPayload, null, 2));

    const result = await sendMessage('anki:addNote', payload);
    console.info('[LangLearn] [EXPORT] AnkiConnect response:', JSON.stringify(result));

    if (result.success) {
      btnAdd.textContent = '✓ Added!';
      btnAdd.className = 'success';

      // Optimistically add to local known set so the tooltip updates live
      if (window.llKnownWords && activeToken.dictForm) {
        window.llKnownWords.add(activeToken.dictForm);
      }
    } else {
      btnAdd.textContent = 'Failed';
      btnAdd.className = 'error';
      console.error('[LangLearn] Anki add failed:', result.error);
      setTimeout(resetButton, 2000);
    }
  });
}

// ---------------------------------------------------------------------------
// Tooltip Show / Hide
// ---------------------------------------------------------------------------
let hideTimer = null;

/**
 * Display the tooltip at screen coordinates (x, y) for a given token.
 *
 * @param {object} token      Kuromoji token object.
 * @param {string} sentence   The surrounding sentence text.
 * @param {number} x          Client X coordinate.
 * @param {number} y          Client Y coordinate.
 */
function showTooltip(token, sentence, x, y) {
  clearTimeout(hideTimer);

  activeToken = token;
  activeSentence = sentence;

  ttDictform.textContent = token.dictForm || token.surface;
  ttReading.textContent  = token.reading || '';
  ttPos.textContent      = token.pos || '';

  const isKnown = window.llKnownWords && window.llKnownWords.has(token.dictForm);
  ttStatus.textContent = isKnown ? '✓ Known' : '★ New';
  ttStatus.className   = `status ${isKnown ? 'known' : 'new-word'}`;

  // Async recording status check
  ttAudioStatus.textContent = 'Audio: …';
  ttAudioStatus.className = 'audio-status';
  sendMessage('audio:status').then(res => {
    if (res?.data?.hasRecorder) {
      ttAudioStatus.textContent = 'Audio: 🔴 Recording';
      ttAudioStatus.className = 'audio-status recording';
    } else {
      ttAudioStatus.textContent = 'Audio: ⏸️ (Alt+R)';
      ttAudioStatus.className = 'audio-status';
    }
  }).catch(() => {
    ttAudioStatus.textContent = 'Audio: ⚠ Error';
  });

  // Async dictionary fetch
  ttDefinition.innerHTML = 'Loading definition...';
  activeDefinitionHtml = '';
  sendMessage('dictionary:fetch', { keyword: token.dictForm || token.surface }).then(res => {
    if (res?.success && res.data) {
      // NOTE: res.data contains clean HTML generated securely in the service worker
      ttDefinition.innerHTML = res.data;
      activeDefinitionHtml = res.data;
    } else {
      ttDefinition.textContent = 'Definition not found.';
    }
  }).catch(() => {
    ttDefinition.textContent = 'Error fetching definition.';
  });

  resetButton();
  tooltip.style.display = 'flex';

  // Position: below and to the right of the cursor, clamped to viewport
  const PAD = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Render off-screen first to measure
  tooltip.style.left = '0px';
  tooltip.style.top  = '0px';
  const rect = tooltip.getBoundingClientRect();
  const tw = rect.width;
  const th = rect.height;

  let left = x + PAD;
  let top  = y + PAD;

  // Clamp horizontally
  if (left + tw > vw - PAD) {
    left = x - tw - PAD;
  }
  if (left < PAD) left = PAD;

  // Clamp vertically
  if (top + th > vh - PAD) {
    top = y - th - PAD;
  }
  if (top < PAD) top = PAD;

  tooltip.style.left = `${left}px`;
  tooltip.style.top  = `${top}px`;
}

function hideTooltip() {
  tooltip.style.display = 'none';
  activeToken = null;
  activeSentence = '';
}

// ---------------------------------------------------------------------------
// Reactive Mouse Listener (Shift + Mousemove → Caret → Parse)
// ---------------------------------------------------------------------------

/** Cache: avoid re-parsing the same text node / sentence on every pixel. */
let lastTextNode = null;
let lastSentenceText = '';
let lastTokens = null;
let lastTokenOffset = -1;
let pendingParse = false;

/** Timestamp of the last processed event (for throttling). */
let lastProcessTime = 0;

/**
 * Core handler: fired on every mousemove while Shift is held.
 * Extracts the TextNode under the cursor, parses the sentence via Kuromoji,
 * maps the cursor offset to a token, and shows the tooltip.
 */
async function handleReactiveHover(e) {
  // ── Guard: must be holding Shift ──
  if (!e.shiftKey) {
    // If Shift is released, hide the tooltip after a brief linger
    if (tooltip && tooltip.style.display !== 'none') {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideTooltip, TOOLTIP_LINGER_MS);
    }
    return;
  }

  // ── Throttle ──
  const now = performance.now();
  if (now - lastProcessTime < THROTTLE_MS) return;
  lastProcessTime = now;

  // ── Caret extraction ──
  // caretRangeFromPoint is Chromium-only but we're a Chrome extension.
  const range = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!range) return;

  const textNode = range.startContainer;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;

  // Skip nodes inside ignored elements
  const parent = textNode.parentElement;
  if (!parent || IGNORED_TAGS.has(parent.tagName)) return;

  // Skip if inside our own tooltip shadow host
  if (parent.closest && parent.closest('#langlearn-tooltip-host')) return;

  const fullText = textNode.textContent;
  const charOffset = range.startOffset;

  if (!containsJapanese(fullText)) return;

  // ── Extract sentence (YouTube-aware stitching) ──
  let sentence, localOffset;

  const videoContext = extractVideoSentence(textNode, charOffset);
  if (videoContext) {
    // Inside a video subtitle overlay or YouTube caption
    sentence = videoContext.sentence;
    localOffset = videoContext.localOffset;
  } else {
    // Regular page text
    const { sentence: s, sentenceStart } = extractSentence(fullText, charOffset);
    sentence = s;
    localOffset = charOffset - sentenceStart;
  }

  if (!sentence || !sentence.trim() || !containsJapanese(sentence)) return;

  // ── Cache check: skip re-parse if same sentence ──
  if (textNode === lastTextNode && sentence === lastSentenceText && lastTokens) {
    // Just re-map offset → token (cursor moved within same sentence)
    const token = tokenAtOffset(lastTokens, localOffset);
    if (token && (VALID_POS.has(token.pos) || VALID_POS.has(token.pos_detail))) {
      // Check if it's actually a different token than last time
      const tokenStart = getTokenStart(lastTokens, token);
      if (tokenStart !== lastTokenOffset) {
        lastTokenOffset = tokenStart;
        showTooltip(token, sentence, e.clientX, e.clientY);
      }
      return;
    }
    // Cursor is on a non-targetable token (particle, etc.) — hide
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideTooltip, TOOLTIP_LINGER_MS);
    return;
  }

  // ── Parse new sentence via Kuromoji ──
  if (pendingParse) return; // Don't stack requests
  pendingParse = true;

  const result = await sendMessage('parse:tokenize', { text: sentence });
  pendingParse = false;

  if (!result.success || !result.data) return;

  // Cache
  lastTextNode = textNode;
  lastSentenceText = sentence;
  lastTokens = result.data;

  // ── Map offset → token ──
  const token = tokenAtOffset(lastTokens, localOffset);
  if (!token) return;

  if (VALID_POS.has(token.pos) || VALID_POS.has(token.pos_detail)) {
    lastTokenOffset = getTokenStart(lastTokens, token);
    showTooltip(token, sentence, e.clientX, e.clientY);
  } else {
    // Non-targetable token (particle, punctuation)
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideTooltip, TOOLTIP_LINGER_MS);
  }
}

/**
 * Returns the character start position of a token within its token list.
 */
function getTokenStart(tokens, target) {
  let pos = 0;
  for (const t of tokens) {
    if (t === target) return pos;
    pos += t.surface.length;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Global Event Binding
// ---------------------------------------------------------------------------
function bindReactiveListener() {
  // Use { passive: true } for maximum scroll/paint performance.
  // The handler itself only runs meaningful work when Shift is held.
  document.addEventListener('mousemove', handleReactiveHover, { passive: true });

  // Hide tooltip on scroll (prevents stale positioning)
  let scrollHideTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => {
      if (tooltip && tooltip.style.display !== 'none') {
        hideTooltip();
      }
    }, 100);
  }, { passive: true });

  // Hide on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tooltip && tooltip.style.display !== 'none') {
      clearTimeout(hideTimer);
      hideTooltip();
    }
  });
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

window.llKnownWords = new Set();

async function main() {
  console.info('[LangLearn] Content script loaded (Reactive Zero-DOM-Mutation mode).');

  // Fetch known words into memory
  const dbResult = await sendMessage('db:getKnownWords');
  if (dbResult.success && dbResult.data) {
    window.llKnownWords = new Set(dbResult.data);
    console.info(`[LangLearn] Loaded ${window.llKnownWords.size} known words into memory.`);
  }

  // Build isolated Shadow DOM tooltip
  setupTooltip();

  // Bind the reactive Shift + mousemove listener
  bindReactiveListener();

  // NOTE: Audio capture is NOT initialized here.
  // MV3 requires tabCapture to be triggered from the extension's own UI context
  // (popup/action click). The popup.js handles audio:init on user interaction.
  // content.js only calls audio:flush when building the Anki export payload.

  console.info('[LangLearn] Reactive listener active. Hold Shift and hover over Japanese text.');
}

main();
