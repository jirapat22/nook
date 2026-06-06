import { api, showToast, updateStreakDisplay } from '../app.js';

export class HomeView {
  constructor() {}

  async mount(container) {
    // Compute today FIRST so it's available in all subsequent calls
    const today = new Date().toISOString().split('T')[0];

    const [entries, streakData, onThisDay, settings, pendingActions] = await Promise.all([
      api.get('/api/entries?limit=10').catch(() => []),
      api.get('/api/insights/streaks').catch(() => ({ current: 0 })),
      api.get(`/api/entries/on-this-day?date=${today}`).catch(() => []),
      api.get('/api/settings').catch(() => ({})),
      api.get('/api/entries/action-items/pending?days=14&limit=3').catch(() => []),
    ]);

    updateStreakDisplay(streakData.current || 0);

    const userName = typeof settings.user_name === 'string'
      ? settings.user_name.replace(/^"|"$/g, '')
      : 'there';

    const hour = new Date().getHours();
    const greeting =
      hour < 5  ? 'Good night' :
      hour < 12 ? 'Good morning' :
      hour < 17 ? 'Good afternoon' :
      hour < 21 ? 'Good evening' : 'Good night';

    // Group entries by date — one card per day, tap to open the Day view.
    // Replaces the previous "jumbled entries on home" approach.
    const normDate = d => String(d).split('T')[0];
    const byDay = new Map(); // YYYY-MM-DD -> entries[]
    for (const e of entries) {
      const k = normDate(e.date);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    // Sort each day's entries latest-first (created_at desc)
    for (const list of byDay.values()) {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    // Sort days latest-first
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const todayHasEntries = byDay.has(today);

    container.innerHTML = `
      <div class="home-view">
        <div class="greeting-section">
          <h2>${greeting}, ${escHtml(userName)} ✨</h2>
          <p class="greeting-sub">${getDateLabel()}</p>
        </div>

        ${streakData.current > 0 ? `
        <div class="streak-widget">
          <div class="streak-widget-info">
            <h3>Current streak</h3>
            <div class="streak-number-big">${streakData.current} day${streakData.current !== 1 ? 's' : ''}</div>
            ${streakData.longest > streakData.current ? `<div style="font-size:0.75rem;opacity:0.8;margin-top:2px">Best: ${streakData.longest}</div>` : ''}
          </div>
          <div class="streak-widget-icon">🔥</div>
        </div>` : ''}

        ${!todayHasEntries ? `
          <a href="#day/${today}" class="day-card day-card-empty">
            <div class="day-card-header">
              <div class="day-card-title">Today</div>
              <div class="day-card-count">No entries yet</div>
            </div>
            <p class="day-card-snippet">Tap to start your day · or use the bar below</p>
          </a>` : ''}

        ${days.length ? `
          <div class="day-cards-list">
            ${days.map(([d, list]) => dayCard(d, list, today)).join('')}
          </div>` : !todayHasEntries ? '' : ''}

        ${pendingActions.length ? `
        <div class="section-header mt-16">
          <h3>✅ Still on your mind?</h3>
        </div>
        <div class="pending-actions-list">
          ${pendingActions.map(a => pendingActionCard(a)).join('')}
        </div>` : ''}

        ${onThisDay.length ? `
        <div class="section-header mt-16">
          <h3>📅 On this day</h3>
        </div>
        <div class="on-this-day-list">
          ${onThisDay.map(e => onThisDayCard(e)).join('')}
        </div>` : ''}

        <!-- Sticky quick-action bar: Text left, Voice right -->
        <div class="home-quick-bar">
          <button class="home-quick-btn" id="text-entry-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            <span>Text</span>
          </button>
          <button class="home-quick-btn home-quick-voice" id="voice-entry-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
            <span>Voice</span>
          </button>
        </div>
      </div>
    `;

    // Event listeners
    container.querySelector('#voice-entry-btn').addEventListener('click', () => {
      location.hash = '#new-entry/voice';
    });
    container.querySelector('#text-entry-btn').addEventListener('click', () => {
      location.hash = '#new-entry/text';
    });

    container.querySelectorAll('.entry-preview-card').forEach(card => {
      card.addEventListener('click', () => {
        location.hash = `#new-entry/${card.dataset.id}`;
      });
    });

    // Pending action items: three buttons (Done / Still going / Not doing)
    container.querySelectorAll('.pending-action').forEach(item => {
      item.querySelectorAll('.pending-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const state = btn.dataset.state;
          const entryId = item.dataset.entryId;
          const text = item.dataset.text;
          item.classList.add('done'); // reuse fade animation
          try {
            await api.put(`/api/entries/${entryId}/action-item`, { text, state });
            setTimeout(() => item.remove(), 400);
          } catch {
            item.classList.remove('done');
          }
        });
      });
      item.querySelector('.pending-action-text')?.addEventListener('click', () => {
        location.hash = `#new-entry/${item.dataset.entryId}`;
      });
    });

  }

  destroy() {}
}

