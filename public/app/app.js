// ============================================================
// Nook — App Shell & Router
// ============================================================

import { HomeView }     from './views/home.js';
import { EntryView }    from './views/entry.js';
import { CalendarView } from './views/calendar.js';
import { InsightsView } from './views/insights.js';
import { PeopleView }   from './views/people.js';
import { PersonView }   from './views/person.js';
import { SettingsView } from './views/settings.js';
import { SearchView }   from './views/search.js';
import { DayView }      from './views/day.js';
import { OnboardingView } from './views/onboarding.js';

// ── Global state ───────────────────────────────────────────
export const AppState = {
  theme: 'warm-earthy',
  ttsEnabled: true,
  ttsSpeed: 1,
  streakCount: 0,
  initialized: false,
};

// ── API helper ─────────────────────────────────────────────
export const api = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw Object.assign(new Error(e.error || `HTTP ${res.status}`), e); }
    return res.json();
  },
  async post(path, data) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw Object.assign(new Error(e.error || `HTTP ${res.status}`), e); }
    return res.json();
  },
  async postForm(path, formData) {
    const res = await fetch(path, { method: 'POST', body: formData });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw Object.assign(new Error(e.error || `HTTP ${res.status}`), e); }
    return res.json();
  },
  async put(path, data) {
    const res = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw Object.assign(new Error(e.error || `HTTP ${res.status}`), e); }
    return res.json();
  },
  async delete(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw Object.assign(new Error(e.error || `HTTP ${res.status}`), e); }
    return res.json();
  },
};

// ── Toast notifications ─────────────────────────────────────
export function showToast(message, type = '') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' toast-' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ── TTS helper ──────────────────────────────────────────────
// Mobile browsers (iOS especially) are picky about speech synthesis:
//   - Voices may not be loaded yet on first call
//   - cancel() before speak() sometimes leaves engine in a bad state on iOS
//   - speak() only works if there was a recent user gesture (see primeTTS())
// We wait for voices to load (briefly) and avoid the eager cancel.
let _voicesReady = null;
function waitForVoices(timeoutMs = 800) {
  if (_voicesReady) return _voicesReady;
  _voicesReady = new Promise(resolve => {
    if (!window.speechSynthesis) return resolve(false);
    const v = window.speechSynthesis.getVoices();
    if (v && v.length) return resolve(true);
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(true); } };
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeoutMs); // hard timeout — speak anyway
  });
  return _voicesReady;
}

export async function speak(text, rate = null) {
  if (!AppState.ttsEnabled) return;
  if (!window.speechSynthesis || !text) return;
  await waitForVoices();
  // Don't cancel pre-existing utterances on iOS — that can desync the engine.
  // If something's actively speaking, just queue ours after it.
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = rate ?? AppState.ttsSpeed ?? 1;
  utter.pitch = 1;
  utter.volume = 1;
  try {
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn('TTS failed:', err.message);
  }
}

// ── Theme ───────────────────────────────────────────────────
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  AppState.theme = theme;
  // Update meta theme-color
  const themeColors = { 'warm-earthy': '#c8a97e', 'dark-intimate': '#141210', 'clean-minimal': '#f8f8f7' };
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme] || '#c8a97e');
}

// ── Daily reminder ──────────────────────────────────────────
let _swReg = null;

export async function showLocalNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: '/icons/icon.svg', badge: '/icons/icon.svg', tag: 'nook-reminder' };
  if (_swReg) { await _swReg.showNotification(title, opts); }
  else { new Notification(title, opts); }
}

