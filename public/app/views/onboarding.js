import { api, showToast, scheduleReminder } from '../app.js';

// OnboardingView — first-run setup (name → API key → optional reminder).
// Shown when settings indicate a fresh install (no user_name set, no API key).
// User can also re-run from Settings later.
export class OnboardingView {
  constructor() {
    this.step = 0; // 0 name, 1 api, 2 reminder, 3 done
    this.state = { name: '', apiKey: '', reminderEnabled: false, reminderTime: '21:00' };
    this.container = null;
  }

  async mount(container) {
    this.container = container;
    // Pre-fill with anything already saved (in case they re-ran)
    try {
      const s = await api.get('/api/settings');
      this.state.name = (typeof s.user_name === 'string' ? s.user_name : '').replace(/^"|"$/g, '');
      if (this.state.name === 'there') this.state.name = '';
      this.state.apiKey = (typeof s.groq_api_key === 'string' ? s.groq_api_key : '').replace(/^"|"$/g, '');
      if (this.state.apiKey === 'null') this.state.apiKey = '';
    } catch {}
    this.render();
  }

  render() {
    const c = this.container;
    c.innerHTML = `
      <div class="onboarding-view">
        <div class="onboarding-card">
          <div class="onboarding-progress">
            ${[0, 1, 2].map(i => `<div class="onboarding-dot ${i === this.step ? 'active' : i < this.step ? 'done' : ''}"></div>`).join('')}
          </div>
          <div id="onboarding-step"></div>
        </div>
      </div>`;
    this.renderStep();
  }

  renderStep() {
    const slot = this.container.querySelector('#onboarding-step');
    if (this.step === 0) slot.innerHTML = this.stepName();
    else if (this.step === 1) slot.innerHTML = this.stepApi();
    else if (this.step === 2) slot.innerHTML = this.stepReminder();
    else slot.innerHTML = this.stepDone();
    this.wireStep();
  }

  stepName() {
    return `
      <div class="onboarding-emoji">🌿</div>
      <h1>Welcome to Nook</h1>
      <p class="onboarding-sub">A little corner of the internet that's just yours.</p>
      <p class="onboarding-sub">What should I call you?</p>
      <input type="text" class="input onboarding-input" id="ob-name" value="${this.state.name}" placeholder="Your name or nickname" maxlength="40" autocomplete="given-name">
      <button class="btn btn-primary btn-lg onboarding-next" id="ob-next">Continue →</button>
      <button class="btn btn-ghost btn-sm onboarding-skip" id="ob-skip-all">Skip setup — I'll configure later</button>`;
  }

  stepApi() {
    return `
      <div class="onboarding-emoji">✨</div>
      <h1>Hi ${this.state.name || 'there'}.</h1>
      <p class="onboarding-sub">Nook uses an AI to summarise your entries, spot patterns, and ask warm follow-up questions.</p>
      <p class="onboarding-sub">Paste your Groq API key — it's <strong>free</strong> and takes 30 seconds at <a href="https://console.groq.com" target="_blank">console.groq.com</a>.</p>
      <input type="password" class="input onboarding-input" id="ob-api" value="${this.state.apiKey}" placeholder="gsk_..." autocomplete="off">
      <p class="text-xs text-faint" style="margin-top:6px">You can skip this — Nook still works, just without AI features.</p>
      <div class="onboarding-actions">
        <button class="btn btn-ghost" id="ob-back">← Back</button>
        <button class="btn btn-primary btn-lg" id="ob-next">Continue →</button>
      </div>`;
  }

