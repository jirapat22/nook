import { api, showToast, speak, AppState } from '../app.js';
import { VoiceRecorder }   from '../components/voiceRecorder.js';
import { AiPanel }         from '../components/aiPanel.js';
import { LoveLifeSection } from '../components/loveLifeSection.js';
import { MoodTracker }     from '../components/moodTracker.js';

export class EntryView {
  constructor(params = []) {
    // params[0]: 'voice' | 'text' | <entry-id>
    this.params = params;
    this.mode = 'text'; // 'voice' | 'text'
    this.entryId = null;
    this.analysis = null;
    this.followupRound = 0;
    this.conversationHistory = [];
    this.savedEntry = null;
    this.recorder = null;
    this.container = null;
    this.moodOverrides = {};

    // Determine initial mode / existing entry
    if (params[0] === 'voice') this.mode = 'voice';
    else if (params[0] === 'text' || !params[0]) this.mode = 'text';
    else {
      this.entryId = params[0];
      this.mode = 'text';
    }
  }

  async mount(container) {
    this.container = container;

    if (this.entryId) {
      await this.mountDetailView(container);
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const timeOfDay = getTimeOfDay();

    container.innerHTML = `
      <div class="entry-view">
        <div class="entry-mode-toggle" id="mode-toggle">
          <div class="mode-tab ${this.mode === 'drive' ? 'active' : ''}" data-mode="drive">🎙️ Drive</div>
          <div class="mode-tab ${this.mode !== 'drive' ? 'active' : ''}" data-mode="text">✍️ Desktop</div>
        </div>

        <div class="date-row">
          <input type="date" class="input" id="entry-date" value="${today}" max="${today}">
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

    // Wire up mode toggle
    container.querySelectorAll('.mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const newMode = tab.dataset.mode;
        container.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.mode = newMode;
        this.renderModeContent();
        this.resetAnalysis();
      });
    });

    // Date change → backdated notice
    container.querySelector('#entry-date').addEventListener('change', e => {
      const isBackdated = e.target.value < today;
      container.querySelector('#backdated-notice').classList.toggle('hidden', !isBackdated);
    });

    // Save / discard
    container.querySelector('#save-btn').addEventListener('click', () => this.saveEntry());
    container.querySelector('#discard-btn').addEventListener('click', () => {
      if (confirm('Discard this entry?')) location.hash = '#home';
    });

    this.renderModeContent();

    // If opened as voice directly
    if (this.mode === 'voice') {
      setTimeout(() => this.startVoiceMode(), 100);
    }
  }

  renderModeContent() {
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
          <button class="mic-btn" id="mic-btn" aria-label="Start recording">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8"  y1="23" x2="16" y2="23"/>
            </svg>
          </button>
          <p class="mic-hint" id="mic-hint">Tap to start recording</p>
          <div class="waveform hidden" id="waveform">
            ${Array.from({length: 20}, () => '<div class="waveform-bar" style="height:8px"></div>').join('')}
          </div>
        </div>

        <div class="recording-status hidden" id="rec-status">
          <span class="recording-dot"></span>
          <span id="rec-time">0:00</span>
          <span>· Say "done" or tap mic to stop</span>
        </div>

        <div class="recorder-transcript placeholder" id="transcript-display">
          Your words will appear here after recording...
        </div>
      </div>
    `;

    this.startVoiceMode();
  }

  startVoiceMode() {
    const mc = this.container.querySelector('#mode-content');
    const micBtn = mc?.querySelector('#mic-btn');
    const hint = mc?.querySelector('#mic-hint');
    const waveform = mc?.querySelector('#waveform');
    const recStatus = mc?.querySelector('#rec-status');
    const transcriptDisplay = mc?.querySelector('#transcript-display');
    if (!micBtn) return;

    this.recorder = new VoiceRecorder({
      onStart: () => {
        micBtn.classList.add('recording');
        hint.textContent = 'Recording... say "done" or tap to stop';
        waveform.classList.remove('hidden');
        recStatus.classList.remove('hidden');
        this.startWaveformAnimation(waveform);
        this.startRecordingTimer(recStatus.querySelector('#rec-time'));
      },
      onStop: async (audioBlob) => {
        micBtn.classList.remove('recording');
        micBtn.classList.add('processing');
        hint.textContent = 'Transcribing...';
        waveform.classList.add('hidden');
        recStatus.classList.add('hidden');
        this.stopWaveformAnimation();
        this.stopRecordingTimer();

        transcriptDisplay.textContent = 'Transcribing your recording...';
        transcriptDisplay.classList.remove('placeholder');

        try {
          const form = new FormData();
          form.append('audio', audioBlob, 'recording.webm');
          const result = await api.postForm('/api/ai/transcribe', form);
          const transcript = result.transcript || '';
          transcriptDisplay.textContent = transcript || '(No transcript — please try again or type manually)';

          if (transcript) {
            await this.analyzeContent(transcript);
          }
        } catch (err) {
          showToast('Transcription unavailable — try typing instead', 'error');
          transcriptDisplay.textContent = '(Transcription failed)';
          this.container.querySelector('#mode-toggle').querySelector('[data-mode="text"]').click();
        }

        micBtn.classList.remove('processing');
        hint.textContent = 'Tap to record again';
      },
      onKeyword: () => this.recorder?.stop(),
    });

    micBtn.addEventListener('click', () => {
      if (this.recorder.isRecording) {
        this.recorder.stop();
      } else {
        this.recorder.start();
      }
    });
  }

  startWaveformAnimation(waveform) {
    const bars = waveform.querySelectorAll('.waveform-bar');
    this._waveInterval = setInterval(() => {
      bars.forEach(bar => {
        const h = Math.random() * 36 + 4;
        bar.style.height = h + 'px';
      });
    }, 100);
  }

  stopWaveformAnimation() {
    clearInterval(this._waveInterval);
  }

  startRecordingTimer(el) {
    let seconds = 0;
    this._timerInterval = setInterval(() => {
      seconds++;
      const m = Math.floor(seconds / 60);
      const s = String(seconds % 60).padStart(2, '0');
      if (el) el.textContent = `${m}:${s}`;
    }, 1000);
  }

  stopRecordingTimer() {
    clearInterval(this._timerInterval);
  }

  // ── Desktop Mode ────────────────────────────────────────────
  renderDesktopMode(container) {
    container.innerHTML = `
      <div class="desktop-mode">
        <div class="form-group">
          <label class="form-label">What's on your mind?</label>
          <div class="entry-textarea-wrap">
            <textarea class="textarea textarea-large" id="entry-content" placeholder="Write freely — Nook will help clean it up and find the themes..." maxlength="10000"></textarea>
            <div class="char-count"><span id="char-count">0</span> / 10,000</div>
          </div>
        </div>
        <div class="analyze-btn-wrap">
          <button class="btn btn-primary" id="analyze-btn">
            ✨ Analyse
          </button>
        </div>
      </div>
    `;

    const textarea = container.querySelector('#entry-content');
    const charCount = container.querySelector('#char-count');
    const analyzeBtn = container.querySelector('#analyze-btn');

    textarea.addEventListener('input', () => {
      charCount.textContent = textarea.value.length;
    });

    analyzeBtn.addEventListener('click', async () => {
      const content = textarea.value.trim();
      if (!content) { showToast('Write something first 😊', ''); return; }
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = '✨ Analysing...';
      await this.analyzeContent(content);
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '✨ Analyse again';
    });
  }

  // ── Analysis ────────────────────────────────────────────────
  async analyzeContent(content) {
    this.rawContent = content;
    try {
      this.analysis = await api.post('/api/ai/analyze', {
        content,
        conversation_history: this.conversationHistory,
      });
      this.renderAnalysisResults();
      this.showActionBar();

      // Drive mode: speak follow-up
      if (this.analysis.followup_question && this.mode === 'drive') {
        speak(this.analysis.followup_question);
      }

      // Offer follow-up
      if (this.analysis.followup_question && this.followupRound < 3) {
        this.renderFollowup(this.analysis.followup_question);
      }
    } catch (err) {
      console.error('Analysis error:', err);
      showToast(err.message || 'AI analysis unavailable — your entry is saved.', 'error');
      this.showActionBar();
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
          <input type="text" class="input" id="followup-answer" placeholder="Your answer..." />
          <button class="btn btn-secondary btn-sm" id="followup-skip">Skip</button>
          <button class="btn btn-primary btn-sm" id="followup-send">Send</button>
        </div>
      </div>
    `;

    const input = section.querySelector('#followup-answer');
    const sendBtn = section.querySelector('#followup-send');
    const skipBtn = section.querySelector('#followup-skip');

    const send = async () => {
      const answer = input.value.trim();
      if (!answer) return;
      this.followupRound++;
      this.conversationHistory.push({ role: 'assistant', content: question });
      this.conversationHistory.push({ role: 'user', content: answer });
      section.innerHTML = '<div class="loading-spinner"></div>';
      await this.analyzeContent(this.rawContent + '\n\nFollow-up: ' + answer);
    };

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    skipBtn.addEventListener('click', () => { section.innerHTML = ''; });

    // Drive mode: listen for voice answer
    if (this.mode === 'drive' && AppState.ttsEnabled) {
      this.listenForFollowupAnswer(send, input);
    }
  }

  listenForFollowupAnswer(onAnswer, input) {
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recog = new SR();
    recog.continuous = false;
    recog.interimResults = false;
    recog.onresult = e => {
      const transcript = e.results[0][0].transcript;
      input.value = transcript;
      onAnswer();
    };
    recog.start();
  }

  renderAnalysisResults() {
    if (!this.analysis) return;
    const a = this.analysis;

    // AI Panel
    const panelSection = this.container.querySelector('#ai-panel-section');
    const panel = new AiPanel(a, this.moodOverrides, (overrides) => { this.moodOverrides = overrides; });
    panel.mount(panelSection);

    // Love life section
    if (a.has_love_life_content) {
      const loveSection = this.container.querySelector('#love-section');
      const ll = new LoveLifeSection(a);
      ll.mount(loveSection);
    }

    // Mood tracker (uncertain dimensions)
    if (a.mood?.uncertain_dimensions?.length) {
      const moodSection = this.container.querySelector('#mood-section');
      const tracker = new MoodTracker(a.mood, (updates) => {
        this.moodOverrides = { ...this.moodOverrides, ...updates };
      });
      tracker.mount(moodSection);
    }
  }

  resetAnalysis() {
    this.analysis = null;
    this.followupRound = 0;
    this.conversationHistory = [];
    ['#followup-section', '#ai-panel-section', '#love-section', '#mood-section'].forEach(sel => {
      const el = this.container.querySelector(sel);
      if (el) el.innerHTML = '';
    });
    this.container.querySelector('#action-bar').style.display = 'none';
  }

  showActionBar() {
    this.container.querySelector('#action-bar').style.display = 'flex';
  }

  // ── Save entry ───────────────────────────────────────────────
  async saveEntry() {
    const saveBtn = this.container.querySelector('#save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const date = this.container.querySelector('#entry-date').value;
    const today = new Date().toISOString().split('T')[0];
    const isBackdated = date < today;

    // Determine content
    let rawContent = this.rawContent || '';
    if (this.mode === 'text') {
      rawContent = this.container.querySelector('#entry-content')?.value?.trim() || '';
    }

    if (!rawContent && !this.analysis) {
      showToast('Nothing to save — write something first!', '');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save entry';
      return;
    }

    const a = this.analysis || {};
    const mood = { ...a.mood, ...this.moodOverrides };
    const timeOfDay = getTimeOfDay();

    const payload = {
      date,
      time_of_day: timeOfDay,
      is_backdated: isBackdated,
      raw_transcript: rawContent,
      cleaned_content: a.cleaned_content || rawContent,
      ai_summary: a.ai_summary || null,
      key_themes: a.key_themes || [],
      action_items: a.action_items || [],
      important_today: a.important_today || null,
      mood_energy: mood.energy ?? null,
      mood_happiness: mood.happiness ?? null,
      mood_anxiety: mood.anxiety ?? null,
      mood_confidence: mood.confidence ?? null,
      mood_motivation: mood.motivation ?? null,
      mood_social_battery: mood.social_battery ?? null,
      mood_physical: mood.physical ?? null,
      mood_focus: mood.focus ?? null,
      mood_overall: mood.overall ?? null,
      mood_source: this.analysis ? 'ai_detected' : null,
      life_areas: a.life_areas || [],
      tags: a.suggested_tags || [],
      entry_mode: this.mode === 'drive' ? 'voice' : 'text',
      has_love_life_content: a.has_love_life_content || false,
      love_life_raw: a.love_life_content || null,
      love_life_cleaned: a.love_life_content || null,
      love_life_emotion_intensity: a.love_life_emotion_intensity ?? null,
      love_life_ai_summary: a.love_life_content ? (a.ai_summary || null) : null,
    };

    try {
      const saved = await api.post('/api/entries', payload);
      showToast('Entry saved. Your nook remembers. 🌿', 'success');

      // Link people mentions
      if (a.people_mentioned?.length) {
        await this.linkPeopleMentions(saved.id, a.people_mentioned);
      }

      setTimeout(() => { location.hash = '#home'; }, 1200);
    } catch (err) {
      console.error('Save error:', err);
      showToast('Could not save — please try again', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save entry';
    }
  }

  async linkPeopleMentions(entryId, mentioned) {
    try {
      const existing = await api.get('/api/people');
      const newPeople = [];

      for (const person of mentioned) {
        const match = existing.find(p =>
          p.name.toLowerCase() === person.name.toLowerCase()
        );

        let personId;
        if (match) {
          personId = match.id;
        } else {
          newPeople.push(person);
          continue;
        }

        await api.post('/api/people/link-mention', {
          person_id: personId,
          entry_id: entryId,
          context: person.context,
          sentiment_score: person.sentiment,
          facts_extracted: person.facts_extracted || [],
          emotion_toward: person.emotion_toward,
        }).catch(() => {});
      }

      // Show prompt for unrecognized people
      if (newPeople.length) {
        this.showPeoplePrompt(newPeople, entryId);
      }
    } catch (err) {
      console.warn('People linking error:', err);
    }
  }

  showPeoplePrompt(people, entryId) {
    const existing = document.querySelector('.people-prompt');
    if (existing) existing.remove();

    const names = people.map(p => p.name).join(', ');
    const prompt = document.createElement('div');
    prompt.className = 'people-prompt';
    prompt.innerHTML = `
      <p>You mentioned <strong>${names}</strong> — add them to your People?</p>
      <div class="people-prompt-actions">
        <button class="btn btn-primary btn-sm" id="add-people-yes">Add</button>
        <button class="btn btn-ghost btn-sm" id="add-people-no">Not now</button>
      </div>
    `;
    document.body.appendChild(prompt);

    prompt.querySelector('#add-people-yes').addEventListener('click', async () => {
      prompt.remove();
      for (const person of people) {
        try {
          const created = await api.post('/api/people', {
            name: person.name,
            relationship_type: 'unknown',
            notes: '',
          });
          await api.post('/api/people/link-mention', {
            person_id: created.id,
            entry_id: entryId,
            context: person.context,
            sentiment_score: person.sentiment,
            facts_extracted: person.facts_extracted || [],
            emotion_toward: person.emotion_toward,
          });
        } catch {}
      }
      showToast('People added!', 'success');
    });

    prompt.querySelector('#add-people-no').addEventListener('click', () => prompt.remove());
    setTimeout(() => prompt.remove(), 12000);
  }

  // ── Detail view (view existing entry) ───────────────────────
  async mountDetailView(container) {
    try {
      const entry = await api.get(`/api/entries/${this.entryId}`);
      const content = entry.user_edited_content || entry.cleaned_content || entry.raw_transcript || '';

      const moodClass = entry.mood_overall == null ? 'none' : entry.mood_overall >= 7 ? 'high' : entry.mood_overall >= 4 ? 'mid' : 'low';
      const themes = Array.isArray(entry.key_themes) ? entry.key_themes : [];
      const tags   = Array.isArray(entry.tags)        ? entry.tags        : [];

      container.innerHTML = `
        <div class="entry-detail">
          <div class="back-btn" id="back-btn">← Back</div>

          <div class="entry-detail-meta">
            <span>${formatDate(entry.date)}</span>
            ${entry.time_of_day ? `<span>· ${entry.time_of_day}</span>` : ''}
            ${entry.mood_overall != null ? `<span class="mood-dot ${moodClass}"></span><span>${entry.mood_overall}/10</span>` : ''}
            ${entry.is_backdated ? '<span class="backdated-label">Added after the fact</span>' : ''}
          </div>

          ${entry.ai_summary ? `<div class="card mb-12"><p class="font-display text-muted" style="font-style:italic">${entry.ai_summary}</p></div>` : ''}

          <div class="entry-content-block">${content}</div>

          ${themes.length ? `
          <div class="mb-12">
            <div class="ai-section-label">Themes</div>
            <div class="tags-row">${themes.map(t => `<span class="chip chip-primary">${t}</span>`).join('')}</div>
          </div>` : ''}

          ${tags.length ? `
          <div class="mb-12">
            <div class="ai-section-label">Tags</div>
            <div class="tags-row">${tags.map(t => `<span class="chip">${t}</span>`).join('')}</div>
          </div>` : ''}

          ${entry.action_items?.length ? `
          <div class="mb-12">
            <div class="ai-section-label">Action items</div>
            <div class="action-items-list">
              ${entry.action_items.map(item => `<div class="action-item"><input type="checkbox"><span>${item}</span></div>`).join('')}
            </div>
          </div>` : ''}

          <div class="entry-detail-actions">
            <button class="btn btn-secondary btn-sm" id="edit-btn">Edit</button>
            <button class="btn btn-danger btn-sm" id="delete-btn">Delete</button>
          </div>
        </div>
      `;

      container.querySelector('#back-btn').addEventListener('click', () => history.back());
      container.querySelector('#delete-btn').addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        await api.delete(`/api/entries/${this.entryId}`);
        showToast('Entry deleted', '');
        location.hash = '#home';
      });
      container.querySelector('#edit-btn').addEventListener('click', () => {
        // Simple edit: put content back in textarea
        container.querySelector('.entry-content-block').contentEditable = 'true';
        container.querySelector('.entry-content-block').focus();
      });
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">😕</div><h3>Entry not found</h3><a href="#home" class="btn btn-primary btn-sm mt-12">Go home</a></div>`;
    }
  }

  destroy() {
    this.recorder?.destroy?.();
    this.stopWaveformAnimation();
    this.stopRecordingTimer();
  }
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
