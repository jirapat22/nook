import { api } from '../app.js';

// DayView — shows all entries for a single calendar day as a vertical timeline.
// Reached from home day-card tap (#day/YYYY-MM-DD).
export class DayView {
  constructor(params = []) {
    this.dateStr = params[0]; // "YYYY-MM-DD"
    this.container = null;
  }

  async mount(container) {
    this.container = container;
    if (!this.dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(this.dateStr)) {
      location.hash = '#home';
      return;
    }

    container.innerHTML = '<div class="loading-spinner"></div>';

    let entries = [];
    try {
      entries = await api.get(`/api/entries?date=${this.dateStr}&limit=20`);
    } catch {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">😕</div><p>Could not load this day</p><a href="#home" class="btn btn-primary btn-sm mt-12">Back home</a></div>`;
      return;
    }

    // Sort by created_at DESC (latest at top)
    entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const dayLabel = formatDayLabel(this.dateStr);
    const todayStr = todayLocal();
    const isToday = this.dateStr === todayStr;

    // Day at a glance
    const moodVals = entries.map(e => e.mood_overall).filter(v => v != null);
    const avgMood = moodVals.length ? Math.round(moodVals.reduce((a, b) => a + b, 0) / moodVals.length * 10) / 10 : null;
    const themeCount = new Map();
    for (const e of entries) {
      for (const t of (e.key_themes || [])) themeCount.set(t, (themeCount.get(t) || 0) + 1);
    }
    const topThemes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);

    container.innerHTML = `
      <div class="day-view">
        <div class="day-header">
          <a href="#home" class="back-btn">← Home</a>
          <h2 class="day-title">${dayLabel}</h2>
        </div>

        ${entries.length ? `
        <div class="day-glance card">
          <div class="day-glance-row">
            <span class="day-glance-stat"><strong>${entries.length}</strong> ${entries.length === 1 ? 'entry' : 'entries'}</span>
            ${avgMood != null ? `<span class="day-glance-stat"><span class="mood-dot ${moodClass(avgMood)}"></span> Mood avg <strong>${avgMood}/10</strong></span>` : ''}
          </div>
          ${topThemes.length ? `<div class="day-glance-themes">${topThemes.map(t => `<span class="chip chip-primary">${escHtml(t)}</span>`).join('')}</div>` : ''}
        </div>` : ''}

        ${entries.length === 0 ? `
          <div class="empty-state" style="padding:40px 0">
            <div class="empty-state-icon">🌿</div>
            <h3>No entries this day</h3>
            ${isToday ? '<p>Add the first one below.</p>' : ''}
          </div>` : ''}

        ${entries.length ? `
        <div class="day-timeline">
          ${entries.map(e => timelineEntry(e)).join('')}
        </div>` : ''}

        ${isToday ? `
        <div class="day-add-cta">
          <a href="#new-entry/text" class="btn btn-secondary btn-sm">+ Add text entry</a>
          <a href="#new-entry/voice" class="btn btn-primary btn-sm">🎙 Voice entry</a>
        </div>` : ''}
      </div>`;

    container.querySelectorAll('.timeline-entry').forEach(el => {
      el.addEventListener('click', () => {
        location.hash = `#new-entry/${el.dataset.id}`;
      });
    });
  }

  destroy() {}
}

function timelineEntry(entry) {
  const mood = entry.mood_overall;
  const mCls = mood == null ? 'none' : moodClass(mood);
  const time = entry.created_at
    ? new Date(entry.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : (entry.time_of_day || '');
  const themes = Array.isArray(entry.key_themes) ? entry.key_themes.slice(0, 3) : [];
  const rawSum = entry.first_person_summary || entry.ai_summary || entry.important_today || entry.content_preview || 'Entry recorded';
  const summary = rawSum.length > 140 ? rawSum.slice(0, 137) + '…' : rawSum;
  return `
    <div class="timeline-entry" data-id="${entry.id}">
      <div class="timeline-rail">
        <div class="timeline-time">${time}</div>
        <div class="timeline-dot ${mCls}"></div>
      </div>
      <div class="timeline-body">
        <p class="timeline-summary">${escHtml(summary)}</p>
        <div class="timeline-meta">
          ${mood != null ? `<span class="timeline-mood"><span class="mood-dot ${mCls}"></span>${mood}/10</span>` : ''}
          ${themes.length ? `<div class="timeline-themes">${themes.map(t => `<span class="entry-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
          ${entry.has_love_life_content ? '<span class="entry-card-love">💕</span>' : ''}
        </div>
      </div>
    </div>`;
}

function moodClass(m) { return m >= 7 ? 'high' : m >= 4 ? 'mid' : 'low'; }

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayLocal();
  const yest = (() => {
    const dt = new Date(); dt.setDate(dt.getDate() - 1);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  })();
  if (dateStr === today) return 'Today · ' + date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (dateStr === yest)  return 'Yesterday · ' + date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
