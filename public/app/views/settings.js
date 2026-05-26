import { api, showToast, applyTheme, AppState, scheduleReminder } from '../app.js';

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
    const apiKey = typeof settings.groq_api_key === 'string' && settings.groq_api_key !== 'null'
      ? settings.groq_api_key : '';
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
              value="${apiKey}"
              placeholder="gsk_..." autocomplete="off">
            <span class="api-key-show-btn" id="api-key-show">Show</span>
          </div>
          <p class="text-xs text-faint mt-8">
            Get a free key at <a href="https://console.groq.com" target="_blank" style="color:var(--color-primary)">console.groq.com</a>
          </p>
          <button class="btn btn-primary btn-sm mt-12" id="save-api-key">Save key</button>
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

    // API key show/hide
    const apiInput = container.querySelector('#api-key-input');
    container.querySelector('#api-key-show').addEventListener('click', function() {
      apiInput.type = apiInput.type === 'password' ? 'text' : 'password';
      this.textContent = apiInput.type === 'password' ? 'Show' : 'Hide';
    });

    // Save API key
    container.querySelector('#save-api-key').addEventListener('click', async () => {
      const key = apiInput.value.trim();
      try {
        await api.put('/api/settings/groq_api_key', { value: key });
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

    // JSON export
    container.querySelector('#export-json-btn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = '/api/export/json';
      a.download = `nook-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
    });
  }

  destroy() {}
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
