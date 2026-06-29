import { api, showToast, applyTheme, AppState, scheduleReminder } from '../app.js';
import { reportManual } from '../report.js';

export class SettingsView {
  constructor() {}

  async mount(container) {
    this.container = container || this.container;
    container = this.container;
    let settings = {};
    try { settings = await api.get('/api/settings'); } catch {}

    const theme = settings.theme || 'warm-earthy';
    const ttsEnabled = settings.tts_enabled !== false;
    const ttsSpeed = parseFloat(settings.tts_speed) || 1;
    const transcribeLang = (typeof settings.transcribe_language === 'string'
      ? settings.transcribe_language.replace(/^"|"$/g, '') : '') || 'en';
    // The key itself is never sent to the client anymore — only whether one is set.
    const apiKeySet = settings.groq_api_key_set === true;
    const reminderEnabled = settings.reminder_enabled === 'true' || settings.reminder_enabled === true;
    const reminderTime = (settings.reminder_time || '"21:00"').replace(/"/g, '');
    const userName = typeof settings.user_name === 'string'
      ? settings.user_name.replace(/^"|"$/g, '')
      : 'there';
    const notifSupported = 'Notification' in window;
    const notifGranted = notifSupported && Notification.permission === 'granted';

    container.innerHTML = `
      <div class="settings-view">
        <div class="page-header"><h1>Settings</h1></div>

        <!-- Profile -->
        <div class="settings-section-title">Profile</div>
        <div class="card">
          <div class="form-label mb-8">What should Nook call you?</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" class="input" id="user-name-input" value="${userName}" placeholder="Your name" maxlength="40" style="flex:1">
            <button class="btn btn-primary btn-sm" id="save-user-name">Save</button>
          </div>
        </div>

        <!-- Theme -->
        <div class="settings-section-title">Appearance</div>
        <div class="card">
          <div class="form-label mb-8">Theme</div>
          <div class="theme-swatches" id="theme-swatches">
            ${themeSwatch('warm-earthy',    '#f7f4ee', '#c8843a',  'Warm Earthy',  theme)}
            ${themeSwatch('dark-intimate',  '#141210', '#d4956a',  'Dark Intimate', theme)}
            ${themeSwatch('clean-minimal',  '#f8f8f7', '#2d6a4f',  'Clean Minimal', theme)}
          </div>
        </div>

        <!-- Voice (Drive Mode) -->
        <div class="settings-section-title">Drive Mode</div>
        <div class="card">
          <div class="settings-row" style="border:none;padding:0;margin-bottom:12px">
            <div>
              <div class="settings-row-label">Voice feedback</div>
              <div class="settings-row-sub">Nook speaks follow-up questions aloud</div>
            </div>
            <div class="toggle ${ttsEnabled ? 'on' : ''}" id="tts-toggle"></div>
          </div>
          <div>
            <div class="form-label">Voice speed</div>
            <input type="range" class="range-slider" id="tts-speed"
              min="0.5" max="2" step="0.1" value="${ttsSpeed}">
            <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--color-text-faint);margin-top:4px">
              <span>Slow</span><span id="tts-speed-val">${ttsSpeed}×</span><span>Fast</span>
            </div>
          </div>
          <div style="height:1px;background:var(--color-border-light);margin:12px 0"></div>
          <div>
            <div class="form-label mb-8">Transcription language</div>
            <select class="select input" id="transcribe-lang">
              <option value="en" ${transcribeLang === 'en' ? 'selected' : ''}>English</option>
              <option value="th" ${transcribeLang === 'th' ? 'selected' : ''}>Thai</option>
              <option value="auto" ${transcribeLang === 'auto' ? 'selected' : ''}>Auto-detect (mixed)</option>
            </select>
            <p class="text-xs text-faint mt-8">What language you usually speak when recording. Auto-detect is best if you mix languages.</p>
          </div>
        </div>

        <!-- Daily Reminder -->
        <div class="settings-section-title">Daily Reminder</div>
        <div class="card">
          <div class="settings-row" style="border:none;padding:0">
            <div>
              <div class="settings-row-label">Journal reminder</div>
              <div class="settings-row-sub">A nudge to write each day</div>
            </div>
            <div class="toggle ${reminderEnabled ? 'on' : ''}" id="reminder-toggle"></div>
          </div>
          <div id="reminder-time-row" style="${reminderEnabled ? '' : 'display:none'}">
            <div style="height:1px;background:var(--color-border-light);margin:12px 0"></div>
            <div class="form-label mb-8">Reminder time</div>
            <input type="time" class="input" id="reminder-time" value="${reminderTime}">
            ${!notifSupported ? `<p class="text-xs text-faint mt-8">Notifications not supported in this browser.</p>` :
              !notifGranted ? `
                <button class="btn btn-secondary btn-sm mt-12" id="enable-notifs-btn">Enable notifications</button>
                <p class="text-xs text-faint mt-8">Tap to allow Nook to remind you</p>
              ` : `<p class="text-xs text-faint mt-8">✓ Notifications on — you'll be reminded when the app is open past ${reminderTime}</p>`
            }
          </div>
        </div>

        <!-- API Key -->
        <div class="settings-section-title">AI Integration</div>
        <div class="card">
          <div class="form-label mb-8">Groq API Key</div>
          <div class="api-key-input-wrap">
            <input type="password" class="input" id="api-key-input"
              value=""
              placeholder="${apiKeySet ? '•••••••• saved — type to replace' : 'gsk_...'}" autocomplete="off">
            <span class="api-key-show-btn" id="api-key-show">Show</span>
          </div>
          <p class="text-xs text-faint mt-8">
            ${apiKeySet ? '✓ A key is saved. ' : ''}Get a free key at <a href="https://console.groq.com" target="_blank" style="color:var(--color-primary)">console.groq.com</a>
          </p>
          <button class="btn btn-primary btn-sm mt-12" id="save-api-key">Save key</button>
        </div>

        <!-- Mood cleanup -->
        <div class="settings-section-title">Mood cleanup</div>
        <div class="card">
          <p class="text-sm" style="margin-bottom:10px">
            Some old entries have <strong>5/10</strong> ratings the AI guessed at when it
            actually didn't know. This clears those (only AI-rated ones — your own
            confirmed ratings stay).
          </p>
          <div id="mood-cleanup-preview" style="font-size:0.8rem;color:var(--color-text-muted);margin-bottom:10px"></div>
          <button class="btn btn-secondary btn-sm" id="mood-cleanup-btn">Clean up default moods</button>
        </div>

