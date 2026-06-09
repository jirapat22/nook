import { api, showToast, speak, AppState } from '../app.js';
import { VoiceRecorder }   from '../components/voiceRecorder.js';
import { AiPanel }         from '../components/aiPanel.js';
import { LoveLifeSection } from '../components/loveLifeSection.js';
import { MoodTracker }     from '../components/moodTracker.js';

export class EntryView {
  constructor(params = []) {
    this.params   = params;
    this.mode     = 'text';   // 'drive' | 'text'
    this.entryId  = null;
    this.analysis = null;
    this.followupRound = 0;
    this.conversationHistory = [];
    this.recorder  = null;
    this.container = null;
    this.moodOverrides = {};
    this.rawContent = '';
    // In-flow followups: { question, text } pairs captured during the analyze loop.
    // Saved as the entry's followups[] array so they remain distinct sub-blocks
    // instead of being concatenated into raw_transcript (which destroyed structure).
    this.inflowFollowups = [];
    // Inflight fetch controllers — destroy() aborts them
    this._inflightControllers = [];
    // Double-save guard — analyzeContent + transcribe can race against the
    // user mashing the Save button
    this._isSaving = false;
    // Marker so onStop callbacks know the view was torn down mid-recording
    this._destroyed = false;
    // Last recorded audio blob — preserved so transcription can be retried
    // without forcing a re-record
    this._lastAudioBlob = null;

    // BUG FIX: 'voice' should activate 'drive' mode, not a separate mode
    if (params[0] === 'voice') this.mode = 'drive';
    else if (params[0] === 'text' || !params[0]) this.mode = 'text';
    else {
      this.entryId = params[0];
      this.mode = 'text';
    }
  }

  // Draft persistence — guards against accidental nav-away losing voice
  // or text content before the user explicitly saves.
  saveDraft(content) {
    try {
      localStorage.setItem('nook_draft', JSON.stringify({
        content, mode: this.mode, savedAt: Date.now(),
      }));
    } catch {}
  }
  clearDraft() { try { localStorage.removeItem('nook_draft'); } catch {} }
  loadDraft() {
    try {
      const raw = localStorage.getItem('nook_draft');
      if (!raw) return null;
      const d = JSON.parse(raw);
      // Drafts older than 12 hours are stale — discard
      if (Date.now() - d.savedAt > 12 * 60 * 60 * 1000) {
        this.clearDraft();
        return null;
      }
      return d;
    } catch { return null; }
  }

