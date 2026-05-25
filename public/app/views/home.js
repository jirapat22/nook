import { api, showToast, updateStreakDisplay } from '../app.js';

export class HomeView {
  constructor() {}

  async mount(container) {
    const [entries, streakData] = await Promise.all([
      api.get('/api/entries?limit=10').catch(() => []),
      api.get('/api/insights/streaks').catch(() => ({ current: 0 })),
    ]);

    updateStreakDisplay(streakData.current || 0);

    const hour = new Date().getHours();
    const greeting =
      hour < 5  ? 'Good night' :
      hour < 12 ? 'Good morning' :
      hour < 17 ? 'Good afternoon' :
      hour < 21 ? 'Good evening' : 'Good night';

    // Group entries by date
    const today = new Date().toISOString().split('T')[0];
    const todayEntries  = entries.filter(e => e.date === today);
    const recentEntries = entries.filter(e => e.date !== today).slice(0, 4);

    container.innerHTML = `
      <div class="home-view">
        <div class="greeting-section">
          <h2>${greeting}, Jirapat ✨</h2>
          <p class="greeting-sub">${getDateLabel()}</p>
        </div>

        <div class="quick-start">
          <button class="quick-start-btn qs-primary" id="voice-entry-btn">
            <span class="qs-icon">🎙️</span>
            Voice Entry
          </button>
          <button class="quick-start-btn" id="text-entry-btn">
            <span class="qs-icon">✍️</span>
            Text Entry
          </button>
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
          ? todayEntries.map(e => entryCard(e)).join('')
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
        ${recentEntries.map(e => entryCard(e)).join('')}
        ` : ''}
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

function getDateLabel() {
  const d = new Date();
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatEntryDate(dateStr, timeOfDay) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const label = dateStr === today ? 'Today' : dateStr === yesterday ? 'Yesterday' : new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return timeOfDay ? `${label} · ${timeOfDay}` : label;
}