        <!-- Analyse missing entries -->
        <div class="settings-section-title">Re-analyse entries</div>
        <div class="card">
          <p class="text-sm" style="margin-bottom:10px">
            Some entries were saved without AI analysis (no summary, themes, or activities).
            This fills them in — it paces itself and falls back to a faster model if Groq is busy.
          </p>
          <button class="btn btn-secondary btn-sm" id="analyze-missing-btn">Analyse missing entries</button>
          <div id="analyze-missing-result" style="font-size:0.8rem;color:var(--color-text-muted);margin-top:8px"></div>
        </div>

        <!-- Tag / Theme management -->
        <div class="settings-section-title">Manage tags &amp; themes</div>
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
            <select class="select input" id="tag-field" style="flex:1">
              <option value="tags">Tags</option>
              <option value="key_themes">Themes</option>
              <option value="life_areas">Life areas</option>
            </select>
            <button class="btn btn-secondary btn-sm" id="tag-refresh">Refresh</button>
          </div>
          <div id="tag-list-container">
            <p class="text-sm text-muted">Loading…</p>
          </div>
        </div>

        <!-- Orbit integration -->
        <div class="settings-section-title">Orbit life-map</div>
        <div class="card">
          <p class="text-sm" style="margin-bottom:10px">
            Push all your people into <strong>Orbit</strong> as nodes. New/edited people
            sync automatically — this button does a full backfill.
          </p>
          <button class="btn btn-secondary btn-sm" id="orbit-sync-btn">Sync all people to Orbit</button>
          <div id="orbit-sync-result" style="font-size:0.8rem;color:var(--color-text-muted);margin-top:6px"></div>
        </div>