  async mount(container) {
    this.container = container;

    if (this.entryId) {
      await this.mountDetailView(container);
      return;
    }

    const today = new Date().toISOString().split('T')[0];

    container.innerHTML = `
      <div class="entry-view">
        <div class="entry-mode-toggle" id="mode-toggle">
          <div class="mode-tab ${this.mode === 'drive' ? 'active' : ''}" data-mode="drive">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:15px;height:15px;display:inline;margin-right:4px;vertical-align:middle">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2"/>
            </svg>
            Voice
          </div>
          <div class="mode-tab ${this.mode !== 'drive' ? 'active' : ''}" data-mode="text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:15px;height:15px;display:inline;margin-right:4px;vertical-align:middle">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Text
          </div>
        </div>

        <div class="date-row">
          <input type="date" class="input" id="entry-date" value="${today}" max="${today}">
          <div class="quick-date-btns">
            <button type="button" class="quick-date-btn active" data-date-shift="0">Today</button>
            <button type="button" class="quick-date-btn" data-date-shift="-1">Yesterday</button>
          </div>
          <span id="backdated-notice" class="backdated-notice hidden">Added after the fact</span>
        </div>

        <div id="mode-content"></div>
        <div id="followup-section"></div>
        <div id="ai-panel-section"></div>
        <div id="love-section"></div>
        <div id="mood-section"></div>

        <div class="entry-action-bar" id="action-bar" style="display:none">
          <button class="btn btn-secondary" id="discard-btn">Discard</button>
          <button class="btn btn-primary" id="save-btn">Save entry</button>
        </div>
      </div>
    `;

    // Mode toggle
    container.querySelectorAll('.mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const newMode = tab.dataset.mode;
        if (newMode === this.mode) return;
        container.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.mode = newMode;
        this.renderModeContent();
        this.resetAnalysis();
      });
    });

    // Date → backdated notice
    const dateInput = container.querySelector('#entry-date');
    const syncDateBtns = () => {
      container.querySelectorAll('.quick-date-btn').forEach(b => b.classList.remove('active'));
      const shift = (new Date(today) - new Date(dateInput.value)) / 86400000;
      const match = container.querySelector(`.quick-date-btn[data-date-shift="${-shift}"]`);
      if (match) match.classList.add('active');
    };
    dateInput.addEventListener('change', e => {
      container.querySelector('#backdated-notice').classList.toggle('hidden', e.target.value >= today);
      syncDateBtns();
    });
    // Quick "Today" / "Yesterday" buttons — much faster than the date picker
    container.querySelectorAll('.quick-date-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const shift = parseInt(btn.dataset.dateShift);
        const d = new Date(today);
        d.setDate(d.getDate() + shift);
        const newDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        dateInput.value = newDate;
        container.querySelector('#backdated-notice').classList.toggle('hidden', shift === 0);
        syncDateBtns();
      });
    });

    container.querySelector('#save-btn').addEventListener('click', () => this.saveEntry());
    container.querySelector('#discard-btn').addEventListener('click', () => {
      if (confirm('Discard this entry?')) location.hash = '#home';
    });

    // Render mode content ONCE — no duplicate startVoiceMode calls
    this.renderModeContent();
  }

  renderModeContent() {
    // Destroy any existing recorder before switching modes
    if (this.recorder) {
      this.recorder.destroy();
      this.recorder = null;
    }
    this.stopWaveformAnimation();
    this.stopRecordingTimer();
    document.getElementById('inline-save-btn-wrap')?.remove();

    const mc = this.container.querySelector('#mode-content');
    if (this.mode === 'drive') {
      this.renderDriveMode(mc);
    } else {
      this.renderDesktopMode(mc);
    }
  }

  // ── Drive Mode ──────────────────────────────────────────────
  renderDriveMode(container) {
    container.innerHTML = `
      <div class="drive-mode">
        <div class="mic-container">
          <!-- Mic / start button -->
          <button class="mic-btn" id="mic-btn" aria-label="Start recording">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8"  y1="23" x2="16" y2="23"/>
            </svg>
          </button>
          <p class="mic-hint" id="mic-hint">Tap to start recording</p>

          <!-- Waveform (hidden until recording) -->
          <div class="waveform hidden" id="waveform">
            ${Array.from({length: 20}, () => '<div class="waveform-bar" style="height:8px"></div>').join('')}
          </div>
        </div>

        <!-- Recording status row -->
        <div class="recording-status hidden" id="rec-status">
          <span class="recording-dot"></span>
          <span id="rec-time">0:00</span>
        </div>

        <!-- Large STOP button — only visible while recording -->
        <button class="btn btn-danger btn-lg btn-full hidden" id="stop-btn" style="margin:16px;width:calc(100% - 32px)">
          ⏹ Stop recording
        </button>

        <div class="recorder-transcript placeholder" id="transcript-display">
          Your words will appear here after recording...
        </div>
      </div>
    `;

    this.initDriveMode();

    // If a previous session left a draft (e.g. page reloaded mid-recording),
    // offer to restore here too — was previously only handled in text mode.
    const draft = this.loadDraft();
    if (draft && draft.content && draft.content.length > 20 && !document.querySelector('.draft-restore-banner')) {
      const banner = document.createElement('div');
      banner.className = 'draft-restore-banner';
      banner.innerHTML = `
        <span>📝 Unsaved draft from ${new Date(draft.savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
        <button class="btn btn-secondary btn-sm" id="voice-draft-restore">Restore as text</button>
        <button class="btn btn-ghost btn-sm" id="voice-draft-discard">Discard</button>`;
      container.prepend(banner);
      banner.querySelector('#voice-draft-restore').addEventListener('click', () => {
        // Switch to text mode — the existing draft is still in localStorage,
        // and text mode's own restore banner will let user load it cleanly.
        banner.remove();
        const textTab = this.container.querySelector('[data-mode="text"]');
        textTab?.click();
      });
      banner.querySelector('#voice-draft-discard').addEventListener('click', () => {
        this.clearDraft();
        banner.remove();
      });
    }
  }

  initDriveMode() {
    const mc      = this.container.querySelector('#mode-content');
    const micBtn  = mc.querySelector('#mic-btn');
    const stopBtn = mc.querySelector('#stop-btn');
    const hint    = mc.querySelector('#mic-hint');
    const waveform = mc.querySelector('#waveform');
    const recStatus = mc.querySelector('#rec-status');
    const transcript = mc.querySelector('#transcript-display');

    // BUG FIX: use onclick (not addEventListener) — guarantees only one handler
    const doStop = () => {
      if (this.recorder && this.recorder.isRecording) {
        this.recorder.stop();
      }
    };

    micBtn.onclick = () => {
      // Prime TTS on this user-gesture so later speak() calls work on mobile.
      // Mobile browsers refuse to speak unless there's been a recent tap —
      // by the time the AI follow-up comes back (record → transcribe → analyze),
      // the original tap is too stale. An empty utterance unlocks the queue
      // for the rest of the session.
      this.primeTTS();

      if (!this.recorder || !this.recorder.isRecording) {
        this.recorder?.destroy();
        this.recorder = this.buildRecorder({ micBtn, stopBtn, hint, waveform, recStatus, transcript });
        this.recorder.start();
      }
      // If already recording, tap the mic does nothing — use the STOP button
    };

    stopBtn.onclick = doStop;

    // Also keep "done" keyword stopping
    // (handled inside buildRecorder via onKeyword)
  }

  // Insert a prominent "Save what I said" button right after the transcript text.
  // Belt-and-suspenders: even if the user can't find the sticky action bar on
  // mobile (some PWAs hide it behind the keyboard or scroll position), they see
  // a clear save action right where their words appear.
  injectInlineSaveButton(transcriptEl) {
    // Don't double-insert if user re-records
    document.getElementById('inline-save-btn-wrap')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'inline-save-btn-wrap';
    wrap.className = 'inline-save-wrap';
    wrap.innerHTML = `
      <button class="btn btn-primary btn-lg" id="inline-save-btn">💾 Save what I said</button>
      <button class="btn btn-ghost btn-sm" id="inline-retry-btn">🎙 Record again</button>`;
    transcriptEl.after(wrap);
    // Scroll the button into view on a tick (after DOM settles) so users on
    // mobile see it immediately even if they were scrolled up
    setTimeout(() => {
      wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    wrap.querySelector('#inline-save-btn').addEventListener('click', () => this.saveEntry());
    wrap.querySelector('#inline-retry-btn').addEventListener('click', () => {
      if (confirm('Discard this recording and try again?')) {
        wrap.remove();
        transcriptEl.textContent = 'Your words will appear here after recording...';
        transcriptEl.classList.add('placeholder');
        this.rawContent = '';
        this.clearDraft();
        this.resetAnalysis();
        // Re-trigger mic
        this.container.querySelector('#mic-btn')?.click();
      }
    });
  }

  primeTTS() {
    try {
      if (!window.speechSynthesis) return;
      // Cancel anything pending then speak a 0-length utterance to unlock TTS
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {}
  }

  // Wake Lock — keep the screen on during voice recording.
  // Browser auto-releases on tab hide; visibilitychange handler re-acquires.
  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    // Don't double-request — the spec allows it but we'd leak the previous handle
    if (this._wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => {
        this._wakeLock = null;
        // Hide the visual indicator when the lock is released for any reason
        document.getElementById('wake-lock-badge')?.remove();
      });
      // Visual confirmation so the user knows the screen will stay on
      this.showWakeLockBadge();
      // Re-acquire if user switches tabs and comes back while still recording
      if (!this._wakeLockVisHandler) {
        this._wakeLockVisHandler = () => {
          if (document.visibilityState === 'visible' && this.recorder?.isRecording) {
            this.requestWakeLock();
          }
        };
        document.addEventListener('visibilitychange', this._wakeLockVisHandler);
      }
    } catch (err) {
      console.warn('Wake lock failed:', err.message);
    }
  }

  releaseWakeLock() {
    try { this._wakeLock?.release(); } catch {}
    this._wakeLock = null;
    if (this._wakeLockVisHandler) {
      document.removeEventListener('visibilitychange', this._wakeLockVisHandler);
      this._wakeLockVisHandler = null;
    }
    document.getElementById('wake-lock-badge')?.remove();
  }

  // Transcribe → analyze. Extracted so we can re-call it from a "retry transcription"
  // button without forcing the user to re-record their audio.
  async transcribeAndAnalyze(audioBlob, { micBtn, hint, transcript }) {
    micBtn.classList.add('processing');
    transcript.innerHTML = `
      <span class="transcribe-spinner"><span></span><span></span><span></span></span>
      <span style="margin-left:8px">Transcribing your recording…</span>`;
    transcript.classList.remove('placeholder');

    // 90s timeout — long enough for Whisper on slow networks, short enough
    // that a hung request doesn't trap the user forever.
    const ctl = new AbortController();
    this._inflightControllers.push(ctl);
    const timeoutId = setTimeout(() => ctl.abort(), 90000);

    try {
      const ext  = audioBlob.type.includes('mp4') ? 'mp4' : audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
      const form = new FormData();
      form.append('audio', audioBlob, `recording.${ext}`);
      const res = await fetch('/api/ai/transcribe', { method: 'POST', body: form, signal: ctl.signal });
      clearTimeout(timeoutId);
      if (this._destroyed) return; // view torn down while transcribing
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Transcription failed (HTTP ${res.status})`);
      }
      const result = await res.json();
      if (this._destroyed) return;
      const text = result.transcript?.trim() || '';

      transcript.textContent = text || '(Nothing transcribed — try recording again)';
      if (!text) {
        hint.textContent = 'Tap to record again';
        micBtn.classList.remove('processing');
        this.injectRetryTranscribeButton(transcript, audioBlob, { micBtn, hint });
        return;
      }
      this.rawContent = text;
      this.saveDraft(text);
      this.showActionBar();
      this.injectInlineSaveButton(transcript);
      hint.textContent = '✓ Got it — adding AI insights…';
      await this.analyzeContent(text);
      this.clearDraft();
    } catch (err) {
      clearTimeout(timeoutId);
      if (this._destroyed) return;
      const aborted = err.name === 'AbortError';
      const msg = aborted ? 'Transcription took too long.' : (err.message || 'Transcription failed.');
      showToast(msg, 'error');
      // Use textContent for the message itself (XSS-safe) and innerHTML only for structure
      transcript.innerHTML = `
        <div style="color:var(--color-text);margin-bottom:6px"><strong class="js-err-msg"></strong></div>
        <div style="font-size:0.8rem;color:var(--color-text-muted);margin-bottom:10px">Your audio is still here — you can try again.</div>`;
      transcript.querySelector('.js-err-msg').textContent = msg;
      this.injectRetryTranscribeButton(transcript, audioBlob, { micBtn, hint });
    } finally {
      this._inflightControllers = this._inflightControllers.filter(c => c !== ctl);
      micBtn.classList.remove('processing');
      if (!hint.textContent.startsWith('✓')) {
        hint.textContent = 'Tap mic to record a new one';
      }
    }
  }

  injectRetryTranscribeButton(transcript, audioBlob, { micBtn, hint }) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
    wrap.innerHTML = `
      <button class="btn btn-primary btn-sm" id="retry-transcribe-btn">🔄 Try transcribing again</button>
      <button class="btn btn-ghost btn-sm" id="discard-audio-btn">Discard recording</button>`;
    transcript.appendChild(wrap);
    wrap.querySelector('#retry-transcribe-btn').addEventListener('click', () => {
      this.transcribeAndAnalyze(audioBlob, { micBtn, hint, transcript });
    });
    wrap.querySelector('#discard-audio-btn').addEventListener('click', () => {
      this._lastAudioBlob = null;
      transcript.textContent = 'Your words will appear here after recording...';
      transcript.classList.add('placeholder');
      hint.textContent = 'Tap to start recording';
    });
  }

  showWakeLockBadge() {
    if (document.getElementById('wake-lock-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'wake-lock-badge';
    badge.className = 'wake-lock-badge';
    badge.innerHTML = '🔆 Screen will stay on';
    document.body.appendChild(badge);
  }

  buildRecorder({ micBtn, stopBtn, hint, waveform, recStatus, transcript }) {
    return new VoiceRecorder({
      onStart: () => {
        micBtn.classList.add('recording');
        micBtn.setAttribute('aria-label', 'Recording in progress');
        hint.textContent = 'Listening… say "stop recording" or tap Stop';
        waveform.classList.remove('hidden');
        recStatus.classList.remove('hidden');
        stopBtn.classList.remove('hidden');
        this.startWaveformAnimation(waveform);
        this.startRecordingTimer(recStatus.querySelector('#rec-time'));
        // Keep the screen on while recording (Drive mode use case)
        this.requestWakeLock();
      },

      onStop: async (audioBlob) => {
        if (this._destroyed) return; // view navigated away mid-recording
        // Reset UI immediately
        micBtn.classList.remove('recording', 'processing');
        stopBtn.classList.add('hidden');
        waveform.classList.add('hidden');
        recStatus.classList.add('hidden');
        hint.textContent = 'Processing…';
        this.stopWaveformAnimation();
        this.stopRecordingTimer();
        // Recording done — let the screen sleep again
        this.releaseWakeLock();

        // Preserve the blob so transcription can be retried without re-recording
        this._lastAudioBlob = (audioBlob && audioBlob.size > 0) ? audioBlob : null;

        if (!audioBlob || audioBlob.size === 0) {
          hint.textContent = '⚠️ No audio captured';
          transcript.classList.remove('placeholder');
          const errMsg = this.recorder?._lastError
            || `On iPhone, check Settings > Safari > Microphone. If using the app from your home screen, grant permission in Safari first.`;
          transcript.innerHTML = `
            <div style="color:var(--color-text);margin-bottom:8px"><strong>Couldn't capture audio.</strong></div>
            <div style="font-size:0.85rem;color:var(--color-text-muted);margin-bottom:12px">${errMsg}</div>
            <button class="btn btn-primary" id="retry-record-btn">🎙 Try recording again</button>`;
          transcript.querySelector('#retry-record-btn')?.addEventListener('click', () => {
            transcript.textContent = 'Tap the mic above to start.';
            transcript.classList.add('placeholder');
            hint.textContent = 'Tap to start recording';
          });
          return;
        }

        await this.transcribeAndAnalyze(audioBlob, { micBtn, hint, transcript });
      },

      onKeyword: () => {
        if (this.recorder?.isRecording) this.recorder.stop();
      },
    });
  }

  startWaveformAnimation(waveform) {
    const bars = waveform.querySelectorAll('.waveform-bar');
    this._waveInterval = setInterval(() => {
      bars.forEach(bar => { bar.style.height = (Math.random() * 36 + 4) + 'px'; });
    }, 120);
  }
  stopWaveformAnimation() { clearInterval(this._waveInterval); }

  startRecordingTimer(el) {
    let secs = 0;
    this._timerInterval = setInterval(() => {
      secs++;
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, '0');
      if (el) el.textContent = `${m}:${s}`;
    }, 1000);
  }
  stopRecordingTimer() { clearInterval(this._timerInterval); }

  // ── Desktop Mode ────────────────────────────────────────────
  renderDesktopMode(container) {
    container.innerHTML = `
      <div class="desktop-mode">
        <div class="form-group">
          <label class="form-label">What's on your mind?</label>
          <div class="entry-textarea-wrap">
            <textarea class="textarea textarea-large" id="entry-content"
              placeholder="Write freely — Nook will help clean it up and find the themes..."
              maxlength="10000"></textarea>
            <div class="char-count"><span id="char-count">0</span> / 10,000</div>
          </div>
        </div>
        <div class="analyze-btn-wrap">
          <button class="btn btn-primary" id="analyze-btn">✨ Analyse</button>
        </div>
      </div>
    `;

    const textarea   = container.querySelector('#entry-content');
    const charCount  = container.querySelector('#char-count');
    const analyzeBtn = container.querySelector('#analyze-btn');

    // Pre-fill from "Write about this" in reflection panel
    const reflectPrompt = sessionStorage.getItem('reflect_prompt');
    if (reflectPrompt) {
      sessionStorage.removeItem('reflect_prompt');
      textarea.value = `Thinking about: ${reflectPrompt}\n\n`;
      charCount.textContent = textarea.value.length;
    } else {
      // Offer to restore draft from a previously-failed session
      const draft = this.loadDraft();
      if (draft && draft.content && draft.content.length > 20) {
        const banner = document.createElement('div');
        banner.className = 'draft-restore-banner';
        banner.innerHTML = `
          <span>📝 You have an unsaved draft from ${new Date(draft.savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.</span>
          <button class="btn btn-secondary btn-sm" id="draft-restore">Restore</button>
          <button class="btn btn-ghost btn-sm" id="draft-discard">Discard</button>`;
        container.prepend(banner);
        banner.querySelector('#draft-restore').addEventListener('click', () => {
          textarea.value = draft.content;
          charCount.textContent = textarea.value.length;
          banner.remove();
        });
        banner.querySelector('#draft-discard').addEventListener('click', () => {
          this.clearDraft();
          banner.remove();
        });
      }
    }

    // Autosave draft as user types (debounced)
    let saveTimer;
    textarea.addEventListener('input', () => {
      charCount.textContent = textarea.value.length;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (textarea.value.length > 20) this.saveDraft(textarea.value);
      }, 1000);
    });

    analyzeBtn.addEventListener('click', async () => {
      const content = textarea.value.trim();
      if (!content) { showToast('Write something first 😊', ''); return; }
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = '✨ Analysing…';
      this.rawContent = content;
      await this.analyzeContent(content);
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '✨ Analyse again';
    });
  }

  // ── Analysis ────────────────────────────────────────────────
  async analyzeContent(content) {
    const ctl = new AbortController();
    this._inflightControllers.push(ctl);
    const timeoutId = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, conversation_history: this.conversationHistory }),
        signal: ctl.signal,
      });
      clearTimeout(timeoutId);
      if (this._destroyed) return; // view torn down while we awaited
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `AI analysis HTTP ${res.status}`);
      }
      this.analysis = await res.json();
      this.renderAnalysisResults();
      this.showActionBar();

      if (this.analysis.followup_question && this.mode === 'drive') {
        speak(this.analysis.followup_question);
      }
      if (this.analysis.followup_question && this.followupRound < 3) {
        this.renderFollowup(this.analysis.followup_question);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (this._destroyed) return;
      const aborted = err.name === 'AbortError';
      showToast(aborted ? 'AI took too long — entry still saveable' : (err.message || 'AI analysis unavailable — your entry is saved.'), 'error');
      this.showActionBar();
      // Reset the hint so it doesn't keep showing "✓ Got it — adding AI insights…"
      // forever after the AI failed. Save button is right there, no need to nag.
      const driveHint = this.container.querySelector('#mic-hint');
      if (driveHint) driveHint.textContent = 'AI couldn\'t analyse — your words are still saveable below';
    } finally {
      this._inflightControllers = this._inflightControllers.filter(c => c !== ctl);
    }
  }

  renderFollowup(question) {
    const section = this.container.querySelector('#followup-section');
    section.innerHTML = `
      <div class="followup-section">
        <div class="chat-bubble">
          <span class="bubble-icon">💬</span>
          <span>${question}</span>
        </div>
        <div class="followup-input-row">
          <input type="text" class="input" id="followup-answer" placeholder="Your answer…" />
          <button class="btn btn-ghost btn-sm" id="followup-skip">Skip</button>
          <button class="btn btn-primary btn-sm" id="followup-send">Send</button>
        </div>
      </div>
    `;

    const input = section.querySelector('#followup-answer');

    const send = async () => {
      const answer = input.value.trim();
      if (!answer) return;
      this.followupRound++;
      // Track Q&A separately so it ends up in followups[] on save,
      // not concatenated into raw_transcript (which fragmented the entry)
      this.inflowFollowups.push({ question, text: answer });
      this.conversationHistory.push({ role: 'assistant', content: question });
      this.conversationHistory.push({ role: 'user', content: answer });
      section.innerHTML = '<div class="loading-spinner"></div>';
      // Pass combined context to AI for next-round analysis, but don't mutate rawContent
      const combined = this.rawContent + '\n\n' + this.inflowFollowups.map(f => `Q: ${f.question}\nA: ${f.text}`).join('\n\n');
      await this.analyzeContent(combined);
    };

    section.querySelector('#followup-send').addEventListener('click', send);
    section.querySelector('#followup-skip').addEventListener('click', () => { section.innerHTML = ''; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  renderAnalysisResults() {
    if (!this.analysis) return;
    const a = this.analysis;

    const panelSection = this.container.querySelector('#ai-panel-section');
    new AiPanel(a, this.moodOverrides, overrides => { this.moodOverrides = overrides; }).mount(panelSection);

    if (a.has_love_life_content) {
      new LoveLifeSection(a).mount(this.container.querySelector('#love-section'));
    }
    if (a.mood?.uncertain_dimensions?.length) {
      new MoodTracker(a.mood, updates => { this.moodOverrides = { ...this.moodOverrides, ...updates }; })
        .mount(this.container.querySelector('#mood-section'));
    }
  }

  resetAnalysis() {
    this.analysis = null;
    this.followupRound = 0;
    this.conversationHistory = [];
    this.inflowFollowups = [];
    ['#followup-section','#ai-panel-section','#love-section','#mood-section'].forEach(sel => {
      const el = this.container.querySelector(sel);
      if (el) el.innerHTML = '';
    });
    this.container.querySelector('#action-bar').style.display = 'none';
  }

  showActionBar() {
    this.container.querySelector('#action-bar').style.display = 'flex';
  }

  // ── Save ─────────────────────────────────────────────────────
  async saveEntry() {
    if (this._isSaving) return; // guard against double-tap on inline + action-bar Save
    this._isSaving = true;
    const saveBtn = this.container.querySelector('#save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    const inlineBtn = document.getElementById('inline-save-btn');
    if (inlineBtn) { inlineBtn.disabled = true; inlineBtn.textContent = 'Saving…'; }

    const date  = this.container.querySelector('#entry-date').value;
    const today = new Date().toISOString().split('T')[0];

    let rawContent = this.rawContent || '';
    if (this.mode === 'text') {
      rawContent = this.container.querySelector('#entry-content')?.value?.trim() || rawContent;
    }

    if (!rawContent && !this.analysis) {
      showToast('Nothing to save — write something first!', '');
      this._isSaving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save entry'; }
      if (inlineBtn) { inlineBtn.disabled = false; inlineBtn.textContent = '💾 Save what I said'; }
      return;
    }

    const a    = this.analysis || {};
    const mood = { ...a.mood, ...this.moodOverrides };

    const payload = {
      date,
      time_of_day: getTimeOfDay(),
      is_backdated: date < today,
      raw_transcript: rawContent,
      cleaned_content: a.cleaned_content || rawContent,
      ai_summary: a.ai_summary || null,
      first_person_summary: a.first_person_summary || null,
      key_themes: a.key_themes || [],
      action_items: a.action_items || [],
      important_today: a.important_today || null,
      mood_energy:        mood.energy        ?? null,
      mood_happiness:     mood.happiness     ?? null,
      mood_anxiety:       mood.anxiety       ?? null,
      mood_confidence:    mood.confidence    ?? null,
      mood_motivation:    mood.motivation    ?? null,
      mood_social_battery:mood.social_battery?? null,
      mood_physical:      mood.physical      ?? null,
      mood_focus:         mood.focus         ?? null,
      mood_overall:       mood.overall       ?? null,
      mood_source: this.analysis ? 'ai_detected' : null,
      life_areas: a.life_areas || [],
      tags: a.suggested_tags || [],
      entry_mode: this.mode === 'drive' ? 'voice' : 'text',
      has_love_life_content: a.has_love_life_content || false,
      love_life_raw: a.love_life_content || null,
      love_life_cleaned: a.love_life_content || null,
      love_life_emotion_intensity: a.love_life_emotion_intensity ?? null,
    };

    try {
      const saved = await api.post('/api/entries', payload);
      this._isSaving = false;
      this.clearDraft();
      // Persist any in-flow follow-up Q&As as proper sub-blocks
      for (const fu of this.inflowFollowups) {
        try {
          await api.post(`/api/entries/${saved.id}/followup`, { text: fu.text, question: fu.question });
        } catch { /* non-fatal — main entry already saved */ }
      }
      showToast('Entry saved. Your nook remembers. 🌿', 'success');
      if (a.people_mentioned?.length) await this.linkPeopleMentions(saved.id, a.people_mentioned);
      setTimeout(() => { location.hash = '#home'; }, 1200);
    } catch (err) {
      showToast('Could not save — please try again', 'error');
      this._isSaving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save entry'; }
      if (inlineBtn) { inlineBtn.disabled = false; inlineBtn.textContent = '💾 Save what I said'; }
    }
  }

  async linkPeopleMentions(entryId, mentioned) {
    try {
      const existing = await api.get('/api/people');
      const newPeople = [];
      const ambiguous = [];
      const fuzzy     = [];
      const autoLinked = []; // { person, chosen, candidates } for post-save undo toast

      for (const person of mentioned) {
        const nameLC = person.name.toLowerCase();

        // 1. Exact match — primary name OR any alias
        const exactMatches = existing.filter(p => {
          if (p.name.toLowerCase() === nameLC) return true;
          const aliases = Array.isArray(p.aliases) ? p.aliases : [];
          return aliases.some(a => a.toLowerCase() === nameLC);
        });

        if (exactMatches.length === 1) {
          await api.post('/api/people/link-mention', {
            person_id: exactMatches[0].id, entry_id: entryId,
            context: person.context, sentiment_score: person.sentiment,
            facts_extracted: person.facts_extracted || [], emotion_toward: person.emotion_toward,
            link_method: 'exact',
          }).catch(() => {});
        } else if (exactMatches.length > 1) {
          // Same name — try context scoring before falling back to a modal
          const scored = exactMatches.map(p => ({ p, s: scoreCandidate(p, person, this.rawContent || '') }))
            .sort((a, b) => b.s - a.s);
          const top = scored[0], runnerUp = scored[1];
          // Decisive: top is 2× runner-up AND scored at least 10
          const decisive = top.s >= 10 && top.s >= runnerUp.s * 2;
          if (decisive) {
            const link = await api.post('/api/people/link-mention', {
              person_id: top.p.id, entry_id: entryId,
              context: person.context, sentiment_score: person.sentiment,
              facts_extracted: person.facts_extracted || [], emotion_toward: person.emotion_toward,
              link_method: 'auto_scored',
            }).catch(() => null);
            if (link) autoLinked.push({ mention: person, chosen: top.p, candidates: exactMatches, mentionId: link.id });
          } else {
            ambiguous.push({ person, matches: exactMatches });
          }
        } else {
          // 2. Fuzzy match — catch nicknames like "Raph" → "Rafaella", "Mike" → "Michael"
          const fuzzyMatches = existing.filter(p => {
            const allNames = [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])].map(n => n.toLowerCase());
            return allNames.some(n => nameSimilar(nameLC, n));
          });
          if (fuzzyMatches.length > 0) {
            fuzzy.push({ person, matches: fuzzyMatches });
          } else {
            newPeople.push(person);
          }
        }
      }

      // Handle exact-same-name ambiguity (when scoring wasn't decisive)
      for (const { person, matches } of ambiguous) {
        await this.showAmbiguousPrompt(person, matches, entryId);
      }
      // Handle fuzzy "Did you mean?" — one at a time
      for (const { person, matches } of fuzzy) {
        const chosen = await this.showDidYouMeanPrompt(person, matches, entryId);
        if (chosen === 'new') newPeople.push(person);
      }
      // Show undo toast for auto-scored picks first (non-blocking), then block on
      // the add-new-people flow so the caller's redirect waits for it to finish.
      if (autoLinked.length) this.showAutoLinkUndoToast(autoLinked, entryId);
      if (newPeople.length) await this.showPeoplePrompt(newPeople, entryId);
    } catch (err) { console.warn('People linking error:', err); }
  }

  showAutoLinkUndoToast(autoLinked, entryId) {
    document.querySelector('.auto-link-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'auto-link-toast';
    const lines = autoLinked.map(a =>
      `<div class="auto-link-line">Linked <strong>${a.mention.name}</strong> as <strong>${a.chosen.name}</strong>${a.chosen.relationship_type ? ` (${a.chosen.relationship_type})` : ''} <button class="auto-link-change" data-idx="${autoLinked.indexOf(a)}">Wrong person?</button></div>`
    ).join('');
    toast.innerHTML = `
      <div class="auto-link-body">
        ${lines}
        <button class="auto-link-dismiss" aria-label="Dismiss">×</button>
      </div>`;
    document.body.appendChild(toast);

    toast.querySelector('.auto-link-dismiss').addEventListener('click', () => toast.remove());
    toast.querySelectorAll('.auto-link-change').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.idx);
        const item = autoLinked[idx];
        toast.remove();
        await this.showRepickPersonModal(item.mention, item.candidates, item.mentionId, entryId);
      });
    });
    setTimeout(() => toast.remove(), 15000);
  }

  // Modal to repick which person a mention is linked to
  showRepickPersonModal(mention, candidates, mentionId, entryId) {
    return new Promise(resolve => {
      document.querySelector('.modal-backdrop')?.remove();
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-title">Which ${mention.name}?</div>
          <p style="font-size:0.875rem;color:var(--color-text-muted);margin-bottom:16px">
            "${mention.context || mention.name}" — pick the right person.
          </p>
          ${candidates.map(m => `
            <button class="btn btn-secondary" data-id="${m.id}"
              style="width:100%;margin-bottom:8px;text-align:left;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div><strong>${m.name}</strong></div>
                ${m.relationship_type ? `<div style="font-size:0.75rem;color:var(--color-text-faint)">${m.relationship_type}${m.mention_count ? ` · ${m.mention_count} mentions` : ''}</div>` : ''}
              </div>
            </button>`).join('')}
          <button class="btn btn-ghost btn-sm" id="repick-cancel" style="width:100%;margin-top:4px">Cancel</button>
        </div>`;
      document.body.appendChild(modal);

      const cleanup = () => { modal.remove(); resolve(); };
      modal.querySelector('#repick-cancel').addEventListener('click', cleanup);
      modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });

      candidates.forEach(m => {
        modal.querySelector(`[data-id="${m.id}"]`).addEventListener('click', async () => {
          modal.remove();
          try {
            await api.put(`/api/people/mention/${mentionId}`, { person_id: m.id, link_method: 'manual' });
            showToast(`Updated — now linked to ${m.name}`, 'success');
          } catch {
            showToast('Could not update link', 'error');
          }
          resolve();
        });
      });
    });
  }

  showDidYouMeanPrompt(person, candidates, entryId) {
    return new Promise(resolve => {
      document.querySelector('.modal-backdrop')?.remove();
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-title">Did you mean…?</div>
          <p style="font-size:0.875rem;color:var(--color-text-muted);margin-bottom:16px">
            You mentioned <strong>${person.name}</strong> — is this one of these people?
          </p>
          ${candidates.map(m => `
            <button class="btn btn-secondary" data-id="${m.id}"
              style="width:100%;margin-bottom:8px;text-align:left;display:flex;justify-content:space-between;align-items:center">
              <strong>${m.name}</strong>
              ${m.relationship_type ? `<span style="color:var(--color-text-faint);font-size:0.8rem">${m.relationship_type}</span>` : ''}
            </button>`).join('')}
          <button class="btn btn-ghost btn-sm" id="dym-new" style="width:100%;margin-top:4px">
            No — "${person.name}" is someone new
          </button>
        </div>`;
      document.body.appendChild(modal);

      modal.querySelector('#dym-new').addEventListener('click', () => { modal.remove(); resolve('new'); });
      // Dismissing without choosing must NOT lose the person — fall through to the
      // "add as new" flow (they can still tap "Not now" there) instead of dropping.
      modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); resolve('new'); } });

      candidates.forEach(m => {
        modal.querySelector(`[data-id="${m.id}"]`).addEventListener('click', async () => {
          modal.remove();
          await api.post('/api/people/link-mention', {
            person_id: m.id, entry_id: entryId,
            context: person.context, sentiment_score: person.sentiment,
            facts_extracted: person.facts_extracted || [], emotion_toward: person.emotion_toward,
            link_method: 'fuzzy_confirmed',
          }).catch(() => {});
          resolve('linked');
        });
      });
    });
  }

  showAmbiguousPrompt(person, matches, entryId) {
    return new Promise(resolve => {
      document.querySelector('.modal-backdrop')?.remove();
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-title">Which ${person.name}?</div>
          <p style="font-size:0.875rem;color:var(--color-text-muted);margin-bottom:16px">
            "${person.context || person.name}" — which person did you mean?
          </p>
          ${matches.map(m => `
            <button class="btn btn-secondary" data-id="${m.id}"
              style="width:100%;margin-bottom:8px;text-align:left;padding:12px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <strong>${m.name}</strong>
                ${m.relationship_type ? `<span style="color:var(--color-text-faint);font-size:0.75rem">${m.relationship_type}</span>` : ''}
              </div>
              ${m.mention_count ? `<div style="font-size:0.7rem;color:var(--color-text-faint)">${m.mention_count} mention${m.mention_count !== 1 ? 's' : ''}${m.last_mentioned ? ' · last ' + new Date(m.last_mentioned).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</div>` : ''}
              ${m.notes ? `<div style="font-size:0.7rem;color:var(--color-text-muted);margin-top:2px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.notes}</div>` : ''}
            </button>`).join('')}
          <button class="btn btn-ghost btn-sm" id="ambig-skip" style="width:100%;margin-top:4px">Skip</button>
        </div>`;
      document.body.appendChild(modal);

      const cleanup = () => { modal.remove(); resolve(); };
      modal.querySelector('#ambig-skip').addEventListener('click', cleanup);
      modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });

      matches.forEach(m => {
        modal.querySelector(`[data-id="${m.id}"]`).addEventListener('click', async () => {
          modal.remove();
          await api.post('/api/people/link-mention', {
            person_id: m.id, entry_id: entryId,
            context: person.context, sentiment_score: person.sentiment,
            facts_extracted: person.facts_extracted || [], emotion_toward: person.emotion_toward,
            link_method: 'manual',
          }).catch(() => {});
          resolve();
        });
      });
    });
  }

  showPeoplePrompt(people, entryId) {
    // Returns a Promise that resolves only once the user has finished deciding
    // (added everyone, or tapped Not now). saveEntry awaits this before its
    // redirect-home timer, so the navigation can't interrupt the add flow.
    return new Promise(resolve => {
      document.querySelector('.people-prompt')?.remove();
      const names  = people.map(p => escHtml(p.name)).join(', ');
      const prompt = document.createElement('div');
      prompt.className = 'people-prompt';
      prompt.innerHTML = `
        <p>You mentioned <strong>${names}</strong> — add to your People?</p>
        <div class="people-prompt-actions">
          <button class="btn btn-primary btn-sm" id="pp-yes">Add</button>
          <button class="btn btn-ghost btn-sm" id="pp-no">Not now</button>
        </div>`;
      document.body.appendChild(prompt);
      prompt.querySelector('#pp-yes').addEventListener('click', async () => {
        prompt.remove();
        // Show a single modal per person, prefilled with AI's inferred relationship
        // so the user just confirms or tweaks (instead of silently creating as 'unknown')
        for (const p of people) {
          await this.showAddPersonConfirm(p, entryId);
        }
        resolve();
      });
      prompt.querySelector('#pp-no').addEventListener('click', () => { prompt.remove(); resolve(); });
      // No auto-dismiss — the prompt stays until the user explicitly taps Add or
      // Not now, so it can't silently vanish before they notice it (mobile).
    });
  }

  showAddPersonConfirm(person, entryId) {
    return new Promise(resolve => {
      const validRels = ['friend','family','crush','partner','colleague','pet','group','acquaintance','unknown'];
      const inferred = validRels.includes(person.inferred_relationship) ? person.inferred_relationship : 'unknown';
      // When the AI couldn't tell if this is even a person (vs a thing/place),
      // lead with the question and let the user dismiss it as "not a person".
      const uncertain = person.uncertain === true;
      const safeName = escHtml(person.name);
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-title">${uncertain ? `Is "${safeName}" a person?` : `Add ${safeName}?`}</div>
          ${uncertain ? `<p style="font-size:0.85rem;color:var(--color-text-muted);margin-bottom:12px">I wasn't sure if this is someone you know or just something you mentioned.</p>` : ''}
          ${person.context ? `<p style="font-size:0.85rem;color:var(--color-text-muted);margin-bottom:12px;font-style:italic">"${escHtml(person.context)}"</p>` : ''}
          <div class="form-group">
            <label class="form-label">Relationship ${inferred !== 'unknown' ? `<span style="font-size:0.7rem;color:var(--color-primary);font-weight:600">· AI guessed: ${inferred}</span>` : ''}</label>
            <select class="select input" id="confirm-rel">
              ${validRels.map(t => `<option value="${t}" ${t === inferred ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Notes (optional)</label>
            <textarea class="textarea" id="confirm-notes" placeholder="${person.facts_extracted?.join(', ') || 'Anything you want to remember...'}" style="min-height:60px"></textarea>
          </div>
          <div class="modal-actions">
            <button class="btn btn-ghost btn-sm" id="confirm-skip">${uncertain ? 'Not a person' : 'Skip'}</button>
            <button class="btn btn-primary" id="confirm-add">${uncertain ? `Yes, add ${safeName}` : `Add ${safeName}`}</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      const cleanup = () => { modal.remove(); resolve(); };
      modal.querySelector('#confirm-skip').addEventListener('click', cleanup);
      modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });
      modal.querySelector('#confirm-add').addEventListener('click', async () => {
        const rel = modal.querySelector('#confirm-rel').value;
        const notes = modal.querySelector('#confirm-notes').value.trim();
        modal.remove();
        try {
          const created = await api.post('/api/people', {
            name: person.name,
            relationship_type: rel,
            notes,
          });
          await api.post('/api/people/link-mention', {
            person_id: created.id, entry_id: entryId,
            context: person.context, sentiment_score: person.sentiment,
            facts_extracted: person.facts_extracted || [], emotion_toward: person.emotion_toward,
            link_method: 'new_person',
          });
          showToast(`Added ${person.name} ✓`, 'success');
        } catch {
          showToast(`Couldn't add ${person.name}`, 'error');
        }
        resolve();
      });
    });
  }

  // ── Detail view ──────────────────────────────────────────────
  async mountDetailView(container) {
    try {
      const entry   = await api.get(`/api/entries/${this.entryId}`);
      // Fetch all entries for this date for prev/next navigation
      const dateStr = String(entry.date).split('T')[0];
      let sameDay = [];
      try {
        sameDay = await api.get(`/api/entries?date=${dateStr}&limit=20`);
        // Sort latest-first to match Day view ordering
        sameDay.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      } catch { sameDay = [entry]; }
      const idx = sameDay.findIndex(e => e.id === entry.id);
      const prev = idx > 0 ? sameDay[idx - 1] : null;
      const next = idx < sameDay.length - 1 ? sameDay[idx + 1] : null;
      const userEdit = entry.user_edited_content || '';
      const cleaned  = entry.cleaned_content || '';
      const raw      = entry.raw_transcript || '';
      const firstPerson = entry.first_person_summary || '';
      // Main visible content = user edit (if any) > first-person summary > cleaned > raw
      const mainContent = userEdit || firstPerson || cleaned || raw || '';
      const themes  = Array.isArray(entry.key_themes) ? entry.key_themes : [];
      const tags    = Array.isArray(entry.tags)        ? entry.tags        : [];
      const lifeAreas = Array.isArray(entry.life_areas) ? entry.life_areas : [];
      const followups = Array.isArray(entry.followups) ? entry.followups : [];
      const moodClass = entry.mood_overall == null ? 'none' : entry.mood_overall >= 7 ? 'high' : entry.mood_overall >= 4 ? 'mid' : 'low';

      const createdTime = entry.created_at
        ? new Date(entry.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : null;

      container.innerHTML = `
        <div class="entry-detail">
          <div class="entry-detail-nav">
            <a class="back-btn" href="#day/${dateStr}">← ${formatDayShort(dateStr)}</a>
            ${sameDay.length > 1 ? `
              <div class="entry-detail-arrows">
                <span class="entry-nav-count">${idx + 1} / ${sameDay.length}</span>
                <button class="entry-nav-arrow" id="entry-prev-btn" ${!prev ? 'disabled' : ''} title="Earlier entry">‹</button>
                <button class="entry-nav-arrow" id="entry-next-btn" ${!next ? 'disabled' : ''} title="Later entry">›</button>
              </div>` : ''}
          </div>
          <div class="entry-detail-meta">
            <span>${formatDate(entry.date)}</span>
            ${createdTime ? `<span>· ${createdTime}</span>` : entry.time_of_day ? `<span>· ${entry.time_of_day}</span>` : ''}
            ${entry.mood_overall != null ? `<span class="mood-dot ${moodClass}"></span><span>${entry.mood_overall}/10</span>` : ''}
            <button class="meta-edit-btn" id="edit-mood-btn" title="Edit mood">${entry.mood_overall != null ? '✏️' : '+ mood'}</button>
            ${entry.is_backdated ? '<span class="backdated-label">Added after the fact</span>' : ''}
          </div>

          ${entry.ai_summary && !firstPerson && !userEdit ? `<div class="card mb-12"><p class="font-display text-muted" style="font-style:italic">${entry.ai_summary}</p></div>` : ''}

          <!-- Main first-person diary block -->
          ${firstPerson || userEdit ? `<div class="ai-section-label">Today, in your words</div>` : ''}
          <div class="entry-content-block" id="entry-content-display">${mainContent}</div>

          <!-- Edit mode for main content (hidden by default) -->
          <textarea class="textarea hidden" id="entry-content-edit" style="min-height:200px;margin-bottom:12px"></textarea>

          ${(cleaned && cleaned !== mainContent) || (raw && raw !== mainContent) ? `
            <details class="entry-source-toggle">
              <summary>Show what I said (original)</summary>
              ${cleaned && cleaned !== mainContent ? `
                <div class="ai-section-label" style="margin-top:8px">Cleaned-up version</div>
                <p class="entry-source-text">${cleaned}</p>` : ''}
              ${raw && raw !== mainContent && raw !== cleaned ? `
                <div class="ai-section-label" style="margin-top:8px">Original recording</div>
                <p class="entry-source-text text-muted" style="font-style:italic">${raw}</p>` : ''}
            </details>` : ''}

          ${followups.length ? `
            <div class="followups-section">
              <div class="ai-section-label" style="margin-bottom:8px">Follow-ups today</div>
              ${followups.map(f => `
                <div class="followup-block">
                  ${f.question ? `<div class="followup-question">💭 ${f.question}</div>` : ''}
                  <div class="followup-text">${f.text}</div>
                  <div class="followup-time">${f.time_of_day || ''}${f.created_at ? ' · ' + new Date(f.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</div>
                </div>`).join('')}
            </div>` : ''}

          <!-- AI-analysis section (themes, tags, life areas) — editable -->
          <div id="ai-fields-display">
            ${themes.length ? `<div class="mb-12"><div class="ai-section-label">Themes</div><div class="tags-row">${themes.map(t=>`<span class="chip chip-primary">${t}</span>`).join('')}</div></div>` : ''}
            ${tags.length   ? `<div class="mb-12"><div class="ai-section-label">Tags</div><div class="tags-row">${tags.map(t=>`<span class="chip">${t}</span>`).join('')}</div></div>` : ''}
            ${lifeAreas.length ? `<div class="mb-12"><div class="ai-section-label">Life areas</div><div class="tags-row">${lifeAreas.map(t=>`<span class="chip">${t}</span>`).join('')}</div></div>` : ''}
            ${themes.length || tags.length || lifeAreas.length ? `<button class="btn btn-ghost btn-sm" id="edit-ai-fields">✏️ Edit themes / tags / areas</button>` : ''}
          </div>

          <!-- Edit AI fields form (hidden) -->
          <div id="ai-fields-edit" class="hidden">
            <div class="form-group">
              <label class="form-label">Themes (comma-separated)</label>
              <input type="text" class="input" id="edit-themes" value="${themes.join(', ')}">
            </div>
            <div class="form-group">
              <label class="form-label">Tags (comma-separated)</label>
              <input type="text" class="input" id="edit-tags" value="${tags.join(', ')}">
            </div>
            <div class="form-group">
              <label class="form-label">Life areas (comma-separated)</label>
              <input type="text" class="input" id="edit-life-areas" value="${lifeAreas.join(', ')}">
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-secondary btn-sm" id="cancel-ai-edit">Cancel</button>
              <button class="btn btn-primary btn-sm" id="save-ai-edit">Save</button>
            </div>
          </div>

          ${entry.action_items?.length ? `<div class="mb-12"><div class="ai-section-label">Action items</div><div class="action-items-list">${entry.action_items.map(i => {
            const text = typeof i === 'string' ? i : (i.text || '');
            const st = entry.action_items_state && entry.action_items_state[text];
            const done = st === 'done' || st === true;
            const esc = text.replace(/"/g, '&quot;');
            return `<label class="action-item${done ? ' done' : ''}"><input type="checkbox" data-text="${esc}" ${done ? 'checked' : ''}><span>${text}</span></label>`;
          }).join('')}</div></div>` : ''}

          <!-- People linked to this entry -->
          ${entry.people_mentions?.length ? `
          <div class="mb-12">
            <div class="ai-section-label">People in this entry</div>
            <div class="entry-people-list">
              ${entry.people_mentions.map(m => `
                <a href="#person/${m.person_id}" class="entry-person-chip">
                  <span class="entry-person-name">${escHtml(m.name)}</span>
                  ${m.relationship_type ? `<span class="entry-person-rel">${escHtml(m.relationship_type)}</span>` : ''}
                </a>`).join('')}
            </div>
          </div>` : ''}

          <div class="entry-detail-actions" id="entry-actions">
            <button class="btn btn-secondary btn-sm" id="edit-btn">Edit</button>
            <button class="btn btn-secondary btn-sm" id="reanalyse-btn">${firstPerson || entry.ai_summary ? '✨ Re-analyse' : '✨ Generate summary'}</button>
            <button class="btn btn-secondary btn-sm" id="link-person-btn">👤 Link person</button>
            <button class="btn btn-danger btn-sm" id="delete-btn">Delete</button>
          </div>
        </div>`;

      // Prev / next arrow nav between same-day entries
      container.querySelector('#entry-prev-btn')?.addEventListener('click', () => {
        if (prev) location.hash = `#new-entry/${prev.id}`;
      });
      container.querySelector('#entry-next-btn')?.addEventListener('click', () => {
        if (next) location.hash = `#new-entry/${next.id}`;
      });

      // Edit mood — opens a modal with sliders for each dimension
      container.querySelector('#edit-mood-btn')?.addEventListener('click', () => {
        this.showMoodEditModal(entry, container);
      });

      // Retroactive "Link person" — for when AI missed someone or the prompt
      // was dismissed before the user could tap Add.
      container.querySelector('#link-person-btn')?.addEventListener('click', () => {
        this.showLinkPersonModal(this.entryId, container);
      });

      // Edit AI fields (themes/tags/life areas)
      container.querySelector('#edit-ai-fields')?.addEventListener('click', () => {
        container.querySelector('#ai-fields-display').classList.add('hidden');
        container.querySelector('#ai-fields-edit').classList.remove('hidden');
      });
      container.querySelector('#cancel-ai-edit')?.addEventListener('click', () => {
        container.querySelector('#ai-fields-display').classList.remove('hidden');
        container.querySelector('#ai-fields-edit').classList.add('hidden');
      });
      container.querySelector('#save-ai-edit')?.addEventListener('click', async () => {
        const parseList = id => container.querySelector(id).value.split(',').map(s => s.trim()).filter(Boolean);
        try {
          await api.put(`/api/entries/${this.entryId}`, {
            key_themes: parseList('#edit-themes'),
            tags: parseList('#edit-tags'),
            life_areas: parseList('#edit-life-areas'),
          });
          showToast('Updated ✓', 'success');
          await this.mountDetailView(container);
        } catch {
          showToast('Could not save — try again', 'error');
        }
      });

      // Wire up action item checkboxes to persist their state
      container.querySelectorAll('.action-item input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const text = cb.dataset.text;
          const done = cb.checked;
          cb.closest('.action-item').classList.toggle('done', done);
          try {
            await api.put(`/api/entries/${this.entryId}/action-item`, { text, state: done ? 'done' : 'pending' });
          } catch {
            // Revert UI if save failed
            cb.checked = !done;
            cb.closest('.action-item').classList.toggle('done', !done);
            showToast('Could not save — try again', 'error');
          }
        });
      });

      // Load reflection questions asynchronously (non-blocking)
      this.loadReflectionQuestions(container);

      container.querySelector('#delete-btn').addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        await api.delete(`/api/entries/${this.entryId}`);
        showToast('Entry deleted', '');
        location.hash = '#home';
      });

      // ── Re-analyse ──────────────────────────────────────────
      // Regenerate AI summary/themes/tags for an entry whose analysis failed
      // on save (transcription succeeded but the AI step errored), or to refresh
      // it after editing the text. Mood is only filled when the entry has none,
      // so a mood you set yourself is never overwritten.
      const reanalyseBtn = container.querySelector('#reanalyse-btn');
      reanalyseBtn?.addEventListener('click', async () => {
        const content = (entry.user_edited_content || entry.cleaned_content || entry.raw_transcript || '').trim();
        if (!content) { showToast('Nothing to analyse yet', ''); return; }
        reanalyseBtn.disabled = true;
        reanalyseBtn.textContent = '✨ Analysing…';
        try {
          const a = await api.post('/api/ai/analyze', { content });
          const payload = {
            ai_summary: a.ai_summary || null,
            first_person_summary: a.first_person_summary || null,
            key_themes: a.key_themes || [],
            action_items: a.action_items || [],
            important_today: a.important_today || null,
            life_areas: a.life_areas || [],
            tags: a.suggested_tags || [],
          };
          // Only fill mood when the entry has none — don't clobber a manual rating.
          if (entry.mood_overall == null && a.mood) {
            const m = a.mood;
            Object.assign(payload, {
              mood_energy: m.energy ?? null, mood_happiness: m.happiness ?? null,
              mood_anxiety: m.anxiety ?? null, mood_confidence: m.confidence ?? null,
              mood_motivation: m.motivation ?? null, mood_social_battery: m.social_battery ?? null,
              mood_physical: m.physical ?? null, mood_focus: m.focus ?? null,
              mood_overall: m.overall ?? null, mood_source: 'ai_detected',
            });
          }
          await api.put(`/api/entries/${this.entryId}`, payload);
          if (a.people_mentioned?.length) {
            await this.linkPeopleMentions(this.entryId, a.people_mentioned);
          }
          showToast('Re-analysed ✓', 'success');
          await this.mountDetailView(container);
        } catch (err) {
          showToast(err.message || 'AI analysis unavailable — try again', 'error');
          reanalyseBtn.disabled = false;
          reanalyseBtn.textContent = firstPerson || entry.ai_summary ? '✨ Re-analyse' : '✨ Generate summary';
        }
      });

      // ── Edit button ─────────────────────────────────────────
      const editBtn       = container.querySelector('#edit-btn');
      const displayEl     = container.querySelector('#entry-content-display');
      const editEl        = container.querySelector('#entry-content-edit');
      const actionsDiv    = container.querySelector('#entry-actions');

      editBtn.addEventListener('click', () => {
        // Switch to edit mode
        editEl.value = displayEl.textContent;
        displayEl.classList.add('hidden');
        editEl.classList.remove('hidden');
        editEl.focus();

        actionsDiv.innerHTML = `
          <button class="btn btn-secondary btn-sm" id="cancel-edit-btn">Cancel</button>
          <button class="btn btn-primary btn-sm" id="save-edit-btn">Save changes</button>
        `;

        actionsDiv.querySelector('#cancel-edit-btn').addEventListener('click', () => {
          // Back to view mode — just re-render
          this.mountDetailView(container);
        });

        actionsDiv.querySelector('#save-edit-btn').addEventListener('click', async () => {
          const newContent = editEl.value.trim();
          if (!newContent) { showToast('Content cannot be empty', 'error'); return; }
          const saveBtn = actionsDiv.querySelector('#save-edit-btn');
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          try {
            await api.put(`/api/entries/${this.entryId}`, { user_edited_content: newContent });
            showToast('Entry updated ✓', 'success');
            await this.mountDetailView(container);
          } catch {
            showToast('Could not save — please try again', 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save changes';
          }
        });
      });

    } catch {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">😕</div><h3>Entry not found</h3><a href="#home" class="btn btn-primary btn-sm mt-12">Go home</a></div>`;
    }
  }

  // Modal to retroactively link a person to this entry.
  // Two paths: pick an existing person, or create + link a new one.
  async showLinkPersonModal(entryId, parentContainer) {
    let allPeople = [];
    try { allPeople = await api.get('/api/people'); } catch {}

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Link a person to this entry</div>

        <div class="form-group">
          <label class="form-label">Pick an existing person</label>
          <select class="select input" id="link-person-select">
            <option value="">— Choose —</option>
            ${allPeople.map(p => `<option value="${p.id}">${escHtml(p.name)}${p.relationship_type ? ' · ' + escHtml(p.relationship_type) : ''}</option>`).join('')}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">How were they mentioned? (optional)</label>
          <input type="text" class="input" id="link-person-context" placeholder="e.g. had lunch with Honda">
        </div>

        <details style="margin-bottom:12px">
          <summary style="font-size:0.85rem;color:var(--color-text-muted);cursor:pointer">+ Create & link a new person</summary>
          <div class="form-group" style="margin-top:10px">
            <input type="text" class="input" id="link-new-name" placeholder="Name" style="margin-bottom:6px">
            <select class="select input" id="link-new-rel">
              ${['friend','family','crush','partner','colleague','pet','group','acquaintance','unknown'].map(t =>
                `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
            </select>
          </div>
        </details>

        <div class="modal-actions">
          <button class="btn btn-secondary" id="link-cancel">Cancel</button>
          <button class="btn btn-primary" id="link-save">Link</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const cleanup = () => modal.remove();
    modal.querySelector('#link-cancel').addEventListener('click', cleanup);
    modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });

    modal.querySelector('#link-save').addEventListener('click', async () => {
      const existingId = modal.querySelector('#link-person-select').value;
      const context    = modal.querySelector('#link-person-context').value.trim();
      const newName    = modal.querySelector('#link-new-name').value.trim();
      const newRel     = modal.querySelector('#link-new-rel').value;

      let personId = existingId;
      let personName = allPeople.find(p => p.id === existingId)?.name || '';

      // Create new person if no existing one picked and a name was typed
      if (!personId && newName) {
        try {
          const created = await api.post('/api/people', { name: newName, relationship_type: newRel });
          personId   = created.id;
          personName = created.name;
        } catch {
          showToast('Could not create person', 'error');
          return;
        }
      }

      if (!personId) { showToast('Pick or create a person first', ''); return; }

      const saveBtn = modal.querySelector('#link-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Linking…';

      try {
        await api.post('/api/people/link-mention', {
          person_id: personId,
          entry_id: entryId,
          context: context || null,
          sentiment_score: null,
          facts_extracted: [],
          emotion_toward: null,
          link_method: 'manual',
        });
        modal.remove();
        showToast(`Linked ${personName} to this entry ✓`, 'success');
        // Re-render the detail view so the People section updates
        await this.mountDetailView(parentContainer);
      } catch {
        showToast('Could not link — try again', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Link';
      }
    });
  }

  // Modal to edit mood values on a saved entry. Marks mood_source as
  // 'user_edited' so insights know these are confirmed, not AI guesses.
  showMoodEditModal(entry, parentContainer) {
    const dims = [
      { key: 'mood_overall',        label: 'Overall' },
      { key: 'mood_energy',         label: 'Energy' },
      { key: 'mood_happiness',      label: 'Happiness' },
      { key: 'mood_anxiety',        label: 'Anxiety' },
      { key: 'mood_confidence',     label: 'Confidence' },
      { key: 'mood_motivation',     label: 'Motivation' },
      { key: 'mood_social_battery', label: 'Social' },
      { key: 'mood_physical',       label: 'Physical' },
      { key: 'mood_focus',          label: 'Focus' },
    ];
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet" style="max-height:85vh;overflow-y:auto">
        <div class="modal-handle"></div>
        <div class="modal-title">Edit mood</div>
        <p style="font-size:0.8rem;color:var(--color-text-muted);margin-bottom:12px">
          Set a value, or tap × to leave it blank.
        </p>
        ${dims.map(d => {
          const val = entry[d.key];
          const hasVal = val != null;
          return `
            <div class="mood-edit-row" data-dim="${d.key}">
              <div class="mood-edit-header">
                <span class="mood-edit-label">${d.label}</span>
                <span class="mood-edit-val ${hasVal ? '' : 'muted'}" id="mood-edit-val-${d.key}">${hasVal ? val + '/10' : '—'}</span>
                <button class="mood-edit-clear" data-dim="${d.key}" title="Clear">×</button>
              </div>
              <input type="range" class="range-slider mood-edit-slider"
                min="0" max="10" step="1"
                value="${hasVal ? val : 5}"
                data-dim="${d.key}"
                data-touched="${hasVal ? 'true' : 'false'}">
            </div>`;
        }).join('')}
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn btn-secondary" id="mood-edit-cancel">Cancel</button>
          <button class="btn btn-primary" id="mood-edit-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    // Slider input updates the displayed value and marks touched
    modal.querySelectorAll('.mood-edit-slider').forEach(s => {
      s.addEventListener('input', e => {
        const v = parseInt(e.target.value);
        const dim = s.dataset.dim;
        const valEl = modal.querySelector(`#mood-edit-val-${dim}`);
        if (valEl) { valEl.textContent = v + '/10'; valEl.classList.remove('muted'); }
        s.dataset.touched = 'true';
      });
    });

    // × clear button restores the muted "—" state
    modal.querySelectorAll('.mood-edit-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        const dim = btn.dataset.dim;
        const slider = modal.querySelector(`.mood-edit-slider[data-dim="${dim}"]`);
        const valEl  = modal.querySelector(`#mood-edit-val-${dim}`);
        slider.value = '5';
        slider.dataset.touched = 'false';
        if (valEl) { valEl.textContent = '—'; valEl.classList.add('muted'); }
      });
    });

    modal.querySelector('#mood-edit-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#mood-edit-save').addEventListener('click', async () => {
      const payload = { mood_source: 'user_edited' };
      modal.querySelectorAll('.mood-edit-slider').forEach(s => {
        payload[s.dataset.dim] = s.dataset.touched === 'true' ? parseInt(s.value) : null;
      });
      const saveBtn = modal.querySelector('#mood-edit-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api.put(`/api/entries/${this.entryId}`, payload);
        modal.remove();
        showToast('Mood updated ✓', 'success');
        await this.mountDetailView(parentContainer);
      } catch {
        showToast('Could not save mood', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
  }

  // Modal to write a follow-up reflection that appends to the original entry
  // (instead of creating a separate new entry, which fragmented related thoughts)
  showFollowupInputModal(question, parentContainer) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Add a follow-up thought</div>
        <p style="font-size:0.875rem;color:var(--color-text-muted);margin-bottom:12px">
          💭 ${question}
        </p>
        <textarea class="textarea" id="followup-input" placeholder="Write what comes up…" style="min-height:140px;margin-bottom:12px"></textarea>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="followup-cancel">Cancel</button>
          <button class="btn btn-primary" id="followup-save">Add to this entry</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const input = modal.querySelector('#followup-input');
    input.focus();

    modal.querySelector('#followup-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#followup-save').addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { showToast('Write something first', ''); return; }
      const saveBtn = modal.querySelector('#followup-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Adding…';
      try {
        await api.post(`/api/entries/${this.entryId}/followup`, { text, question });
        modal.remove();
        showToast('Added ✓', 'success');
        await this.mountDetailView(parentContainer);
      } catch {
        showToast('Could not add — try again', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add to this entry';
      }
    });
  }

  async loadReflectionQuestions(container) {
    const actionsDiv = container.querySelector('#entry-actions');
    if (!actionsDiv) return;

    // Insert placeholder card before action buttons
    const card = document.createElement('div');
    card.id = 'reflect-card';
    card.className = 'reflect-card reflect-loading';
    card.innerHTML = `<div class="reflect-dots"><span></span><span></span><span></span></div>`;
    actionsDiv.before(card);

    try {
      const result = await api.post('/api/ai/reflect', { entry_id: this.entryId });
      const questions = result.questions || [];
      if (!questions.length) { card.remove(); return; }

      card.className = 'reflect-card';
      card.innerHTML = `
        <div class="reflect-header">
          <span>💭</span>
          <span>A thought or two…</span>
        </div>
        ${questions.map(q => `
          <div class="reflect-question">
            <p>${q}</p>
            <button class="reflect-write-btn" data-q="${q.replace(/"/g, '&quot;')}">→ Write about this</button>
          </div>`).join('')}
      `;
      card.querySelectorAll('.reflect-write-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.showFollowupInputModal(btn.dataset.q, container);
        });
      });
    } catch {
      card.remove(); // Silently fail — reflection is a bonus, not essential
    }
  }

  destroy() {
    this._destroyed = true;
    // Abort any in-flight transcribe/analyze requests so their .then() chains
    // don't try to render into a torn-down view
    for (const ctl of (this._inflightControllers || [])) {
      try { ctl.abort(); } catch {}
    }
    this._inflightControllers = [];
    this.recorder?.destroy();
    this.stopWaveformAnimation();
    this.stopRecordingTimer();
    this.releaseWakeLock();
    // Clean up any persistent UI bits the recorder or prompts may have left
    document.getElementById('inline-save-btn-wrap')?.remove();
    document.getElementById('wake-lock-badge')?.remove();
    document.querySelector('.people-prompt')?.remove();
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}
function formatDate(d) {
  // Use local date constructor to avoid UTC off-by-one in UTC+7
  const [y, m, day] = String(d).split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

// Short label for the back link (e.g. "Today", "Yesterday", "Wed 21 May")
function formatDayShort(dateStr) {
  const todayD = new Date();
  const todayStr = `${todayD.getFullYear()}-${String(todayD.getMonth()+1).padStart(2,'0')}-${String(todayD.getDate()).padStart(2,'0')}`;
  const yest = new Date(todayD); yest.setDate(todayD.getDate() - 1);
  const yStr = `${yest.getFullYear()}-${String(yest.getMonth()+1).padStart(2,'0')}-${String(yest.getDate()).padStart(2,'0')}`;
  if (dateStr === todayStr) return 'Today';
  if (dateStr === yStr) return 'Yesterday';
  const [y, m, dd] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Common English nickname ↔ formal-name pairs. Lowercase, bidirectional.
// Used to bridge "Mike" → "Michael" which prefix/substring matching misses.
const NICKNAME_GROUPS = [
  ['michael', 'mike', 'mick', 'mickey'],
  ['robert', 'bob', 'bobby', 'rob', 'robbie'],
  ['william', 'bill', 'billy', 'will', 'willie'],
  ['richard', 'rick', 'ricky', 'dick'],
  ['elizabeth', 'liz', 'lizzy', 'beth', 'betty', 'eliza', 'ellie', 'libby'],
  ['henry', 'hank', 'harry'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny'],
  ['jonathan', 'jon', 'jonny'],
  ['margaret', 'peggy', 'maggie', 'meg'],
  ['sarah', 'sally', 'sara'],
  ['thomas', 'tom', 'tommy'],
  ['nicholas', 'nick', 'nicky'],
  ['anthony', 'tony'],
  ['steven', 'stephen', 'steve', 'stevie'],
  ['christopher', 'chris', 'christie'],
  ['christina', 'chris', 'tina', 'christy'],
  ['alexander', 'alex', 'al', 'xander'],
  ['alexandra', 'alex', 'sandra', 'sasha'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam', 'sammy'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy'],
  ['daniel', 'dan', 'danny'],
  ['benjamin', 'ben', 'benji'],
  ['joseph', 'joe', 'joey'],
  ['matthew', 'matt', 'matty'],
  ['andrew', 'andy', 'drew'],
  ['patricia', 'pat', 'patty', 'tricia'],
  ['rebecca', 'becky', 'becca'],
  ['katherine', 'kate', 'katie', 'kathy', 'kat'],
  ['catherine', 'cathy', 'kate', 'katie', 'cat'],
  ['jennifer', 'jen', 'jenny'],
  ['stephanie', 'steph', 'stephie'],
  ['charles', 'charlie', 'chuck'],
  ['dorothy', 'dot', 'dotty', 'dory'],
  ['rafaella', 'raf', 'raph', 'ella', 'rafa'],
  ['gabriella', 'gabby', 'ella', 'gabi'],
  ['isabella', 'isa', 'bella', 'izzy'],
];

// Lookup map: nickname → set of canonical/alternative forms
const NICKNAME_MAP = (() => {
  const map = new Map();
  for (const group of NICKNAME_GROUPS) {
    for (const name of group) {
      if (!map.has(name)) map.set(name, new Set());
      group.forEach(n => { if (n !== name) map.get(name).add(n); });
    }
  }
  return map;
})();

function isNicknameOf(a, b) {
  const set = NICKNAME_MAP.get(a);
  return set ? set.has(b) : false;
}

// Returns true if two names are likely the same person.
// Handles: exact, prefix/substring, common nicknames (Mike↔Michael), first-3-chars heuristic.
function nameSimilar(a, b) {
  if (a === b) return false; // exact match handled separately
  if (isNicknameOf(a, b)) return true; // explicit nickname mapping
  const minLen = 3;
  if (a.length < minLen || b.length < minLen) return false;
  // One is a prefix of the other (min 4 chars of overlap, so a 3-letter name
  // like "Sha" doesn't prefix-collide with longer unrelated names).
  const shorter = a.length <= b.length ? a : b;
  if (shorter.length >= 4 && (b.startsWith(a) || a.startsWith(b))) return true;
  // One is contained in the other (e.g. "ella" inside "rafaella"). Require the
  // shorter name to be >=4 chars, otherwise short new names match as accidental
  // substrings of unrelated existing ones ("Sha" inside "Nata-sha").
  if (shorter.length >= 4 && (b.includes(a) || a.includes(b))) return true;
  // First 4 chars match and lengths are close (within 4 chars). Tightened from
  // 3/6 — "Mark" vs "Maria" (mar==mar) was matching unrelated people.
  if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4) && Math.abs(a.length - b.length) <= 4) return true;
  return false;
}

// Score how well a candidate person matches a mention's context.
// Used to auto-pick when multiple people share the same name.
// Returns a number — higher is better. The caller compares top vs runner-up.
function scoreCandidate(person, mention, entryContent) {
  let score = 0;
  const ctx = (mention.context || '').toLowerCase();
  const fullText = (entryContent + ' ' + ctx).toLowerCase();

  // 1. Relationship-type keyword match in context (huge signal)
  // e.g. "my colleague Mike" + person.relationship_type === 'colleague'
  const rel = (person.relationship_type || '').toLowerCase();
  if (rel && rel !== 'unknown') {
    const relWords = {
      colleague: ['colleague', 'coworker', 'work', 'office', 'team', 'boss', 'manager'],
      friend:    ['friend', 'mate', 'buddy', 'pal'],
      family:    ['mum', 'mom', 'dad', 'sister', 'brother', 'aunt', 'uncle', 'cousin', 'family'],
      partner:   ['partner', 'boyfriend', 'girlfriend', 'husband', 'wife', 'spouse'],
      crush:     ['crush', 'date', 'flirt'],
      pet:       ['dog', 'cat', 'puppy', 'kitten', 'pet', 'fluffy', 'fur baby', 'good boy', 'good girl'],
      group:     ['group', 'team', 'crew', 'gang', 'the guys', 'the girls', 'everyone', 'everybody'],
    };
    const keywords = relWords[rel] || [rel];
    // Word-boundary match so 'pet' doesn't match 'petty' or 'carpet', and
    // 'cat' doesn't match 'category'. Multi-word phrases ('good boy', 'the team')
    // still match contiguously because \b sits between word chars and spaces.
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (keywords.some(k => new RegExp(`\\b${escapeRe(k)}\\b`, 'i').test(fullText))) score += 30;
  }

  // 2. Fact overlap — if a known fact about this person appears in the entry
  const facts = Array.isArray(person.all_facts) ? person.all_facts : [];
  for (const fact of facts) {
    const factWords = fact.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    if (factWords.some(w => fullText.includes(w))) score += 8;
  }

  // 3. Recency — last_mentioned within 30 days gets a small boost
  if (person.last_mentioned) {
    const daysAgo = (Date.now() - new Date(person.last_mentioned).getTime()) / 86400000;
    if (daysAgo < 7)       score += 6;
    else if (daysAgo < 30) score += 3;
  }

  // 4. Frequency — people you mention more often slightly more likely
  const mentions = parseInt(person.mention_count) || 0;
  score += Math.min(5, Math.log2(mentions + 1));

  return Math.round(score * 10) / 10;
}
