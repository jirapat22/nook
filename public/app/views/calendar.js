import { api } from '../app.js';
import { escHtml } from '../html.js';

// Calendar: a small DASHBOARD (calm redesign, 21/11/2026).
// Phone: the month grid, then "This month", then the day you tapped, stacked.
// Desktop: the month grid on the left and a right-hand column with
// "This month" + the chosen day, stretched to the SAME height as the grid,
// so there is no tall-left / short-right split with an empty corner.
//
// The search box that used to sit on top is gone: it was a second copy of
// the Search screen (the magnifier in the top bar), and it hid the calendar
// while you typed.

// Mood score (0-10) -> the dot colour class used by the grid and the legend.
function moodClass(mood) {
  return mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
}

export class CalendarView {
  constructor() {
    this.today = new Date();
    this.year  = this.today.getFullYear();
    this.month = this.today.getMonth() + 1; // 1-indexed
    this.calendarData = {};
    this.container = null;
  }

  async mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="calendar-view">
        <div class="page-header">
          <h1>Calendar</h1>
          <p>Your days, coloured by mood</p>
        </div>
        <div id="cal-main"></div>
      </div>
    `;
    await this.renderCalendar();
  }

  async renderCalendar() {
    const main = this.container.querySelector('#cal-main');
    main.innerHTML = `
      <div class="cal-dashboard">
        <div class="cal-col-main">
          <div class="section-label">Month</div>
          <div class="calendar-grid">
            <div class="calendar-nav">
              <button class="cal-nav-btn" id="prev-month" aria-label="Previous month">‹</button>
              <button class="cal-month-label-btn" id="cal-month-label" type="button" title="Jump to month"></button>
              <input type="month" id="cal-month-jumper" class="cal-month-jumper" aria-label="Jump to month">
              <button class="cal-nav-btn" id="next-month" aria-label="Next month">›</button>
            </div>
            <div class="calendar-weekdays">
              ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-weekday">${d}</div>`).join('')}
            </div>
            <div class="calendar-days" id="cal-days">
              <div class="loading-spinner"></div>
            </div>
            <!-- Legend: what the dot colours mean, so nobody has to guess. -->
            <div class="cal-legend">
              <span><i class="cal-day-dot high"></i>7+</span>
              <span><i class="cal-day-dot mid"></i>4 to 6</span>
              <span><i class="cal-day-dot low"></i>under 4</span>
              <span>💕 love life</span>
            </div>
          </div>
        </div>
        <div class="cal-col-side">
          <div class="section-label">This month</div>
          <div class="card cal-month-stats" id="cal-month-stats"></div>
          <div class="section-label">Day</div>
          <div id="day-panel" class="cal-day-slot"></div>
        </div>
      </div>
    `;

    main.querySelector('#prev-month').addEventListener('click', () => this.changeMonth(-1));
    main.querySelector('#next-month').addEventListener('click', () => this.changeMonth(1));

    // Year/month jumper: click the month label to open the native picker
    const jumper = main.querySelector('#cal-month-jumper');
    main.querySelector('#cal-month-label').addEventListener('click', () => {
      jumper.value = `${this.year}-${String(this.month).padStart(2, '0')}`;
      // Prefer showPicker() where available; fall back to click+focus
      try { jumper.showPicker(); }
      catch { jumper.click(); jumper.focus(); }
    });
    jumper.addEventListener('change', () => {
      const v = jumper.value; // "YYYY-MM"
      if (!v) return;
      const [y, m] = v.split('-').map(Number);
      this.year = y;
      this.month = m;
      this.loadAndRenderDays();
    });

    await this.loadAndRenderDays();
  }

  async loadAndRenderDays() {
    const label = this.container.querySelector('#cal-month-label');
    label.textContent = new Date(this.year, this.month - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    try {
      const data = await api.get(`/api/entries/calendar/${this.year}/${this.month}`);
      this.calendarData = {};
      // Normalize date keys: API may return "2026-05-26T00:00:00.000Z" or "2026-05-26"
      data.forEach(d => { this.calendarData[String(d.date).split('T')[0]] = d; });
    } catch {
      this.calendarData = {};
    }

    this.renderDays();
    this.renderMonthStats();

    // Open on today when looking at the current month, so the right-hand
    // "Day" card is never an empty box. Other months show a gentle prompt.
    const t = todayLocal();
    if (t.startsWith(`${this.year}-${String(this.month).padStart(2, '0')}`)) {
      this.selectDay(t);
    } else {
      this.container.querySelector('#day-panel').innerHTML = `
        <div class="card cal-day-empty">
          <div class="empty-state-icon">🗓️</div>
          <p>Tap a day to see what you wrote.</p>
        </div>`;
    }
  }

  // "This month" card: four small numbers, all worked out from the same
  // calendar data the grid uses (no extra request).
  renderMonthStats() {
    const days = Object.values(this.calendarData);
    const moods = days.map(d => d.avg_mood).filter(m => m != null);
    const avg = moods.length ? Math.round(moods.reduce((a, b) => a + b, 0) / moods.length * 10) / 10 : null;
    const entries = days.reduce((n, d) => n + (d.entry_count || 0), 0);
    const love = days.filter(d => d.has_love_life).length;
    const daysInMonth = new Date(this.year, this.month, 0).getDate();
    this.container.querySelector('#cal-month-stats').innerHTML = `
      <div class="cal-stat"><div class="cal-stat-num">${days.length}<small>/${daysInMonth}</small></div><div class="cal-stat-label">days written</div></div>
      <div class="cal-stat"><div class="cal-stat-num">${entries}</div><div class="cal-stat-label">entries</div></div>
      <div class="cal-stat"><div class="cal-stat-num"><span class="mood-dot ${moodClass(avg)}"></span>${avg ?? '–'}</div><div class="cal-stat-label">average mood</div></div>
      <div class="cal-stat"><div class="cal-stat-num">${love}</div><div class="cal-stat-label">💕 days</div></div>`;
  }

  renderDays() {
    const daysContainer = this.container.querySelector('#cal-days');
    const firstDay = new Date(this.year, this.month - 1, 1).getDay();
    const daysInMonth = new Date(this.year, this.month, 0).getDate();
    const daysInPrevMonth = new Date(this.year, this.month - 1, 0).getDate();
    const todayStr = todayLocal();

    let html = '';

    // Prev month trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      html += `<div class="cal-day other-month"><span class="cal-day-num">${daysInPrevMonth - i}</span></div>`;
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${this.year}-${String(this.month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const data = this.calendarData[dateStr];
      const isToday = dateStr === todayStr;

      html += `
        <div class="cal-day${isToday ? ' today' : ''}${data ? ' has-entries' : ''}" data-date="${dateStr}">
          <span class="cal-day-num">${d}</span>
          ${data ? `<span class="cal-day-dot ${moodClass(data.avg_mood)}"></span>` : ''}
          ${data?.entry_count > 1 ? `<span class="cal-day-count">${data.entry_count}</span>` : ''}
          ${data?.has_love_life ? '<span class="cal-day-love">💕</span>' : ''}
        </div>`;
    }

    // Next month leading days
    const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    for (let d = 1; d <= totalCells - firstDay - daysInMonth; d++) {
      html += `<div class="cal-day other-month"><span class="cal-day-num">${d}</span></div>`;
    }

    daysContainer.innerHTML = html;

    daysContainer.querySelectorAll('.cal-day:not(.other-month)').forEach(day => {
      day.addEventListener('click', () => {
        if (day.dataset.date) this.selectDay(day.dataset.date);
      });
    });
  }

  // Highlight a day in the grid (a class, not an inline style, so the
  // highlight follows the theme) and load it into the Day card.
  selectDay(date) {
    this.container.querySelectorAll('.cal-day.selected').forEach(d => d.classList.remove('selected'));
    this.container.querySelector(`.cal-day[data-date="${date}"]`)?.classList.add('selected');
    this.showDayPanel(date);
  }

  async showDayPanel(date) {
    const panel = this.container.querySelector('#day-panel');
    panel.innerHTML = '<div class="card"><div class="loading-spinner"></div></div>';

    try {
      const entries = await api.get(`/api/entries?date=${date}`);
      // Parse as local date (not UTC) to avoid off-by-one-day
      const [dy, dm, dd] = date.split('-').map(Number);
      const formatted = new Date(dy, dm - 1, dd).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

      const header = `
        <div class="day-panel-header">
          <h3>${formatted}</h3>
          <a class="btn btn-secondary btn-sm" href="#day/${date}">Open day</a>
        </div>`;

      if (!entries.length) {
        panel.innerHTML = `
          <div class="card day-entries-panel">
            ${header}
            <div class="empty-state" style="padding:24px">
              <div class="empty-state-icon">📝</div>
              <p>No entries for this day</p>
              <a class="btn btn-primary btn-sm" href="#new-entry">+ Add entry</a>
            </div>
          </div>`;
        return;
      }

      // Summaries come from the AI, so they are escaped before going into
      // the page (a stray "<" in a summary must not turn into HTML).
      panel.innerHTML = `
        <div class="card day-entries-panel">
          ${header}
          <div class="day-panel-list">
            ${entries.map(e => {
              const mood = e.mood_overall;
              return `
                <a class="day-panel-entry" href="#new-entry/${e.id}">
                  <div class="entry-card-header">
                    <span class="entry-card-date">${escHtml(e.time_of_day || 'Entry')}</span>
                    <span class="entry-card-mood">
                      <span class="mood-dot ${moodClass(mood)}"></span>
                      ${mood != null ? mood + '/10' : ''}
                    </span>
                  </div>
                  <p class="entry-card-summary">${escHtml(e.first_person_summary || e.ai_summary || e.important_today || 'Entry recorded')}</p>
                </a>`;
            }).join('')}
          </div>
        </div>`;
    } catch {
      panel.innerHTML = '';
    }
  }

  changeMonth(delta) {
    this.month += delta;
    if (this.month > 12) { this.month = 1; this.year++; }
    if (this.month < 1)  { this.month = 12; this.year--; }
    this.loadAndRenderDays();
  }

  destroy() {}
}

// Today's date as YYYY-MM-DD on the phone's own clock (not UTC: toISOString()
// is still "yesterday" in NZ until 1pm in summer).
function todayLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