export async function scheduleReminder(settings) {
  if (!settings) return;
  const enabled = settings.reminder_enabled === 'true' || settings.reminder_enabled === true;
  if (!enabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const reminderTime = (settings.reminder_time || '21:00').replace(/"/g, '');
  const [h, m] = reminderTime.split(':').map(Number);
  const now = new Date();
  const trigger = new Date(now);
  trigger.setHours(h, m, 0, 0);

  if (now >= trigger) {
    // Past today's trigger — check if they've journaled today
    try {
      const today = now.toISOString().split('T')[0];
      const entries = await api.get('/api/entries?limit=5').catch(() => []);
      const done = entries.some(e => String(e.date).split('T')[0] === today);
      if (!done) await showLocalNotification('Nook 🌿', "Time to write in your nook — how was your day?");
    } catch {}
  } else {
    // Schedule for later today
    setTimeout(() => scheduleReminder(settings), trigger - now);
  }
}

// ── Streak display ───────────────────────────────────────────
export function updateStreakDisplay(count) {
  AppState.streakCount = count;
  const num = document.getElementById('streak-number');
  if (!num) return;
  if (num.textContent !== String(count)) {
    num.textContent = count;
    num.classList.add('bump');
    setTimeout(() => num.classList.remove('bump'), 600);
  }
  const counter = document.getElementById('streak-counter');
  if (counter) counter.classList.toggle('streak-active', count > 0);
}

// ── Router ──────────────────────────────────────────────────
const routes = {
  'home':     HomeView,
  'new-entry': EntryView,
  'calendar': CalendarView,
  'insights': InsightsView,
  'people':   PeopleView,
  'person':   PersonView,
  'settings': SettingsView,
  'search':   SearchView,
  'day':      DayView,
  'onboarding': OnboardingView,
};

let currentView = null;

// Redirects to onboarding on first launch (only once).
// Bounded by a hard 3s timeout — without it, a slow settings fetch would
// block route handling entirely (white screen behind shell). If the check
// times out we err on "not fresh" so the user gets the app, not a forced flow.
let _onboardingChecked = false;
async function maybeRedirectToOnboarding() {
  if (_onboardingChecked) return false;
  _onboardingChecked = true;
  try {
    const s = await Promise.race([
      api.get('/api/settings'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const done = s.onboarding_complete === true || s.onboarding_complete === 'true';
    if (done) return false;
    const name = (typeof s.user_name === 'string' ? s.user_name : '').replace(/^"|"$/g, '');
    const key  = (typeof s.groq_api_key === 'string' ? s.groq_api_key : '').replace(/^"|"$/g, '');
    const isFresh = (!name || name === 'there') && (!key || key === 'null');
    if (isFresh) {
      location.hash = '#onboarding';
      return true;
    }
  } catch {}
  return false;
}

async function handleRoute() {
  const hash = location.hash.slice(1) || 'home';
  const parts = hash.split('/');
  const viewName = parts[0];
  const params = parts.slice(1);

  // First-launch check (only runs once per page load)
  if (viewName !== 'onboarding' && await maybeRedirectToOnboarding()) return;

  const ViewClass = routes[viewName];
  if (!ViewClass) {
    location.hash = '#home';
    return;
  }

  if (currentView && typeof currentView.destroy === 'function') {
    currentView.destroy();
  }

  const container = document.getElementById('app-content');
  container.innerHTML = '<div class="loading-spinner"></div>';
  container.scrollTop = 0;

  // Watchdog: if mount stalls (hung fetch, infinite await), show a recoverable
  // error after 12s instead of leaving the user staring at the spinner / blank.
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⏱️</div>
        <h3>Taking longer than expected</h3>
        <p>Your network or the server might be slow.</p>
        <button class="btn btn-primary btn-sm mt-12" onclick="location.reload()">Reload</button>
        <a href="#home" class="btn btn-ghost btn-sm mt-12">Go home</a>
      </div>`;
  }, 12000);

  try {
    currentView = new ViewClass(params);
    await currentView.mount(container);
    clearTimeout(watchdog);
  } catch (err) {
    clearTimeout(watchdog);
    if (watchdogFired) return; // user already sees the watchdog UI
    console.error('View mount error:', err);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">😕</div>
        <h3>Something went wrong</h3>
        <p>${err.message || 'Could not load this view.'}</p>
        <button class="btn btn-primary btn-sm mt-12" onclick="location.reload()">Reload</button>
        <a href="#home" class="btn btn-ghost btn-sm mt-12">Go home</a>
      </div>`;
  }

  updateNav(viewName);
}

function updateNav(viewName) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
}

// ── Online status ────────────────────────────────────────────
function updateOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.hidden = navigator.onLine;
}

// ── Shell render ─────────────────────────────────────────────
function renderShell() {
  document.getElementById('app-shell').innerHTML = `
    <header class="top-bar">
      <div class="top-bar-logo">
        <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M 7 21 L 7 9 L 19 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="7" cy="9" r="3" fill="currentColor"/>
          <circle cx="7" cy="9" r="5" fill="currentColor" opacity="0.15"/>
        </svg>
        <span>Nook</span>
      </div>
      <div class="top-bar-actions">
        <div class="streak-counter" id="streak-counter">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;color:#e85d04">
            <path d="M12 2c0 0-5 5-5 10a5 5 0 0010 0C17 7 12 2 12 2zm0 14a3 3 0 01-3-3c0-2.5 3-6 3-6s3 3.5 3 6a3 3 0 01-3 3z"/>
          </svg>
          <span id="streak-number">0</span>
        </div>
        <a href="#search" class="top-bar-icon-btn" aria-label="Search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:18px;height:18px">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </a>
        <button class="theme-toggle" id="theme-toggle" title="Cycle theme" aria-label="Toggle theme">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px">
            <circle cx="12" cy="12" r="5"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>
        <a href="#settings" class="top-bar-icon-btn" aria-label="Settings" title="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </a>
      </div>
    </header>

    <div class="offline-banner" id="offline-banner" hidden>
      📡 You're offline — entries will sync when you reconnect
    </div>

    <main id="app-content" class="app-content"></main>

    <nav class="bottom-nav" role="navigation">
      <a class="nav-item" href="#home" data-view="home" aria-label="Home">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
        <span>Home</span>
      </a>
      <a class="nav-item" href="#calendar" data-view="calendar" aria-label="Calendar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span>Calendar</span>
      </a>
      <a class="nav-item nav-item--new" href="#new-entry" data-view="new-entry" aria-label="New entry">
        <div class="nav-new-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </div>
      </a>
      <a class="nav-item" href="#insights" data-view="insights" aria-label="Insights">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="20" x2="18" y2="10"/>
          <line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6"  y1="20" x2="6"  y2="14"/>
        </svg>
        <span>Insights</span>
      </a>
      <a class="nav-item" href="#people" data-view="people" aria-label="People">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87"/>
          <path d="M16 3.13a4 4 0 010 7.75"/>
        </svg>
        <span>People</span>
      </a>
    </nav>
  `;

  // Theme toggle cycle
  const themes = ['warm-earthy', 'dark-intimate', 'clean-minimal'];
  document.getElementById('theme-toggle').addEventListener('click', async () => {
    const idx = themes.indexOf(AppState.theme);
    const next = themes[(idx + 1) % themes.length];
    applyTheme(next);
    try { await api.put('/api/settings/theme', { value: next }); } catch {}
  });
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  try {
    const settings = await api.get('/api/settings');
    if (settings.theme) applyTheme(settings.theme);
    AppState.ttsEnabled = settings.tts_enabled !== false;
    AppState.ttsSpeed = parseFloat(settings.tts_speed) || 1;
    if (settings.streak_count) AppState.streakCount = parseInt(settings.streak_count) || 0;
  } catch (err) {
    console.warn('Could not load settings (DB might be cold starting):', err.message);
  }

  renderShell();
  updateStreakDisplay(AppState.streakCount);
  updateOnlineStatus();

  window.addEventListener('online',  updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  window.addEventListener('hashchange', handleRoute);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => { _swReg = reg; })
      .catch(err => console.warn('SW registration failed:', err));
  }

  // Schedule daily reminder if enabled
  scheduleReminder(settings).catch(() => {});

  // Initial route
  await handleRoute();
  AppState.initialized = true;
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
