import { api, showToast, todayStr } from '../app.js';
import { escHtml } from '../html.js';

// Chart.js is loaded globally via CDN
const Chart = window.Chart;

export class InsightsView {
  constructor() {
    this.activeTab = 'weekly';
    this.range = '7d';
    this.charts = {};
    this.container = null;
  }

  async mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="insights-view">
        <div class="page-header">
          <h1>Insights</h1>
          <p>Patterns from your journal</p>
        </div>

        <div class="insights-tabs" id="insights-tabs">
          <div class="insights-tab active" data-tab="weekly">Weekly</div>
          <div class="insights-tab" data-tab="monthly">Monthly</div>
          <div class="insights-tab" data-tab="alltime">All Time</div>
        </div>

        <div id="insights-content"></div>
      </div>
    `;

    container.querySelectorAll('.insights-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.insights-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeTab = tab.dataset.tab;
        this.range = this.activeTab === 'weekly' ? '7d' : this.activeTab === 'monthly' ? '30d' : '90d';
        this.destroyCharts();
        this.renderTabContent();
      });
    });

    await this.renderTabContent();
  }

  async renderTabContent() {
    const content = this.container.querySelector('#insights-content');
    content.innerHTML = '<div class="loading-spinner"></div>';

    try {
      const [moodTrends, correlations, streaks, topicFreq, dayPatterns, loveLife, topPeople] = await Promise.all([
        api.get(`/api/insights/mood-trends?range=${this.range}`).catch(() => []),
        api.get('/api/insights/correlations').catch(() => []),
        // Pass the local day, like home.js and the shell badge do — without it
        // this one view judged the streak against the server's UTC date and
        // could disagree with the badge sitting right above it.
        api.get(`/api/insights/streaks?today=${todayStr()}`).catch(() => ({ current: 0, longest: 0, total_days: 0 })),
        api.get(`/api/insights/topic-frequency?range=${this.range}`).catch(() => []),
        api.get('/api/insights/day-patterns').catch(() => []),
        api.get(`/api/insights/love-life-trends?range=${this.range}`).catch(() => []),
        api.get(`/api/insights/top-people?range=${this.range}`).catch(() => []),
      ]);

      // All sections go in one grid: one column on a phone, a balanced
      // two-column dashboard on desktop (see .ins-grid in style.css).
      content.innerHTML = `<div class="ins-grid">
        ${this.renderStreakSection(streaks)}
        ${this.renderWeeklySummarySection()}
        ${this.renderMoodChartSection(moodTrends)}
        ${this.renderCorrelationsSection(correlations)}
        ${this.renderTopPeopleSection(topPeople)}
        ${this.renderTopicFreqSection(topicFreq)}
        ${this.renderDayPatternsSection(dayPatterns)}
        ${this.renderHeatmapSection()}
        ${loveLife.length ? this.renderLoveLifeSection(loveLife) : ''}
      </div>`;
      balanceGrid(content.querySelector('.ins-grid'));

      // Mount charts after DOM is ready
      this.mountMoodChart(moodTrends);
      this.mountTopicChart(topicFreq);
      this.mountDayChart(dayPatterns);
      if (loveLife.length) this.mountLoveChart(loveLife);
      await this.mountHeatmap();
      this.attachWeeklySummaryBtn();
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><h3>Nothing to show yet</h3><p>Start journaling to see your patterns here.</p></div>`;
    }
  }

  // ── Streak section ───────────────────────────────────────────
  renderStreakSection(streaks) {
    const { current = 0, longest = 0, total_days = 0 } = streaks;
    return `
      <section class="ins-block ins-streak">
        <div class="section-label">Streak</div>
        <div class="chart-card">
        <div class="ins-stats">
          ${statBox('Current', current + ' days', '🔥')}
          ${statBox('Best', longest + ' days', '🏆')}
          ${statBox('Total', total_days + ' days', '📝')}
        </div>
      </div>
      </section>`;
  }

  // ── Weekly summary ───────────────────────────────────────────
  renderWeeklySummarySection() {
    return `
      <section class="ins-block ins-summary">
        <div class="section-label">Weekly summary</div>
        <div class="chart-card">
        <p class="ins-hint">A short, kind look back at your week, written from your entries.</p>
        <button class="btn btn-secondary weekly-summary-btn" id="weekly-summary-btn">Generate this week's summary</button>
        <div id="weekly-summary-result"></div>
      </div>
      </section>`;
  }

  attachWeeklySummaryBtn() {
    const btn = this.container.querySelector('#weekly-summary-btn');
    const result = this.container.querySelector('#weekly-summary-result');
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Generating...';
      try {
        const data = await api.get('/api/insights/weekly-summary');
        result.innerHTML = `<div class="weekly-summary-text">${data.summary ? escHtml(data.summary) : 'No summary available.'}</div>`;
      } catch {
        showToast('Could not generate summary', 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Regenerate';
    });
  }

  // ── Mood chart ───────────────────────────────────────────────
  renderMoodChartSection(data) {
    if (!data.length) return `
      <section class="ins-block ins-mood">
        <div class="section-label">Mood trends</div>
        <div class="chart-card">
        <p class="text-muted text-sm">Not enough data yet. Keep journaling!</p>
      </div>
      </section>`;
    return `
      <section class="ins-block ins-mood">
        <div class="section-label">Mood trends</div>
        <div class="chart-card">
        <div class="chart-container"><canvas id="mood-chart"></canvas></div>
        <div class="chart-legend" id="mood-legend"></div>
      </div>
      </section>`;
  }

  mountMoodChart(data) {
    const canvas = this.container.querySelector('#mood-chart');
    if (!canvas || !data.length || !window.Chart) return;

    const labels = data.map(d => formatShortDate(d.date));
    const dimensions = [
      { key: 'mood_overall',   label: 'Overall',   color: '#c8843a' },
      { key: 'mood_energy',    label: 'Energy',    color: '#5a9e6f' },
      { key: 'mood_happiness', label: 'Happiness', color: '#f0a853' },
      { key: 'mood_anxiety',   label: 'Anxiety',   color: '#c85a3a' },
    ];

    const datasets = dimensions.map(d => ({
      label: d.label,
      data: data.map(row => row[d.key]),
      borderColor: d.color,
      backgroundColor: d.color + '20',
      tension: 0.35,
      pointRadius: 3,
      borderWidth: 2,
    }));

    this.charts['mood'] = new window.Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        scales: {
          y: { min: 0, max: 10, ticks: { stepSize: 2 } },
          x: { ticks: { maxTicksLimit: 7 } },
        },
        plugins: { legend: { display: false } },
      },
    });

    // Custom legend with toggles
    const legend = this.container.querySelector('#mood-legend');
    if (legend) {
      legend.innerHTML = datasets.map((d, i) => `
        <div class="legend-item" data-idx="${i}">
          <div class="legend-dot" style="background:${dimensions[i].color}"></div>
          <span>${d.label}</span>
        </div>`).join('');
      legend.querySelectorAll('.legend-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.dataset.idx);
          const meta = this.charts['mood'].getDatasetMeta(idx);
          meta.hidden = !meta.hidden;
          this.charts['mood'].update();
          item.classList.toggle('hidden', meta.hidden);
        });
      });
    }
  }

  // ── Correlations ─────────────────────────────────────────────
  renderCorrelationsSection(correlations) {
    if (!correlations.length) return '';
    const top = correlations.slice(0, 6);
    return `
      <section class="ins-block ins-corr">
        <div class="section-label">Mood by life area</div>
        <div class="chart-card">
        <p class="text-xs text-faint mb-8">Based on entries where you confirmed the mood yourself.</p>
        ${top.map(c => {
          const delta = c.delta;
          const sign = delta > 0 ? '+' : '';
          const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
          return `
          <div class="corr-row">
            <p>On <strong>${escHtml(c.area)}</strong> days, your mood averages <strong>${c.avg_mood}/10</strong></p>
            ${delta != null ? `<div class="insight-delta ${cls}">${sign}${delta} vs your average</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      </section>`;
  }

  // ── Top mentioned people ─────────────────────────────────────
  renderTopPeopleSection(people) {
    if (!people.length) return '';
    return `
      <section class="ins-block ins-people">
        <div class="section-label">People on your mind</div>
        <div class="chart-card">
        <p class="text-xs text-faint mb-8">Who you mentioned most this period — tap to open their profile.</p>
        <div class="top-people-list">
          ${people.map(p => {
            const initials = p.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
            const sent = parseFloat(p.avg_sentiment) || 0;
            const sentClass = sent > 1 ? 'pos' : sent < -1 ? 'neg' : 'neu';
            const sentIcon  = sent > 1 ? '😊' : sent < -1 ? '😟' : '😐';
            return `
              <a href="#person/${p.id}" class="top-person-row">
                <div class="top-person-avatar${p.photo_url ? ' has-photo' : ''}">${p.photo_url ? `<img src="${escHtml(p.photo_url)}" alt="">` : initials}</div>
                <div class="top-person-info">
                  <div class="top-person-name">${escHtml(p.name)}</div>
                  <div class="top-person-meta">${p.relationship_type ? escHtml(p.relationship_type) : '—'} · ${p.mention_count} mention${p.mention_count !== 1 ? 's' : ''}</div>
                </div>
                <div class="top-person-sentiment ${sentClass}">${sentIcon}</div>
              </a>`;
          }).join('')}
        </div>
      </div>
      </section>`;
  }

  // ── Topic frequency ──────────────────────────────────────────
  renderTopicFreqSection(data) {
    if (!data.length) return '';
    return `
      <section class="ins-block ins-areas">
        <div class="section-label">Life areas</div>
        <div class="chart-card">
        <div class="chart-container"><canvas id="topic-chart"></canvas></div>
      </div>
      </section>`;
  }

  mountTopicChart(data) {
    const canvas = this.container.querySelector('#topic-chart');
    if (!canvas || !data.length || !window.Chart) return;
    const colors = ['#c8843a','#5a9e6f','#6a8ab8','#c8a03a','#8a6ab8','#c85a7a','#3a9ea8'];
    this.charts['topic'] = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.map(d => d.area),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: data.map((_, i) => colors[i % colors.length] + 'cc'),
          borderColor: data.map((_, i) => colors[i % colors.length]),
          borderWidth: 1.5,
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        indexAxis: 'y',
        scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Day patterns ─────────────────────────────────────────────
  renderDayPatternsSection(data) {
    if (!data.length) return '';
    const best  = data.reduce((a, b) => (a.avg_mood > b.avg_mood ? a : b), data[0]);
    const worst = data.reduce((a, b) => (a.avg_mood < b.avg_mood ? a : b), data[0]);
    return `
      <section class="ins-block ins-days">
        <div class="section-label">Day of the week</div>
        <div class="chart-card">
        <div class="chart-container"><canvas id="day-chart"></canvas></div>
        ${best?.avg_mood ? `<p class="text-sm text-muted mt-8">You tend to feel best on <strong>${best.day_name?.trim()}</strong></p>` : ''}
      </div>
      </section>`;
  }

  mountDayChart(data) {
    const canvas = this.container.querySelector('#day-chart');
    if (!canvas || !data.length || !window.Chart) return;
    this.charts['day'] = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.map(d => d.day_name?.trim().slice(0, 3) || ''),
        datasets: [{
          label: 'Avg Mood',
          data: data.map(d => d.avg_mood),
          backgroundColor: data.map(d => (d.avg_mood >= 7 ? '#5a9e6f' : d.avg_mood >= 4 ? '#c8a03a' : '#c85a3a') + 'bb'),
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        scales: { y: { min: 0, max: 10 } },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Activity heatmap ─────────────────────────────────────────
  renderHeatmapSection() {
    return `
      <section class="ins-block ins-heat">
        <div class="section-label">Journaling activity, last 12 weeks</div>
        <div class="chart-card">
        <div class="heatmap-wrap">
          <div class="heatmap-months" id="heatmap-months"></div>
          <div class="heatmap" id="heatmap-grid"></div>
        </div>
        <div class="heatmap-legend">
          <span class="text-xs text-faint">Less</span>
          <div class="heatmap-cell" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-1" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-2" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-3" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-4" style="width:14px;height:14px"></div>
          <span class="text-xs text-faint">More</span>
        </div>
      </div>
      </section>`;
  }

  async mountHeatmap() {
    const grid = this.container.querySelector('#heatmap-grid');
    const monthsEl = this.container.querySelector('#heatmap-months');
    if (!grid) return;
    try {
      const data = await api.get('/api/entries?limit=365');
      const counts = {};
      // Normalize date keys — API returns "2026-05-26T00:00:00.000Z", need "2026-05-26"
      data.forEach(e => { const key = String(e.date).split('T')[0]; counts[key] = (counts[key] || 0) + 1; });
      const maxCount = Math.max(1, ...Object.values(counts));

      // Last 84 days, 7 rows × 12 columns (a column = 7 consecutive days). No
      // leading padding — the grid starts at the earliest day (no front gap).
      const days = 84;
      const cols = Math.ceil(days / 7);
      const today = new Date();
      const start = new Date(today);
      start.setDate(today.getDate() - (days - 1));

      const cells = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dateStr = todayStr(d); // local date, matches how entries are dated
        const count = counts[dateStr] || 0;
        const level = count === 0 ? 0 : Math.ceil((count / maxCount) * 4);
        cells.push(`<div class="heatmap-cell level-${level}" title="${dateStr}: ${count} entr${count !== 1 ? 'ies' : 'y'}"></div>`);
      }
      grid.innerHTML = cells.join('');

      // Month labels above the columns. Each column's first day decides its
      // month; consecutive same-month columns are spanned under one label.
      if (monthsEl) {
        const labels = [];
        let c = 0;
        while (c < cols) {
          const first = new Date(start);
          first.setDate(start.getDate() + c * 7);
          const m = first.getMonth();
          let span = 1;
          while (c + span < cols) {
            const d2 = new Date(start);
            d2.setDate(start.getDate() + (c + span) * 7);
            if (d2.getMonth() !== m) break;
            span++;
          }
          labels.push(`<span class="heatmap-month" style="grid-column:${c + 1}/span ${span}">${first.toLocaleDateString('en-GB', { month: 'short' })}</span>`);
          c += span;
        }
        // Same flexible columns as the grid below, so labels stay over their weeks.
        monthsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        monthsEl.innerHTML = labels.join('');
      }
    } catch { grid.innerHTML = ''; }
  }

  // ── Love life chart ──────────────────────────────────────────
  renderLoveLifeSection(data) {
    return `
      <section class="ins-block ins-love">
        <div class="section-label">Love life</div>
        <div class="chart-card">
        <div class="chart-container"><canvas id="love-chart"></canvas></div>
        <p class="text-xs text-faint mt-8">Emotion intensity over time (names hidden)</p>
      </div>
      </section>`;
  }

  mountLoveChart(data) {
    const canvas = this.container.querySelector('#love-chart');
    if (!canvas || !window.Chart) return;
    this.charts['love'] = new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: data.map(d => formatShortDate(d.date)),
        datasets: [{
          label: 'Intensity',
          data: data.map(d => d.love_life_emotion_intensity),
          borderColor: '#d4697a',
          backgroundColor: '#d4697a20',
          tension: 0.35,
          pointRadius: 4,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        scales: { y: { min: 0, max: 10 } },
        plugins: { legend: { display: false } },
      },
    });
  }

  destroyCharts() {
    Object.values(this.charts).forEach(c => c?.destroy?.());
    this.charts = {};
  }

  destroy() {
    this.destroyCharts();
  }
}

// One small stat tile (number + label). Styled in style.css (.ins-stat)
// instead of inline styles, so it follows the theme and the calm layout.
function statBox(label, value, icon) {
  return `
    <div class="ins-stat">
      <div class="ins-stat-num">${value}</div>
      <div class="ins-stat-label">${icon} ${label}</div>
    </div>`;
}

// Desktop pairs the cards two per row. Some cards only appear when there is
// data (people, life areas, love life...), so a card can end up alone in its
// row with an empty hole beside it. This walks the cards in order and lets
// any card left without a partner take the full row instead (.ins-wide).
// The mood chart (.ins-mood) is always full width.
function balanceGrid(grid) {
  if (!grid) return;
  let waiting = null; // a half-width card still looking for a partner
  for (const block of grid.querySelectorAll(':scope > .ins-block')) {
    if (block.classList.contains('ins-mood')) {
      if (waiting) waiting.classList.add('ins-wide');
      waiting = null;
    } else if (waiting) {
      waiting = null; // pair complete
    } else {
      waiting = block;
    }
  }
  if (waiting) waiting.classList.add('ins-wide');
}

function formatShortDate(dateStr) {
  // Use local date constructor to avoid UTC off-by-one in UTC+7
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

