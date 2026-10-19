// The Remember screen (#remember, or #remember/voice to start the mic at once).
//
// Three things, top to bottom:
//   1. Capture — type or say one thing to remember, save, done. Built for the
//      "on my phone, right now" moment, so it's one box and one button.
//   2. Ask Nook — a plain-English question answered from your memories and
//      journal ("when is Sarah's birthday?").
//   3. Recent memories — tap one to edit or delete it.
import { api, showToast, todayStr, authHeaders } from '../app.js';
import { VoiceRecorder } from '../components/voiceRecorder.js';
import { memoryCardHtml, wireMemoryCards } from '../components/memoryCard.js';
import { renderMarkdown } from '../markdown.js';
import { escHtml } from '../html.js';

// Mic / stop icons for the dictate button (same mic as the home screen's).
const MIC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

// A random id made on the phone, so a save the service worker queued offline
// and replays later is recognised by the server instead of saved twice.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; // mark as a v4 UUID
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class MemoryView {
  constructor(params = []) {
    this.startWithVoice = params[0] === 'voice';
    this.recorder = null;
    this.usedVoice = false; // was any of the current text dictated?
    this._destroyed = false;
  }

  async mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="memory-view">
        <div class="day-header">
          <a href="#home" class="back-btn">← Home</a>
          <h2 class="day-title">🧠 Remember</h2>
        </div>

        <div class="memory-capture card">
          <textarea class="textarea memory-input" id="memory-input" rows="3"
            placeholder="What do you want to remember?&#10;e.g. Sarah's birthday is 12 March"></textarea>
          <div class="memory-capture-actions">
            <button class="btn btn-secondary memory-mic" id="memory-mic" aria-label="Dictate">${MIC_ICON}</button>
            <span class="memory-hint text-xs text-muted" id="memory-hint"></span>
            <button class="btn btn-primary" id="memory-save">Save</button>
          </div>
        </div>

        <div class="section-header mt-16"><h3>💬 Ask Nook</h3></div>
        <form class="memory-ask" id="memory-ask">
          <input class="input" id="memory-question" autocomplete="off"
            placeholder="e.g. what café did Tom recommend?">
          <button class="btn btn-primary" type="submit">Ask</button>
        </form>
        <div id="memory-answer"></div>

        <div class="section-header mt-16"><h3>Recent memories</h3></div>
        <div id="memory-list" class="memory-list"><div class="loading-spinner"></div></div>
      </div>`;

    const input = container.querySelector('#memory-input');
    container.querySelector('#memory-save').addEventListener('click', () => this.save());
    // Laptop: Ctrl/Cmd + Enter saves without reaching for the mouse.
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.save(); }
    });
    container.querySelector('#memory-mic').addEventListener('click', () => this.toggleMic());
    container.querySelector('#memory-ask').addEventListener('submit', e => { e.preventDefault(); this.ask(); });

    if (this.startWithVoice) this.toggleMic();
    else setTimeout(() => input.focus(), 80);

    await this.loadList();
  }

  async loadList() {
    const list = this.container.querySelector('#memory-list');
    try {
      const memories = await api.get('/api/memories?limit=50');
      if (this._destroyed) return;
      list.innerHTML = memories.length
        ? memories.map(m => memoryCardHtml(m, { showDate: true })).join('')
        : `<p class="text-sm text-muted" style="padding:8px 2px">Nothing yet — your first memory will show up here.</p>`;
      wireMemoryCards(list, memories, () => this.loadList());
      // The AI labels a new memory a few seconds after saving; refresh once
      // so its title and tags appear without a manual reload.
      clearTimeout(this._refresh);
      if (memories.some(m => !m.analyzed && Date.now() - new Date(m.created_at) < 60000)) {
        this._refresh = setTimeout(() => this.loadList(), 4000);
      }
    } catch {
      list.innerHTML = `<p class="text-sm text-muted">Couldn't load memories right now.</p>`;
    }
  }

  async save() {
    const input = this.container.querySelector('#memory-input');
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    const btn = this.container.querySelector('#memory-save');
    btn.disabled = true;
    const body = { id: newId(), content, date: todayStr(), entry_mode: this.usedVoice ? 'voice' : 'text' };
    try {
      await api.post('/api/memories', body);
      showToast('Saved 🧠');
      this.clearInput();
      this.loadList();
    } catch (err) {
      // The service worker kept it and will send it when there's signal again.
      if (err.queued) { showToast('Saved offline — will sync when you\'re back online'); this.clearInput(); }
      else showToast(err.message || 'Could not save that', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  clearInput() {
    const input = this.container.querySelector('#memory-input');
    input.value = '';
    this.usedVoice = false;
    input.focus();
  }

  // ── Voice: record → transcribe → drop the text into the box to check ──
  // The text lands in the box rather than saving straight away, so a misheard
  // word can be fixed before it's stored.
  toggleMic() {
    const mic = this.container.querySelector('#memory-mic');
    const hint = this.container.querySelector('#memory-hint');
    if (this.recorder?.isRecording) { this.recorder.stop(); return; }

    this.recorder?.destroy();
    this.recorder = new VoiceRecorder({
      onStart: () => {
        mic.innerHTML = STOP_ICON;
        mic.classList.add('recording');
        hint.textContent = 'Listening… tap ■ when done';
      },
      onStop: async (blob) => {
        mic.innerHTML = MIC_ICON;
        mic.classList.remove('recording');
        if (this._destroyed) return;
        if (!blob || blob.size === 0) {
          hint.textContent = this.recorder?._lastError || 'No audio captured — try again';
          return;
        }
        hint.textContent = 'Transcribing…';
        try {
          const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
          const form = new FormData();
          form.append('audio', blob, `memory.${ext}`);
          const res = await fetch('/api/ai/transcribe', { method: 'POST', body: form, headers: authHeaders() });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Transcription failed');
          if (this._destroyed) return;
          const text = (data.transcript || '').trim();
          if (!text) { hint.textContent = 'Didn\'t catch anything — try again'; return; }
          const input = this.container.querySelector('#memory-input');
          input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
          this.usedVoice = true;
          hint.textContent = 'Check it, then Save';
          input.focus();
        } catch (err) {
          hint.textContent = err.message || 'Transcription failed — try again';
        }
      },
      onKeyword: () => this.recorder?.stop(),
    });
    this.recorder.start();
  }

  // ── Ask Nook ──
  async ask() {
    const q = this.container.querySelector('#memory-question').value.trim();
    const box = this.container.querySelector('#memory-answer');
    if (!q) return;
    box.innerHTML = `<div class="memory-answer card"><span class="transcribe-spinner"><span></span><span></span><span></span></span> Thinking…</div>`;
    try {
      const { answer, sources } = await api.post('/api/memories/ask', { question: q });
      if (this._destroyed) return;
      box.innerHTML = `
        <div class="memory-answer card">
          <div class="memory-answer-text">${renderMarkdown(answer)}</div>
          ${sources.length ? `
          <div class="memory-sources">
            <div class="text-xs text-muted">From:</div>
            ${sources.map(s => `
              <a class="memory-source" href="${s.type === 'entry' ? `#new-entry/${escHtml(s.id)}` : `#day/${escHtml(s.date)}`}">
                ${s.type === 'entry' ? '📓' : '🧠'} <span>${escHtml(s.title || s.text.slice(0, 90))}</span>
                <span class="text-xs text-muted">${escHtml(s.date)}</span>
              </a>`).join('')}
          </div>` : ''}
        </div>`;
    } catch (err) {
      box.innerHTML = `<div class="memory-answer card text-muted">${escHtml(err.offline ? 'You\'re offline — ask again when you have signal.' : (err.message || 'Could not answer that right now.'))}</div>`;
    }
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._refresh);
    this.recorder?.destroy();
  }
}
