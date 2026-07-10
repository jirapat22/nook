import { api } from '../app.js';
import { dayActivityKeys, renderActivityChips } from '../components/activities.js';
import { assert } from '../report.js';

export class DayView {
  constructor(params = []) {
    this.dateStr = params[0];
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

    assert(
      entries.every(e => String(e.date).split('T')[0] === this.dateStr),
      'day view entries match requested date',
      { requested: this.dateStr, got: entries.map(e => String(e.date).split('T')[0]) }
    );

    entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const dayLabel = formatDayLabel(this.dateStr);
    const isToday = this.dateStr === todayLocal();
    const activities = dayActivityKeys(entries);

    container.innerHTML = `
      <div class="day-view">
        <div class="day-header">
          <a href="#home" class="back-btn">← Home</a>
          <h2 class="day-title">${dayLabel}</h2>
        </div>

        ${activities.length ? `<div class="day-activity-strip">${renderActivityChips(activities)}</div>` : ''}

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

    container.querySelectorAll('.timeline-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = `#new-entry/${btn.dataset.id}`;
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

  // Show full AI recap if available, otherwise fall back to content preview (no truncation)
  const bodyText = entry.first_person_summary || entry.ai_summary || entry.important_today || entry.content_preview || 'Entry recorded';

  return `
    <div class="timeline-entry">
      <div class="timeline-rail">
        <div class="timeline-time">${time}</div>
        <div class="timeline-dot ${mCls}"></div>
      </div>
      <div class="timeline-body">
        <div class="timeline-body-header">
          ${entry.has_love_life_content ? '<span class="entry-card-love" style="font-size:0.8rem">💕</span>' : ''}
          <button class="timeline-edit-btn" data-id="${entry.id}" title="Open entry">Edit ✏️</button>
        </div>
        <p class="timeline-summary">${escHtml(bodyText)}</p>
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
