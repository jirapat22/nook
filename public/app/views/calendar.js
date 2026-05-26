import { api } from '../app.js';

export class CalendarView {
  constructor() {
    this.today = new Date();
    this.year  = this.today.getFullYear();
    this.month = this.today.getMonth() + 1; // 1-indexed
    this.calendarData = {};
    this.searchTimeout = null;
    this.container = null;
  }

  async mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="calendar-view">
        <div class="calendar-search">
          <span class="calendar-search-icon">🔍</span>
          <input type="text" class="input" id="cal-search" placeholder="Search entries..." autocomplete="off">
        </div>
        <div id="cal-main"></div>
        <div id="search-results-area"></div>
      </div>
    `;

    container.querySelector('#cal-search').addEventListener('input', e => {
      clearTimeout(this.searchTimeout);
      const q = e.target.value.trim();
      if (!q) {
        container.querySelector('#search-results-area').innerHTML = '';
        container.querySelector('#cal-main').style.display = '';
        return;
      }
      this.searchTimeout = setTimeout(() => this.runSearch(q), 350);
    });

    await this.renderCalendar();
  }

  async renderCalendar() {
    const main = this.container.querySelector('#cal-main');
    main.innerHTML = `
      <div class="calendar-nav">
        <button class="cal-nav-btn" id="prev-month">‹</button>
        <h2 id="cal-month-label"></h2>
        <button class="cal-nav-btn" id="next-month">›</button>
      </div>
      <div class="calendar-grid">
        <div class="calendar-weekdays">
          ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-weekday">${d}</div>`).join('')}
        </div>
        <div class="calendar-days" id="cal-days">
          <div class="loading-spinner"></div>
        </div>
      </div>
      <div id="day-panel"></div>
    `;

    main.querySelector('#prev-month').addEventListener('click', () => this.changeMonth(-1));
    main.querySelector('#next-month').addEventListener('click', () => this.changeMonth(1));

    await this.loadAndRenderDays();
  }

  async loadAndRenderDays() {
    const label = this.container.querySelector('#cal-month-label');
    label.textContent = new Date(this.year, this.month - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    try {
      const data = await api.get(`/api/entries/calendar/${this.year}/${this.month}`);
      this.calendarData = {};
      // Normalize date keys — API may return "2026-05-26T00:00:00.000Z" or "2026-05-26"
      data.forEach(d => { this.calendarData[String(d.date).split('T')[0]] = d; });
    } catch {
      this.calendarData = {};
    }

    this.renderDays();
  }

  renderDays() {
    const daysContainer = this.container.querySelector('#cal-days');
    const firstDay = new Date(this.year, this.month - 1, 1).getDay();
    const daysInMonth = new Date(this.year, this.month, 0).getDate();
    const daysInPrevMonth = new Date(this.year, this.month - 1, 0).getDate();
    // Use local date (not UTC) — toISOString() can be yesterday in UTC+7 before 7am
    const _n = new Date();
    const todayStr = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;

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

      let dotClass = '';
      if (data) {
        const mood = data.avg_mood;
        dotClass = mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
      }

      html += `
        <div class="cal-day${isToday ? ' today' : ''}${data ? ' has-entries' : ''}" data-date="${dateStr}">
          <span class="cal-day-num">${d}</span>
          ${data ? `<span class="cal-day-dot ${dotClass}"></span>` : ''}
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
        const date = day.dataset.date;
        if (!date) return;
        daysContainer.querySelectorAll('.cal-day').forEach(d => d.style.background = '');
        day.style.background = 'var(--color-primary-light)';
        this.showDayPanel(date);
      });
    });
  }

  async showDayPanel(date) {
    const panel = this.container.querySelector('#day-panel');
    panel.innerHTML = '<div class="loading-spinner"></div>';

    try {
      const entries = await api.get(`/api/entries?date=${date}`);
      // Parse as local date (not UTC) to avoid off-by-one-day in UTC+7
      const [dy, dm, dd] = date.split('-').map(Number);
      const formatted = new Date(dy, dm - 1, dd).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

      if (!entries.length) {
        panel.innerHTML = `
          <div class="day-entries-panel">
            <div class="day-panel-header">
              <h3>${formatted}</h3>
              <button class="btn btn-primary btn-sm" onclick="location.hash='#new-entry'">+ Add entry</button>
            </div>
            <div class="empty-state" style="padding:24px">
              <div class="empty-state-icon">📝</div>
              <p>No entries for this day</p>
            </div>
          </div>`;
        return;
      }

      panel.innerHTML = `
        <div class="day-entries-panel">
          <div class="day-panel-header">
            <h3>${formatted}</h3>
            <button class="btn btn-primary btn-sm" onclick="location.hash='#new-entry'">+ Add</button>
          </div>
          <div style="padding:12px 16px">
            ${entries.map(e => {
              const mood = e.mood_overall;
              const moodClass = mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
              return `
                <div class="entry-preview-card" onclick="location.hash='#new-entry/${e.id}'" style="cursor:pointer">
                  <div class="entry-card-header">
                    <span class="entry-card-date">${e.time_of_day || 'Entry'}</span>
                    <span class="entry-card-mood">
                      <span class="mood-dot ${moodClass}"></span>
                      ${mood != null ? mood + '/10' : ''}
                    </span>
                  </div>
                  <p class="entry-card-summary">${e.ai_summary || e.important_today || 'Entry recorded'}</p>
                </div>`;
            }).join('')}
          </div>
        </div>`;
    } catch {
      panel.innerHTML = '';
    }
  }

  async runSearch(query) {
    const searchArea = this.container.querySelector('#search-results-area');
    const main = this.container.querySelector('#cal-main');
    searchArea.innerHTML = '<div class="loading-spinner"></div>';
    main.style.display = 'none';

    try {
      const results = await api.get(`/api/entries?search=${encodeURIComponent(query)}&limit=20`);
      if (!results.length) {
        searchArea.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No entries found for "${query}"</p></div>`;
        return;
      }

      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const highlight = text => text?.replace(new RegExp(esc(query), 'gi'), m => `<mark>${m}</mark>`) || '';

      searchArea.innerHTML = `
        <div class="search-results">
          <p class="text-muted text-sm mb-8">${results.length} result${results.length !== 1 ? 's' : ''}</p>
          ${results.map(e => `
            <div class="search-result-item" onclick="location.hash='#new-entry/${e.id}'">
              <div class="search-result-date">${formatDate(e.date)}${e.time_of_day ? ' · ' + e.time_of_day : ''}</div>
              <div class="search-result-text">${highlight(e.ai_summary || e.important_today || '')}</div>
            </div>`).join('')}
        </div>`;
    } catch {
      searchArea.innerHTML = '';
    }
  }

  changeMonth(delta) {
    this.month += delta;
    if (this.month > 12) { this.month = 1; this.year++; }
    if (this.month < 1)  { this.month = 12; this.year--; }
    this.container.querySelector('#day-panel').innerHTML = '';
    this.loadAndRenderDays();
  }

  destroy() {
    clearTimeout(this.searchTimeout);
  }
}

function formatDate(dateStr) {
  // Use local date constructor to avoid UTC off-by-one in UTC+7
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
