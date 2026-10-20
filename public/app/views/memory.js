// The Remember screen (#remember, or #remember/voice to start the mic at once).
//
// Built for "open it, say or type one thing, done":
//   - Talk: one big mic button in the thumb zone. Tap to start, tap to stop —
//     it transcribes and SAVES by itself (with a few seconds to Undo; tap the
//     memory below to fix a misheard word).
//   - Type: the box at the top. Return saves (Shift+Return = new line).
// Everything else (Ask Nook, recent memories) sits below and stays out of the way.
// The bottom nav is hidden here so the screen has one job.
import { api, showToast, todayStr, authHeaders } from '../app.js';
import { VoiceRecorder } from '../components/voiceRecorder.js';
import { memoryCardHtml, wireMemoryCards } from '../components/memoryCard.js';
import { renderMarkdown } from '../markdown.js';
import { escHtml } from '../html.js';

const MIC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
const RECENT_SHOWN = 5;   // recent memories visible before "Show all"
const UNDO_MS = 6000;     // how long the Undo button stays after a save

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
    this.showAll = false;
    this._destroyed = false;
  }

  async mount(container) {
    this.container = container;
    document.body.classList.add('remember-mode'); // hides the bottom nav (CSS)
    container.innerHTML = `
      <div class="memory-view">
        <div class="memory-top">
          <a href="#home" class="back-btn">← Nook</a>
          <span class="memory-top-title">🧠 Remember</span>
        </div>

        <div class="memory-type">
          <textarea class="memory-input" id="memory-input" rows="3" enterkeyhint="done"
            placeholder="Tap to type something to remember…"></textarea>
          <button class="btn btn-primary memory-save" id="memory-save" disabled>Save</button>
        </div>

        <div class="memory-talk">
          <div class="memory-status" id="memory-status" aria-live="polite">or tap to talk</div>
          <button class="memory-mic-big" id="memory-mic" aria-label="Record a memory">${MIC_ICON}</button>
        </div>

        <details class="memory-ask-wrap">
          <summary>💬 Ask Nook about something you saved</summary>
          <form class="memory-ask" id="memory-ask">
            <input class="input" id="memory-question" autocomplete="off" enterkeyhint="search"
              placeholder="e.g. what café did Tom recommend?">
            <button class="btn btn-primary" type="submit">Ask</button>
          </form>
          <div id="memory-answer"></div>
        </details>

        <div class="section-header mt-16"><h3>Recent</h3></div>
        <div id="memory-list" class="memory-list"><div class="loading-spinner"></div></div>
      </div>`;

    const input = container.querySelector('#memory-input');
    const saveBtn = container.querySelector('#memory-save');
    // Save only lights up once there's something to save.
    input.addEventListener('input', () => { saveBtn.disabled = !input.value.trim(); });
    saveBtn.addEventListener('click', () => this.saveTyped());
    // Return saves — a memory is usually one line. Shift+Return still adds a
    // line break. (isComposing: don't fire mid-word on Thai/Asian keyboards.)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.saveTyped(); }
    });
    container.querySelector('#memory-mic').addEventListener('click', () => this.toggleMic());
    container.querySelector('#memory-ask').addEventListener('submit', e => { e.preventDefault(); this.ask(); });

    // On a laptop, focus the box so you can just start typing. (iPhone won't
    // open the keyboard without a tap anyway, and focusing would only scroll.)
    if (this.startWithVoice) this.toggleMic();
    else if (!matchMedia('(pointer: coarse)').matches) input.focus();

    await this.loadList();
  }

  setStatus(text, cls = '') {
    const el = this.container.querySelector('#memory-status');
    if (!el) return;
    el.className = `memory-status ${cls}`;
    el.innerHTML = text;
  }

  async loadList() {
    const list = this.container.querySelector('#memory-list');
    try {
      const memories = await api.get('/api/memories?limit=50');
      if (this._destroyed) return;
      const shown = this.showAll ? memories : memories.slice(0, RECENT_SHOWN);
      list.innerHTML = memories.length
        ? shown.map(m => memoryCardHtml(m, { showDate: true })).join('') +
          (memories.length > RECENT_SHOWN && !this.showAll
            ? `<button class="btn btn-ghost btn-sm" id="memory-show-all">Show all ${memories.length}</button>` : '')
        : `<p class="text-sm text-muted" style="padding:8px 2px">Nothing yet — your first memory will show up here.</p>`;
      wireMemoryCards(list, memories, () => this.loadList());
      list.querySelector('#memory-show-all')?.addEventListener('click', () => { this.showAll = true; this.loadList(); });
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

  // ── Saving ─────────────────────────────────────────────────────────────
  async saveTyped() {
    const input = this.container.querySelector('#memory-input');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    this.container.querySelector('#memory-save').disabled = true;
    const ok = await this.save(content, 'text');
    if (!ok && !input.value) { input.value = content; this.container.querySelector('#memory-save').disabled = false; }
  }

  // Shared by typing and talking. Returns true if it's saved (or queued offline).
  async save(content, mode) {
    const id = newId();
    try {
      await api.post('/api/memories', { id, content, date: todayStr(), entry_mode: mode });
      this.showSaved(id);
      this.loadList();
      return true;
    } catch (err) {
      // The service worker kept it and will send it when there's signal again.
      if (err.queued) {
        this.setStatus('✓ Saved offline — will sync when you’re back online', 'is-saved');
        return true;
      }
      this.setStatus(escHtml(err.message || 'Could not save that — try again'), 'is-error');
      return false;
    }
  }

  // "✓ Saved" + Undo for a few seconds, then back to the resting prompt.
  // (The memory itself appears at the top of Recent right below.)
  showSaved(id) {
    clearTimeout(this._undoTimer);
    this.setStatus('✓ Saved <button class="memory-undo" id="memory-undo">Undo</button>', 'is-saved');
    this.container.querySelector('#memory-undo')?.addEventListener('click', async () => {
      clearTimeout(this._undoTimer);
      try {
        await api.delete(`/api/memories/${id}`);
        this.setStatus('Undone — nothing saved');
        this.loadList();
      } catch {
        this.setStatus('Couldn’t undo — tap it below to delete', 'is-error');
      }
    });
    this._undoTimer = setTimeout(() => { if (!this.recorder?.isRecording) this.setStatus('or tap to talk'); }, UNDO_MS);
  }

  // ── Voice: tap → talk → tap → saved ───────────────────────────────────
  toggleMic() {
    const mic = this.container.querySelector('#memory-mic');
    if (this.recorder?.isRecording) { this.recorder.stop(); return; }
    if (mic.classList.contains('busy')) return; // still transcribing the last one

    clearTimeout(this._undoTimer);
    this.recorder?.destroy();
    this.recorder = new VoiceRecorder({
      onStart: () => {
        mic.innerHTML = STOP_ICON;
        mic.classList.add('recording');
        mic.setAttribute('aria-label', 'Stop and save');
        const started = Date.now();
        const tick = () => {
          const s = Math.floor((Date.now() - started) / 1000);
          this.setStatus(`<span class="memory-rec-dot"></span> ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · tap to stop & save`, 'is-recording');
        };
        tick();
        this._timer = setInterval(tick, 500);
      },
      onStop: async (blob) => {
        clearInterval(this._timer);
        mic.innerHTML = MIC_ICON;
        mic.classList.remove('recording');
        mic.setAttribute('aria-label', 'Record a memory');
        if (this._destroyed) return;
        if (!blob || blob.size === 0) {
          this.setStatus(escHtml(this.recorder?._lastError || 'No audio captured — try again'), 'is-error');
          return;
        }
        mic.classList.add('busy');
        this.setStatus('<span class="transcribe-spinner"><span></span><span></span><span></span></span> Saving…');
        try {
          const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
          const form = new FormData();
          form.append('audio', blob, `memory.${ext}`);
          const res = await fetch('/api/ai/transcribe', { method: 'POST', body: form, headers: authHeaders() });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Couldn’t transcribe that — try again');
          if (this._destroyed) return;
          const said = (data.transcript || '').trim();
          if (!said) { this.setStatus('Didn’t catch anything — try again', 'is-error'); return; }
          // Anything already typed in the box goes in the same memory.
          const input = this.container.querySelector('#memory-input');
          const typed = input.value.trim();
          const ok = await this.save(typed ? `${typed} ${said}` : said, 'voice');
          if (ok && typed) { input.value = ''; this.container.querySelector('#memory-save').disabled = true; }
          // Failed to save: keep the words so they aren't lost.
          if (!ok) { input.value = typed ? `${typed} ${said}` : said; this.container.querySelector('#memory-save').disabled = false; }
        } catch (err) {
          this.setStatus(escHtml(err.message || 'Couldn’t transcribe that — try again'), 'is-error');
        } finally {
          mic.classList.remove('busy');
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
    document.body.classList.remove('remember-mode');
    clearTimeout(this._refresh);
    clearTimeout(this._undoTimer);
    clearInterval(this._timer);
    this.recorder?.destroy();
  }
}
