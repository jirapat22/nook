import { api, showToast, updateStreakDisplay } from '../app.js';

export class HomeView {
  constructor() {}

  async mount(container) {
    const [entries, streakData, onThisDay] = await Promise.all([
      api.get('/api/entries?limit=10').catch(() => []),
      api.get('/api/insights/streaks').catch(() => ({ current: 0 })),
      api.get(`/api/entries/on-this-day?date=${today}`).catch(() => []),
    ]);

    updateStreakDisplay(streakData.current || 0);

    const hour = new Date().getHours();
    const greeting =
      hour < 5  ? 'Good night' :
      hour < 12 ? 'Good morning' :
      hour < 17 ? 'Good afternoon' :
      hour < 21 ? 'Good evening' : 'Good night';

    // Normalise date — API may return "2026-05-26T00:00:00.000Z" or "2026-05-26"
    const normDate = d => String(d).split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const todayEntries  = entries.filter(e => normDate(e.date) === today);
    const recentEntries = entries.filter(e => normDate(e.date) !== today).slice(0, 4);

    container.innerHTML = `
      <div class="home-view">
        <div class="greeting-section">
          <h2>${greeting}, Jirapat ✨</h2>
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

        <div class="section-header">
          <h3>Today</h3>
          <a href="#calendar">See all</a>
        </div>
        ${todayEntries.length
          ? `<div class="entry-cards-grid">${todayEntries.map(e => entryCard(e)).join('')}</div>`
          : `<div class="empty-state" style="padding:32px 0">
               <div class="empty-state-icon">🌿</div>
               <h3>Your nook is quiet today</h3>
               <p>Ready to add something?</p>
             </div>`
        }

        ${recentEntries.length ? `
        <div class="section-header mt-16">
          <h3>Recent</h3>
          <a href="#calendar">Calendar</a>
        </div>
        <div class="entry-cards-grid">${recentEntries.map(e => entryCard(e)).join('')}</div>
        ` : ''}

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

  }

  destroy() {}
}

function entryCard(entry) {
  const mood = entry.mood_overall;
  const moodClass = mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
  const themes = Array.isArray(entry.key_themes) ? entry.key_themes.slice(0, 3) : [];
  const dateStr = formatEntryDate(entry.date, entry.time_of_day);

  return `
    <div class="entry-preview-card" data-id="${entry.id}">
      <div class="entry-card-header">
        <span class="entry-card-date">${dateStr}</span>
        <span class="entry-card-mood">
          <span class="mood-dot ${moodClass}"></span>
          ${mood != null ? mood + '/10' : ''}
          ${entry.has_love_life_content ? '<span class="entry-card-love">💕</span>' : ''}
        </span>
      </div>
      <p class="entry-card-summary">${entry.ai_summary || entry.important_today || 'Entry recorded'}</p>
      ${themes.length ? `<div class="entry-card-tags">${themes.map(t => `<span class="entry-card-tag">${t}</span>`).join('')}</div>` : ''}
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
      <p class="entry-card-summary">${summary}</p>
    </div>`;
}

function getDateLabel() {
  const d = new Date();
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatEntryDate(dateStr, timeOfDay) {
  const d = String(dateStr).split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return timeOfDay ? `${label} · ${timeOfDay}` : label;
}