        <!-- Export -->
        <div class="settings-section-title">Data</div>
        <div class="card">
          <div class="settings-row" style="border:none;padding:0;margin-bottom:10px">
            <div>
              <div class="settings-row-label">Export as JSON</div>
              <div class="settings-row-sub">Full backup of all entries and people</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="export-json-btn">Export</button>
          </div>
          <div class="settings-row" style="border:none;padding:0">
            <div>
              <div class="settings-row-label">Export as PDF</div>
              <div class="settings-row-sub">Coming soon</div>
            </div>
            <button class="btn btn-secondary btn-sm" disabled>Soon</button>
          </div>
        </div>

        <!-- Notes: ideas to upgrade + bugs found -->
        <div class="settings-section-title">💡 Ideas &amp; Bugs</div>
        <div class="card">
          <p class="text-sm text-muted" style="margin-bottom:10px">
            Jot down ideas to upgrade Nook or bugs you've spotted. Tick them off when handled.
          </p>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
            <select class="select input" id="note-type" style="flex:0 0 auto;width:auto">
              <option value="idea">💡 Idea</option>
              <option value="bug">🐛 Bug</option>
            </select>
            <input type="text" class="input" id="note-input" placeholder="What's on your mind?" maxlength="280" style="flex:1">
            <button class="btn btn-primary btn-sm" id="note-add">Add</button>
          </div>
          <div id="notes-list"></div>
        </div>

        <!-- Captured reports (auto errors + manual feedback) -->
        <div class="settings-section-title">🐞 Captured reports</div>
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <p class="text-sm text-muted" style="margin:0">Errors and feedback captured by the app. ✓ = forwarded to Orbit.</p>
            <button class="btn btn-secondary btn-sm" id="reports-refresh">Refresh</button>
          </div>
          <div id="reports-list"><p class="text-sm text-muted">Loading…</p></div>
        </div>

        <!-- Roadmap -->
        <div class="settings-section-title">Coming Soon</div>
        <div class="roadmap-list">
          ${roadmapItem('💬', 'Daily prompt / question of the day')}
          ${roadmapItem('🎙️', 'App voice personality (calm coach vs. friend)')}
          ${roadmapItem('☁️', 'Word clouds from your entries')}
          ${roadmapItem('💕', 'Richer guided love life prompts')}
          ${roadmapItem('🎨', 'Expanded theme customisation')}
          ${roadmapItem('📊', 'Compare weeks UI polish')}
        </div>

