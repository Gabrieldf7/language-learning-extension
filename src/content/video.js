class SubtitleController {
  // Track which video elements already have a controller to prevent duplicates
  static _controlledVideos = new WeakSet();

  constructor(videoElement) {
    // Guard: never create two controllers for the same <video>
    if (SubtitleController._controlledVideos.has(videoElement)) return;
    SubtitleController._controlledVideos.add(videoElement);

    this.video = videoElement;
    this.overlay = null;
    // Map to prevent duplicate track binding
    this.boundTracks = new Set();
    // Drag state
    this.isDragging = false;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.customPosition = null; // { x, y } relative to overlay, or null for default
    // Render generation counter — prevents stale async callbacks from clobbering
    this._renderGen = 0;
    this.init();
  }

  init() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'll-subtitle-overlay';
    
    // Attempt to map directly into YouTube's core player layer, falling back safely to the direct parent
    const domTarget = this.video.closest('.html5-video-player') || this.video.parentElement;
    if (domTarget) {
      domTarget.appendChild(this.overlay);
    }

    this.trackChangeListener = this.onCueChange.bind(this);
    
    if (this.video.textTracks) {
       Array.from(this.video.textTracks).forEach(t => this.bindTrack(t));
       this.video.textTracks.addEventListener('addtrack', (e) => this.bindTrack(e.track));
    }
    
    // YouTube Specific Caption Observer Hook
    if (domTarget && domTarget.classList.contains('html5-video-player')) {
       this.initYouTubeFallback(domTarget);
    }

    // Set up drag listeners on the overlay (delegated)
    this.setupDragListeners();
  }

  initYouTubeFallback(domTarget) {
     const watchForCaptionContainer = () => {
       const container = domTarget.querySelector('.ytp-caption-window-container');
       if (container) {
           const ytObserver = new MutationObserver(() => {
              // Suppress re-renders while the user is dragging the subtitle
              if (this.isDragging) return;

              const segments = container.querySelectorAll('.ytp-caption-segment');
              const text = Array.from(segments).map(s => s.textContent).join('');
              
              if (text === this.lastYtText) return; // Prevent excessive parsing
              this.lastYtText = text;
              
              if (text.trim() === '') {
                 this.overlay.replaceChildren();
                 return;
              }
              
              if (this.containsJapanese(text)) {
                 this.renderSubtitle(text);
              }
           });
          
          // Confine extremely intensive DOM updates exclusively to the caption container
          ytObserver.observe(container, { childList: true, subtree: true, characterData: true });
       } else {
          setTimeout(watchForCaptionContainer, 1000); // Check again lightly if container mounts late
       }
     };
     
     watchForCaptionContainer();
  }

  // ── Drag-to-reposition logic ──────────────────────────────────────────────

  setupDragListeners() {
    this.overlay.addEventListener('mousedown', (e) => {
      const container = e.target.closest('.ll-subtitle-container');
      if (!container) return;

      // Don't start drag on word spans (those are for tooltip interaction)
      if (e.target.classList.contains('ll-word')) return;

      e.preventDefault();
      this.isDragging = true;

      const overlayRect = this.overlay.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      // Calculate offset of mouse within the subtitle container
      this.dragOffsetX = e.clientX - containerRect.left;
      this.dragOffsetY = e.clientY - containerRect.top;

      container.classList.add('ll-dragging');
      this._activeDragContainer = container;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this._activeDragContainer) return;

      const overlayRect = this.overlay.getBoundingClientRect();

      // Calculate new position relative to the overlay
      let x = e.clientX - overlayRect.left - this.dragOffsetX;
      let y = e.clientY - overlayRect.top - this.dragOffsetY;

      // Clamp within overlay bounds
      const containerWidth = this._activeDragContainer.offsetWidth;
      const containerHeight = this._activeDragContainer.offsetHeight;

      x = Math.max(0, Math.min(x, overlayRect.width - containerWidth));
      y = Math.max(0, Math.min(y, overlayRect.height - containerHeight));

      this.customPosition = { x, y };
      this.applyCustomPosition(this._activeDragContainer);
    });

    document.addEventListener('mouseup', () => {
      if (!this.isDragging) return;
      this.isDragging = false;

      if (this._activeDragContainer) {
        this._activeDragContainer.classList.remove('ll-dragging');
        this._activeDragContainer = null;
      }
    });
  }

  applyCustomPosition(container) {
    if (!this.customPosition) return;

    // Switch overlay from flex-end alignment to top-left so absolute positioning works
    this.overlay.style.alignItems = 'flex-start';
    this.overlay.style.justifyContent = 'flex-start';
    this.overlay.style.paddingBottom = '0';

    container.style.position = 'absolute';
    container.style.left = `${this.customPosition.x}px`;
    container.style.top = `${this.customPosition.y}px`;
  }

  updatePosition() {
    // Deprecated. Cleaned up due to direct CSS 100% overlay inheritance rule implementation.
  }

  bindTrack(track) {
    if (this.boundTracks.has(track)) return;
    this.boundTracks.add(track);

    // Forces events to fire, but stops browser UI natively rendering them
    track.mode = 'hidden'; 
    track.addEventListener('cuechange', this.trackChangeListener);
  }

  async onCueChange(e) {
    const track = e.target;
    if (!track.activeCues) return;
    
    // Convert all currently active cues into a single block of text
    const activeCues = Array.from(track.activeCues);
    
    if (activeCues.length > 0) {
       const text = activeCues.map(c => c.text).join(' ');
       // Only project overlay blocks for Japanese media
       if (this.containsJapanese(text)) {
           await this.renderSubtitle(text);
       }
    } else {
       this.overlay.replaceChildren();
    }
  }

  containsJapanese(text) {
     return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F]/.test(text);
  }

  // NOTE: Audio capture is now managed by content.js (rolling buffer).
  //       video.js only handles the visual subtitle overlay.

  async renderSubtitle(text) {
     const VALID_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '固有名詞', '未知語', '感動詞', '接続詞', '連体詞', '助詞', '助動詞']);

     // Bump generation so any in-flight older callback becomes a no-op
     const gen = ++this._renderGen;
     
     chrome.runtime.sendMessage({ action: 'parse:tokenize', payload: { text } }, (res) => {
        // Discard stale callback — a newer renderSubtitle call has already fired
        if (gen !== this._renderGen) return;
        if (!res || !res.success) return;
        
        this.overlay.replaceChildren();
        const fragment = document.createDocumentFragment();
        
        for (const token of res.data) {
           if (VALID_POS.has(token.pos) || VALID_POS.has(token.pos_detail)) {
              const isKnown = window.llKnownWords && window.llKnownWords.has(token.dictForm);
              
              const span = document.createElement('span');
              span.className = `ll-word ${isKnown ? 'll-known' : 'll-unknown'}`;
              span.dataset.dictform = token.dictForm;
              span.dataset.reading = token.reading;
              span.dataset.pos = token.pos;
              span.dataset.sentence = text.trim();
              span.textContent = token.surface;
              
              fragment.appendChild(span);
           } else {
              fragment.appendChild(document.createTextNode(token.surface));
           }
        }
        
        const container = document.createElement('div');
        container.className = 'll-subtitle-container';
        container.appendChild(fragment);
        this.overlay.appendChild(container);

        // Re-apply custom position if the user has dragged
        if (this.customPosition) {
          this.applyCustomPosition(container);
        }
     });
  }
}

// Global initialization & monitoring for dynamic DOMs (React/Youtube)
const videoObserver = new MutationObserver((mutations) => {
  for (const mut of mutations) {
    if (!mut.addedNodes) continue;
    
    for (const node of mut.addedNodes) {
      if (node.nodeName === 'VIDEO') {
         new SubtitleController(node);
      } else if (node.querySelectorAll) {
         node.querySelectorAll('video').forEach(v => new SubtitleController(v));
      }
    }
  }
});

// Start aggressively watching DOM layout for any video injections
videoObserver.observe(document.body, { childList: true, subtree: true });

// Attach controllers statically for videos already rendered by the page
document.querySelectorAll('video').forEach(v => new SubtitleController(v));