function dayCard(dateStr, entries, todayStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const yesterdayStr = previousDay(todayStr);
  const isToday = dateStr === todayStr;
  const isYesterday = dateStr === yesterdayStr;
  const date = new Date(y, m - 1, d);

  const dayLabel = isToday ? 'Today'
    : isYesterday ? 'Yesterday'
    : date.toLocaleDateString('en-GB', { weekday: 'long' });
  const dateLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  // Day at-a-glance computed inline
  const moodVals = entries.map(e => e.mood_overall).filter(v => v != null);
  const avgMood = moodVals.length ? Math.round(moodVals.reduce((a, b) => a + b, 0) / moodVals.length * 10) / 10 : null;
  const mCls = avgMood == null ? 'none' : avgMood >= 7 ? 'high' : avgMood >= 4 ? 'mid' : 'low';

  // Top-3 themes across the day (frequency-sorted)
  const themeCount = new Map();
  for (const e of entries) {
    for (const t of (e.key_themes || [])) themeCount.set(t, (themeCount.get(t) || 0) + 1);
  }
  const topThemes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);

  // Snippet — try the most recent entry's summary as the day's preview text
  const latest = entries[0]; // already sorted latest-first
  const snippet = latest.ai_summary || latest.important_today || 'Entry recorded';

  // Has love-life across the day?
  const hasLove = entries.some(e => e.has_love_life_content);

  return `
    <a href="#day/${dateStr}" class="day-card">
      <div class="day-card-header">
        <div>
          <div class="day-card-title">${dayLabel}</div>
          <div class="day-card-date">${dateLabel}</div>
        </div>
        <div class="day-card-stats">
          <span class="day-card-count">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
          ${avgMood != null ? `<span class="day-card-mood"><span class="mood-dot ${mCls}"></span>${avgMood}/10</span>` : ''}
          ${hasLove ? '<span class="entry-card-love">💕</span>' : ''}
        </div>
      </div>
      <p class="day-card-snippet">${escHtml(snippet)}</p>
      ${topThemes.length ? `<div class="day-card-themes">${topThemes.map(t => `<span class="entry-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </a>`;
}

function entryCard(entry) {
  const mood = entry.mood_overall;
  const moodClass = mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
  const themes = Array.isArray(entry.key_themes) ? entry.key_themes.slice(0, 3) : [];
  // In the date-bucketed view, the date is the bucket header — just show time.
  const clockTime = entry.created_at
    ? new Date(entry.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : (entry.time_of_day || '');

  return `
    <div class="entry-preview-card" data-id="${entry.id}">
      <div class="entry-card-header">
        <span class="entry-card-date">${clockTime}</span>
        <span class="entry-card-mood">
          <span class="mood-dot ${moodClass}"></span>
          ${mood != null ? mood + '/10' : ''}
          ${entry.has_love_life_content ? '<span class="entry-card-love">💕</span>' : ''}
        </span>
      </div>
      <p class="entry-card-summary">${escHtml(entry.ai_summary || entry.important_today || 'Entry recorded')}</p>
      ${themes.length ? `<div class="entry-card-tags">${themes.map(t => `<span class="entry-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`;
}

// YYYY-MM-DD arithmetic — server timezone irrelevant
function previousDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}
function nDaysAgo(yyyymmdd, n) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

function pendingActionCard(a) {
  const date = String(a.entry_date).split('T')[0];
  const [y, m, d] = date.split('-').map(Number);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
  const label = date === todayStr ? 'Today' : date === yStr ? 'Yesterday' : new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const escText = String(a.text).replace(/"/g, '&quot;');
  return `
    <div class="pending-action" data-entry-id="${a.entry_id}" data-text="${escText}">
      <div class="pending-action-text">
        <div class="pending-action-label">${escHtml(a.text)}</div>
        <div class="pending-action-date">from ${label}</div>
      </div>
      <div class="pending-action-btns">
        <button class="pending-action-btn pending-done" data-state="done" title="Done">✓ Done</button>
        <button class="pending-action-btn pending-snooze" data-state="snoozed" title="Snooze 7 days">📌 Still</button>
        <button class="pending-action-btn pending-dismiss" data-state="dismissed" title="Not doing">✕ Not now</button>
      </div>
    </div>`;
}

function onThisDayCard(entry) {
  const d    = String(entry.date).split('T')[0];
  const year = new Date(d).getFullYear();
  const mood = entry.mood_overall;
  const moodClass = mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
  const summary = entry.ai_summary || entry.important_today || 'Entry recorded';

  return `
    <div class="on-this-day-card entry-preview-card" data-id="${entry.id}">
      <div class="entry-card-header">
        <span class="entry-card-date on-this-day-year">${year}</span>
        ${mood != null ? `<span class="entry-card-mood"><span class="mood-dot ${moodClass}"></span>${mood}/10</span>` : ''}
      </div>
      <p class="entry-card-summary">${escHtml(summary)}</p>
    </div>`;
}

function getDateLabel() {
  const d = new Date();
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatEntryDate(dateStr, timeOfDay) {
  const d = String(dateStr).split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return timeOfDay ? `${label} · ${timeOfDay}` : label;
}