        <!-- Version -->
        <p class="text-xs text-faint" style="text-align:center;margin-top:32px;padding-bottom:8px">
          Nook v1.0.0 · Made with 🌿 just for you
        </p>
      </div>
    `;

    // Theme swatches
    container.querySelectorAll('.theme-swatch').forEach(swatch => {
      swatch.addEventListener('click', async () => {
        const t = swatch.dataset.theme;
        applyTheme(t);
        container.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        try { await api.put('/api/settings/theme', { value: t }); } catch {}
      });
    });

    // TTS toggle
    let ttsState = ttsEnabled;
    const ttsToggle = container.querySelector('#tts-toggle');
    ttsToggle.addEventListener('click', async () => {
      ttsState = !ttsState;
      ttsToggle.classList.toggle('on', ttsState);
      AppState.ttsEnabled = ttsState;
      try { await api.put('/api/settings/tts_enabled', { value: ttsState }); } catch {}
    });

    // TTS speed
    const speedSlider = container.querySelector('#tts-speed');
    const speedVal    = container.querySelector('#tts-speed-val');
    speedSlider.addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      speedVal.textContent = val + '×';
      AppState.ttsSpeed = val;
    });
    speedSlider.addEventListener('change', async e => {
      try { await api.put('/api/settings/tts_speed', { value: parseFloat(e.target.value) }); } catch {}
    });

    // Transcription language
    container.querySelector('#transcribe-lang')?.addEventListener('change', async e => {
      try {
        await api.put('/api/settings/transcribe_language', { value: e.target.value });
        showToast('Transcription language saved ✓', 'success');
      } catch {
        showToast('Could not save', 'error');
      }
    });

    // API key show/hide
    const apiInput = container.querySelector('#api-key-input');
    container.querySelector('#api-key-show').addEventListener('click', function() {
      apiInput.type = apiInput.type === 'password' ? 'text' : 'password';
      this.textContent = apiInput.type === 'password' ? 'Show' : 'Hide';
    });

    // Save API key — empty means "leave the saved one as-is" (the field never
    // pre-fills the real key anymore, so saving blank must not wipe it).
    container.querySelector('#save-api-key').addEventListener('click', async () => {
      const key = apiInput.value.trim();
      if (!key) { showToast('Type a key to save', ''); return; }
      try {
        await api.put('/api/settings/groq_api_key', { value: key });
        apiInput.value = '';
        showToast('API key saved ✓', 'success');
      } catch {
        showToast('Could not save key', 'error');
      }
    });

    // Daily reminder toggle
    let reminderState = reminderEnabled;
    const reminderToggle = container.querySelector('#reminder-toggle');
    const reminderTimeRow = container.querySelector('#reminder-time-row');
    reminderToggle?.addEventListener('click', async () => {
      reminderState = !reminderState;
      reminderToggle.classList.toggle('on', reminderState);
      reminderTimeRow.style.display = reminderState ? '' : 'none';
      try { await api.put('/api/settings/reminder_enabled', { value: reminderState }); } catch {}
      if (reminderState) scheduleReminder({ reminder_enabled: true, reminder_time: container.querySelector('#reminder-time')?.value }).catch(() => {});
    });

    // Reminder time change
    container.querySelector('#reminder-time')?.addEventListener('change', async e => {
      try { await api.put('/api/settings/reminder_time', { value: e.target.value }); } catch {}
    });

    // Enable notifications button
    container.querySelector('#enable-notifs-btn')?.addEventListener('click', async () => {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        showToast('Notifications enabled ✓', 'success');
        // Re-mount to update UI
        await this.mount(this.container);
        scheduleReminder({ reminder_enabled: true, reminder_time: reminderTime }).catch(() => {});
      } else {
        showToast('Notifications blocked — check browser settings', 'error');
      }
    });

    // Save user name
    container.querySelector('#save-user-name').addEventListener('click', async () => {
      const name = container.querySelector('#user-name-input').value.trim() || 'there';
      try {
        await api.put('/api/settings/user_name', { value: name });
        showToast(`Got it — hi ${name} 🌿`, 'success');
      } catch {
        showToast('Could not save name', 'error');
      }
    });

    // Orbit one-shot sync — POSTs every Nook person as a node to Orbit's ingest
    const orbitBtn = container.querySelector('#orbit-sync-btn');
    const orbitResult = container.querySelector('#orbit-sync-result');
    orbitBtn?.addEventListener('click', async () => {
      orbitBtn.disabled = true;
      orbitBtn.textContent = 'Syncing…';
      orbitResult.textContent = '';
      try {
        const r = await api.post('/api/sync-orbit', {});
        if (r.skipped) {
          orbitResult.textContent = '⚠️ Orbit not configured (ORBIT_URL / ORBIT_INGEST_SECRET missing on the server)';
        } else if (r.ok) {
          orbitResult.textContent = `✓ Synced ${r.count} person${r.count !== 1 ? 's' : ''}`;
        } else {
          orbitResult.textContent = `❌ Sync failed (${r.error || r.status || 'unknown'})`;
        }
      } catch {
        orbitResult.textContent = '❌ Sync failed — check console';
      }
      orbitBtn.disabled = false;
      orbitBtn.textContent = 'Sync all people to Orbit';
    });

    // Mood cleanup — preview + commit
    const moodPreviewEl = container.querySelector('#mood-cleanup-preview');
    const moodBtn       = container.querySelector('#mood-cleanup-btn');
    const loadMoodPreview = async () => {
      try {
        const p = await api.get('/api/entries/mood-cleanup/preview');
        const totalTouched = (p.overall_5s || 0) + (p.entries_with_3plus_sub_5s || 0);
        if (totalTouched === 0) {
          moodPreviewEl.textContent = '✓ Nothing to clean up — your mood data looks healthy.';
          moodBtn.disabled = true;
        } else {
          moodPreviewEl.innerHTML = `Will clear <strong>${p.overall_5s}</strong> "overall 5/10" rating${p.overall_5s !== 1 ? 's' : ''} and <strong>${p.entries_with_3plus_sub_5s}</strong> entr${p.entries_with_3plus_sub_5s !== 1 ? 'ies' : 'y'} where the AI picked 5/10 on 3+ dimensions.`;
          moodBtn.disabled = false;
        }
      } catch {
        moodPreviewEl.textContent = '';
      }
    };
    moodBtn.addEventListener('click', async () => {
      if (!confirm('Clear AI-guessed mood values from old entries?\n\nYour own confirmed ratings will NOT be touched.')) return;
      moodBtn.disabled = true;
      moodBtn.textContent = 'Cleaning…';
      try {
        const r = await api.post('/api/entries/mood-cleanup', {});
        showToast(`Cleaned ${r.overall_nulled} overall + ${r.entries_sub_dims_nulled} entries ✓`, 'success');
        await loadMoodPreview();
      } catch {
        showToast('Cleanup failed', 'error');
      }
      moodBtn.textContent = 'Clean up default moods';
    });
    loadMoodPreview();

    // Analyse missing entries — fills in any entry saved without AI analysis.
    // Paces itself; the server falls back to a faster model when Groq throttles.
    const amBtn = container.querySelector('#analyze-missing-btn');
    const amResult = container.querySelector('#analyze-missing-result');
    amBtn?.addEventListener('click', async () => {
      amBtn.disabled = true;
      amResult.textContent = 'Finding entries…';
      let all = [];
      try { all = await api.get('/api/entries?limit=365'); }
      catch { amResult.textContent = 'Could not load entries.'; amBtn.disabled = false; return; }
      const missing = all.filter(e => !e.first_person_summary && !e.ai_summary);
      if (!missing.length) { amResult.textContent = '✓ All entries are analysed.'; amBtn.disabled = false; return; }

      let done = 0, failed = 0;
      for (let i = 0; i < missing.length; i++) {
        amResult.textContent = `Analysing ${i + 1} of ${missing.length}…`;
        try {
          const full = await api.get(`/api/entries/${missing[i].id}`);
          const content = (full.user_edited_content || full.cleaned_content || full.raw_transcript || '').trim();
          if (!content) continue;
          const a = await api.post('/api/ai/analyze', { content });
          const payload = {
            ai_summary: a.ai_summary || null,
            first_person_summary: a.first_person_summary || null,
            key_themes: a.key_themes || [],
            action_items: a.action_items || [],
            important_today: a.important_today || null,
            life_areas: a.life_areas || [],
            tags: a.suggested_tags || [],
            activities: Array.isArray(a.activities) ? a.activities : [],
            detected_people: Array.isArray(a.people_mentioned) ? a.people_mentioned : [],
          };
          // Only fill mood when the entry has none — never clobber a set rating.
          if (full.mood_overall == null && a.mood) {
            const m = a.mood;
            Object.assign(payload, {
              mood_energy: m.energy ?? null, mood_happiness: m.happiness ?? null,
              mood_anxiety: m.anxiety ?? null, mood_confidence: m.confidence ?? null,
              mood_motivation: m.motivation ?? null, mood_social_battery: m.social_battery ?? null,
              mood_physical: m.physical ?? null, mood_focus: m.focus ?? null,
              mood_overall: m.overall ?? null, mood_source: 'ai_detected',
            });
          }
          await api.put(`/api/entries/${missing[i].id}`, payload);
          done++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 700)); // gentle pacing
      }
      amResult.textContent = `Done — analysed ${done}${failed ? `, ${failed} still failed (try again in a bit)` : ''}.`;
      showToast(failed ? `Analysed ${done}, ${failed} failed` : `Analysed ${done} ✓`, failed ? 'error' : 'success');
      amBtn.disabled = false;
    });

    // Tag/theme management
    const tagField   = container.querySelector('#tag-field');
    const tagListEl  = container.querySelector('#tag-list-container');
    const loadTags = async () => {
      tagListEl.innerHTML = '<p class="text-sm text-muted">Loading…</p>';
      try {
        const tags = await api.get(`/api/tags?field=${tagField.value}`);
        if (!tags.length) {
          tagListEl.innerHTML = '<p class="text-sm text-faint">No tags yet.</p>';
          return;
        }
        tagListEl.innerHTML = `<div class="tag-manage-list">${tags.map(t => `
          <div class="tag-manage-row" data-tag="${t.tag.replace(/"/g, '&quot;')}">
            <span class="tag-manage-name">${t.tag}</span>
            <span class="tag-manage-count">${t.count}×</span>
            <button class="btn btn-ghost btn-sm tag-rename-btn">Rename</button>
            <button class="btn btn-ghost btn-sm tag-delete-btn">×</button>
          </div>`).join('')}</div>`;

        tagListEl.querySelectorAll('.tag-rename-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const tag = btn.closest('.tag-manage-row').dataset.tag;
            const next = prompt(`Rename "${tag}" to:`, tag);
            if (!next || next.trim() === '' || next === tag) return;
            api.put('/api/tags/rename', { field: tagField.value, from: tag, to: next.trim() })
              .then(r => { showToast(`Renamed ${r.updated} entries ✓`, 'success'); loadTags(); })
              .catch(() => showToast('Could not rename', 'error'));
          });
        });
        tagListEl.querySelectorAll('.tag-delete-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const tag = btn.closest('.tag-manage-row').dataset.tag;
            if (!confirm(`Delete "${tag}" from all entries?`)) return;
            api.delete(`/api/tags?field=${tagField.value}&tag=${encodeURIComponent(tag)}`)
              .then(r => { showToast(`Removed from ${r.updated} entries ✓`, 'success'); loadTags(); })
              .catch(() => showToast('Could not delete', 'error'));
          });
        });
      } catch {
        tagListEl.innerHTML = '<p class="text-sm text-faint">Could not load.</p>';
      }
    };
    tagField.addEventListener('change', loadTags);
    container.querySelector('#tag-refresh').addEventListener('click', loadTags);
    loadTags();

    // JSON export
    container.querySelector('#export-json-btn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = '/api/export/json';
      a.download = `nook-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
    });

    // Ideas & Bugs checklist — stored as a single JSONB array under the
    // `dev_notes` settings key (no dedicated table needed).
    this.notes = Array.isArray(settings.dev_notes) ? settings.dev_notes : [];
    this.notesListEl = container.querySelector('#notes-list');
    this.renderNotes();
    const noteInput = container.querySelector('#note-input');
    const noteType  = container.querySelector('#note-type');
    const addNote = () => {
      const text = noteInput.value.trim();
      if (!text) return;
      const type = noteType.value === 'bug' ? 'bug' : 'idea';
      this.notes.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text,
        type,
        done: false,
        created_at: new Date().toISOString(),
      });
      noteInput.value = '';
      this.renderNotes();
      this.saveNotes();
      // Also forward as a manual report (always sent; queued offline if needed).
      reportManual({ message: `[${type}] ${text}`, context: { type, kind: 'manual' } });
    };
    container.querySelector('#note-add').addEventListener('click', addNote);
    noteInput.addEventListener('keydown', e => { if (e.key === 'Enter') addNote(); });

    // Captured reports viewer
    const reportsList = container.querySelector('#reports-list');
    const loadReports = async () => {
      reportsList.innerHTML = '<p class="text-sm text-muted">Loading…</p>';
      try {
        const reports = await api.get('/api/reports?limit=50');
        if (!reports.length) {
          reportsList.innerHTML = '<p class="text-sm text-faint">No reports captured yet.</p>';
          return;
        }
        reportsList.innerHTML = reports.map(r => {
          const ctx = r.context || {};
          const where = ctx.path || ctx.screen || '';
          const sub = [ctx.kind, where].filter(Boolean).map(escHtml).join(' · ');
          return `
            <div class="report-row">
              <div class="report-row-head">
                <span class="report-badge report-${escHtml(r.source)}">${escHtml(r.source || '?')}</span>
                <span class="report-sent">${r.orbit_sent ? '✓ sent' : '⏳ pending'}</span>
                <span class="report-time">${timeAgo(r.created_at)}</span>
              </div>
              <div class="report-msg">${escHtml(r.message || '')}</div>
              ${sub ? `<div class="report-ctx">${sub}</div>` : ''}
            </div>`;
        }).join('');
      } catch {
        reportsList.innerHTML = '<p class="text-sm text-faint">Could not load reports.</p>';
      }
    };
    container.querySelector('#reports-refresh').addEventListener('click', loadReports);
    loadReports();
  }

  renderNotes() {
    if (!this.notesListEl) return;
    if (!this.notes.length) {
      this.notesListEl.innerHTML = '<p class="text-sm text-faint">Nothing yet — add an idea or a bug above.</p>';
      return;
    }
    // Open items first, then done; newest first within each group.
    const sorted = [...this.notes].sort((a, b) =>
      (a.done ? 1 : 0) - (b.done ? 1 : 0) ||
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );
    this.notesListEl.innerHTML = `<div class="note-list">${sorted.map(n => `
      <div class="note-item ${n.done ? 'done' : ''}" data-id="${n.id}">
        <button class="note-check" title="Toggle done">${n.done ? '✓' : ''}</button>
        <span class="note-type-badge">${n.type === 'bug' ? '🐛' : '💡'}</span>
        <span class="note-text">${escHtml(n.text)}</span>
        <button class="note-delete" title="Delete">×</button>
      </div>`).join('')}</div>`;

    this.notesListEl.querySelectorAll('.note-item').forEach(el => {
      const id = el.dataset.id;
      el.querySelector('.note-check').addEventListener('click', () => this.toggleNote(id));
      el.querySelector('.note-delete').addEventListener('click', () => this.deleteNote(id));
    });
  }

  toggleNote(id) {
    const n = this.notes.find(x => x.id === id);
    if (!n) return;
    n.done = !n.done;
    this.renderNotes();
    this.saveNotes();
  }

  deleteNote(id) {
    this.notes = this.notes.filter(x => x.id !== id);
    this.renderNotes();
    this.saveNotes();
  }

  async saveNotes() {
    try {
      await api.put('/api/settings/dev_notes', { value: this.notes });
    } catch {
      showToast('Could not save note', 'error');
    }
  }

  destroy() {}
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function themeSwatch(id, bg, accent, label, current) {
  return `
    <div class="theme-swatch ${current === id ? 'active' : ''}" data-theme="${id}">
      <div class="theme-swatch-preview" style="background:${bg}">
        <div style="width:20px;height:20px;border-radius:50%;background:${accent}"></div>
      </div>
      <div class="theme-swatch-label">${label}</div>
    </div>`;
}

function roadmapItem(icon, text) {
  return `<div class="roadmap-item"><span class="roadmap-icon">${icon}</span><span class="roadmap-text">${text}</span></div>`;
}
