import { api, showToast } from '../app.js';
import { dayActivityKeys, renderActivityChips } from '../components/activities.js';
import { assert } from '../report.js';
import { renderMarkdown } from '../markdown.js';

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

    // Day-level big picture: avg mood + top themes. People stay per-entry —
    // they're tied to a specific moment, not the whole day.
    const moodVals = entries.map(e => e.mood_overall).filter(v => v != null);
    const avgMood = moodVals.length ? Math.round(moodVals.reduce((a, b) => a + b, 0) / moodVals.length * 10) / 10 : null;
    const themeCount = new Map();
    for (const e of entries) {
      for (const t of (e.key_themes || [])) themeCount.set(t, (themeCount.get(t) || 0) + 1);
    }
    const topThemes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);

    // Sleep is a once-a-day metric stored per-entry (like mood) — first entry
    // that has it wins. entries[0] is the latest of the day, used as the
    // target when setting a value for the first time.
    const sleepEntry = entries.find(e => e.sleep_hours != null);
    const sleepHours = sleepEntry ? Number(sleepEntry.sleep_hours) : null;

    container.innerHTML = `
      <div class="day-view">
        <div class="day-header">
          <a href="#home" class="back-btn">← Home</a>
          <h2 class="day-title">${dayLabel}</h2>
        </div>

        ${entries.length ? `
        <div class="day-summary-strip">
          ${avgMood != null ? `<span class="day-summary-mood"><span class="mood-dot ${moodClass(avgMood)}"></span>${avgMood}/10</span>` : ''}
          <button type="button" class="day-sleep-chip" id="day-sleep-chip">
            🛌 ${sleepHours != null ? `${sleepHours}h` : '+ sleep'}
          </button>
          ${renderActivityChips(activities)}
          ${topThemes.length ? `<div class="day-summary-themes">${topThemes.map(t => `<span class="entry-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
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

    container.querySelectorAll('.timeline-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = `#new-entry/${btn.dataset.id}`;
      });
    });

    container.querySelector('#day-sleep-chip')?.addEventListener('click', () => {
      // Target the entry that already holds the value (editing), or the most
      // recent entry of the day (setting it for the first time).
      const target = sleepEntry || entries[0];
      if (target) this.showSleepModal(target.id, sleepHours);
    });
  }

  showSleepModal(entryId, currentHours) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Hours of sleep</div>
        <input type="number" class="input" id="sleep-hours-input" min="0" max="24" step="0.5"
          value="${currentHours ?? ''}" placeholder="e.g. 7.5" style="margin-bottom:16px">
        <div class="modal-actions">
          ${currentHours != null ? '<button class="btn btn-ghost" id="sleep-clear">Clear</button>' : ''}
          <button class="btn btn-secondary" id="sleep-cancel">Cancel</button>
          <button class="btn btn-primary" id="sleep-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const input = modal.querySelector('#sleep-hours-input');
    input.focus();

    const cleanup = () => modal.remove();
    modal.querySelector('#sleep-cancel').addEventListener('click', cleanup);
    modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });

    const save = async (value) => {
      const saveBtn = modal.querySelector('#sleep-save');
      saveBtn.disabled = true;
      try {
        await api.put(`/api/entries/${entryId}`, { sleep_hours: value });
        modal.remove();
        showToast(value == null ? 'Sleep cleared' : `Sleep saved — ${value}h`, 'success');
        await this.mount(this.container);
      } catch {
        showToast('Could not save — try again', 'error');
        saveBtn.disabled = false;
      }
    };

    modal.querySelector('#sleep-save').addEventListener('click', () => {
      const raw = input.value.trim();
      const val = raw === '' ? null : Math.max(0, Math.min(24, parseFloat(raw)));
      save(Number.isNaN(val) ? null : val);
    });
    modal.querySelector('#sleep-clear')?.addEventListener('click', () => save(null));
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

  const people = Array.isArray(entry.detected_people) ? entry.detected_people.filter(p => p && p.name) : [];

  return `
    <div class="timeline-entry">
      <div class="timeline-rail">
        <div class="timeline-time">${time}</div>
        <div class="timeline-dot ${mCls}"></div>
      </div>
      <div class="timeline-body">
        <div class="timeline-body-header">
          ${people.length ? `<div class="timeline-people">${people.map(p => `<span class="timeline-people-chip">👤 ${escHtml(p.name)}</span>`).join('')}</div>` : '<span></span>'}
          <div class="timeline-body-header-right">
            ${entry.has_love_life_content ? '<span class="entry-card-love" style="font-size:0.8rem">💕</span>' : ''}
            <button class="timeline-edit-btn" data-id="${entry.id}" title="Open entry">Edit ✏️</button>
          </div>
        </div>
        <div class="timeline-summary md-content">${renderMarkdown(bodyText)}</div>
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