  stepReminder() {
    const notifSupported = 'Notification' in window;
    return `
      <div class="onboarding-emoji">🔔</div>
      <h1>One nudge a day?</h1>
      <p class="onboarding-sub">A small reminder helps build the habit. Nothing pushy — just a single notification.</p>
      <label class="onboarding-toggle-row">
        <input type="checkbox" id="ob-reminder-on" ${this.state.reminderEnabled ? 'checked' : ''}>
        <span>Remind me to journal</span>
      </label>
      <div id="ob-reminder-time-wrap" style="${this.state.reminderEnabled ? '' : 'display:none'}">
        <label class="form-label" style="margin-top:8px">What time?</label>
        <input type="time" class="input onboarding-input" id="ob-reminder-time" value="${this.state.reminderTime}">
        ${!notifSupported ? '<p class="text-xs text-faint mt-8">Notifications not supported in this browser.</p>' : ''}
      </div>
      <div class="onboarding-actions">
        <button class="btn btn-ghost" id="ob-back">← Back</button>
        <button class="btn btn-primary btn-lg" id="ob-finish">Finish setup ✨</button>
      </div>`;
  }

  stepDone() {
    return `
      <div class="onboarding-emoji">🌿</div>
      <h1>You're set, ${this.state.name || 'friend'}.</h1>
      <p class="onboarding-sub">Your nook is ready. Add your first entry whenever you'd like.</p>
      <a href="#new-entry/text" class="btn btn-primary btn-lg onboarding-next">Start writing</a>
      <a href="#home" class="btn btn-ghost btn-sm onboarding-skip">Just take me home</a>`;
  }

  wireStep() {
    const c = this.container;
    c.querySelector('#ob-back')?.addEventListener('click', () => { this.step--; this.renderStep(); });
    c.querySelector('#ob-skip-all')?.addEventListener('click', async () => {
      await this.savePartial();
      await this.markComplete();
      location.hash = '#home';
    });

    if (this.step === 0) {
      const input = c.querySelector('#ob-name');
      input?.focus();
      input?.addEventListener('keydown', e => { if (e.key === 'Enter') c.querySelector('#ob-next').click(); });
      c.querySelector('#ob-next').addEventListener('click', () => {
        this.state.name = input.value.trim() || 'there';
        this.step = 1;
        this.render();
      });
    } else if (this.step === 1) {
      const input = c.querySelector('#ob-api');
      input?.focus();
      c.querySelector('#ob-next').addEventListener('click', () => {
        this.state.apiKey = input.value.trim();
        this.step = 2;
        this.render();
      });
    } else if (this.step === 2) {
      const cb = c.querySelector('#ob-reminder-on');
      const wrap = c.querySelector('#ob-reminder-time-wrap');
      cb?.addEventListener('change', () => {
        this.state.reminderEnabled = cb.checked;
        wrap.style.display = cb.checked ? '' : 'none';
      });
      c.querySelector('#ob-reminder-time')?.addEventListener('change', e => {
        this.state.reminderTime = e.target.value;
      });
      c.querySelector('#ob-finish').addEventListener('click', async () => {
        c.querySelector('#ob-finish').disabled = true;
        c.querySelector('#ob-finish').textContent = 'Saving…';
        await this.savePartial();
        if (this.state.reminderEnabled) {
          await api.put('/api/settings/reminder_enabled', { value: true }).catch(() => {});
          await api.put('/api/settings/reminder_time', { value: this.state.reminderTime }).catch(() => {});
          // Request notification permission
          if ('Notification' in window && Notification.permission !== 'granted') {
            try { await Notification.requestPermission(); } catch {}
          }
          scheduleReminder({ reminder_enabled: true, reminder_time: this.state.reminderTime }).catch(() => {});
        }
        await this.markComplete();
        this.step = 3;
        this.render();
      });
    }
  }

  async savePartial() {
    try {
      const updates = {};
      if (this.state.name) updates.user_name = this.state.name;
      if (this.state.apiKey) updates.groq_api_key = this.state.apiKey;
      if (Object.keys(updates).length) {
        await api.put('/api/settings', updates);
      }
    } catch (err) {
      showToast('Could not save settings — they may be lost on refresh', 'error');
    }
  }

  async markComplete() {
    try { await api.put('/api/settings/onboarding_complete', { value: true }); } catch {}
  }

  destroy() {}
}
