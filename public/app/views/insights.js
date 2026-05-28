import { api, showToast } from '../app.js';

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
        api.get('/api/insights/streaks').catch(() => ({ current: 0, longest: 0, total_days: 0 })),
        api.get(`/api/insights/topic-frequency?range=${this.range}`).catch(() => []),
        api.get('/api/insights/day-patterns').catch(() => []),
        api.get(`/api/insights/love-life-trends?range=${this.range}`).catch(() => []),
        api.get(`/api/insights/top-people?range=${this.range}`).catch(() => []),
      ]);

      content.innerHTML = `
        ${this.renderStreakSection(streaks)}
        ${this.renderWeeklySummarySection()}
        ${this.renderMoodChartSection(moodTrends)}
        ${this.renderCorrelationsSection(correlations)}
        ${this.renderTopPeopleSection(topPeople)}
        ${this.renderTopicFreqSection(topicFreq)}
        ${this.renderDayPatternsSection(dayPatterns)}
        ${this.renderHeatmapSection()}
        ${loveLife.length ? this.renderLoveLifeSection(loveLife) : ''}
      `;

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
      <div class="chart-card">
        <h3>🔥 Streak & Consistency</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          ${statBox('Current', current + ' days', '🔥')}
          ${statBox('Best', longest + ' days', '🏆')}
          ${statBox('Total', total_days + ' days', '📝')}
        </div>
      </div>`;
  }

  // ── Weekly summary ───────────────────────────────────────────
  renderWeeklySummarySection() {
    return `
      <div class="chart-card">
        <h3>✨ Weekly Summary</h3>
        <button class="btn btn-secondary weekly-summary-btn" id="weekly-summary-btn">Generate this week's summary</button>
        <div id="weekly-summary-result"></div>
      </div>`;
  }

  attachWeeklySummaryBtn() {
    const btn = this.container.querySelector('#weekly-summary-btn');
    const result = this.container.querySelector('#weekly-summary-result');
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Generating...';
      try {
        const data = await api.get('/api/insights/weekly-summary');
        result.innerHTML = `<div class="weekly-summary-text">${data.summary || 'No summary available.'}</div>`;
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
      <div class="chart-card">
        <h3>📈 Mood Trends</h3>
        <p class="text-muted text-sm">Not enough data yet. Keep journaling!</p>
      </div>`;
    return `
      <div class="chart-card">
        <h3>📈 Mood Trends</h3>
        <div class="chart-container"><canvas id="mood-chart"></canvas></div>
        <div class="chart-legend" id="mood-legend"></div>
      </div>`;
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
      <div class="chart-card">
        <h3>🔗 Life Area Correlations</h3>
        <p class="text-xs text-faint mb-8">Based on entries where you confirmed the mood yourself.</p>
        ${top.map(c => {
          const delta = c.delta;
          const sign = delta > 0 ? '+' : '';
          const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
          return `
          <div class="insight-card" style="margin-bottom:0;box-shadow:none;border:1px solid var(--color-border-light)">
            <p>On <strong>${c.area}</strong> days, your mood averages <strong>${c.avg_mood}/10</strong></p>
            ${delta != null ? `<div class="insight-delta ${cls}">${sign}${delta} vs your average</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  }

  // ── Top mentioned people ─────────────────────────────────────
  renderTopPeopleSection(people) {
    if (!people.length) return '';
    return `
      <div class="chart-card">
        <h3>👥 People on your mind</h3>
        <p class="text-xs text-faint mb-8">Who you mentioned most this period — tap to open their profile.</p>
        <div class="top-people-list">
          ${people.map(p => {
            const initials = p.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
            const sent = parseFloat(p.avg_sentiment) || 0;
            const sentClass = sent > 1 ? 'pos' : sent < -1 ? 'neg' : 'neu';
            const sentIcon  = sent > 1 ? '😊' : sent < -1 ? '😟' : '😐';
            return `
              <a href="#person/${p.id}" class="top-person-row">
                <div class="top-person-avatar${p.photo_url ? ' has-photo' : ''}">${p.photo_url ? `<img src="${p.photo_url}" alt="">` : initials}</div>
                <div class="top-person-info">
                  <div class="top-person-name">${p.name}</div>
                  <div class="top-person-meta">${p.relationship_type || '—'} · ${p.mention_count} mention${p.mention_count !== 1 ? 's' : ''}</div>
                </div>
                <div class="top-person-sentiment ${sentClass}">${sentIcon}</div>
              </a>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ── Topic frequency ──────────────────────────────────────────
  renderTopicFreqSection(data) {
    if (!data.length) return '';
    return `
      <div class="chart-card">
        <h3>📚 Life Areas</h3>
        <div class="chart-container"><canvas id="topic-chart"></canvas></div>
      </div>`;
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
      <div class="chart-card">
        <h3>📅 Day of Week Patterns</h3>
        <div class="chart-container"><canvas id="day-chart"></canvas></div>
        ${best?.avg_mood ? `<p class="text-sm text-muted mt-8">You tend to feel best on <strong>${best.day_name?.trim()}</strong></p>` : ''}
      </div>`;
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
      <div class="chart-card">
        <h3>🗓️ Journaling Activity</h3>
        <div class="heatmap" id="heatmap-grid"></div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
          <span class="text-xs text-faint">Less</span>
          <div class="heatmap-cell" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-1" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-2" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-3" style="width:14px;height:14px"></div>
          <div class="heatmap-cell level-4" style="width:14px;height:14px"></div>
          <span class="text-xs text-faint">More</span>
        </div>
      </div>`;
  }

  async mountHeatmap() {
    const grid = this.container.querySelector('#heatmap-grid');
    if (!grid) return;
    try {
      const data = await api.get('/api/entries?limit=365');
      const counts = {};
      // Normalize date keys — API returns "2026-05-26T00:00:00.000Z", need "2026-05-26"
      data.forEach(e => { const key = String(e.date).split('T')[0]; counts[key] = (counts[key] || 0) + 1; });
      const maxCount = Math.max(1, ...Object.values(counts));

      // Last 84 days (12 weeks) in a 7-col grid
      const days = 84;
      const cells = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const dateStr = d.toISOString().split('T')[0];
        const count = counts[dateStr] || 0;
        const level = count === 0 ? 0 : Math.ceil((count / maxCount) * 4);
        cells.push(`<div class="heatmap-cell level-${level}" title="${dateStr}: ${count} entr${count !== 1 ? 'ies' : 'y'}"></div>`);
      }
      grid.innerHTML = cells.join('');
    } catch { grid.innerHTML = ''; }
  }

  // ── Love life chart ──────────────────────────────────────────
  renderLoveLifeSection(data) {
    return `
      <div class="chart-card">
        <h3>💕 Love Life Intensity</h3>
        <div class="chart-container"><canvas id="love-chart"></canvas></div>
        <p class="text-xs text-faint mt-8">Emotion intensity over time (names hidden)</p>
      </div>`;
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

function statBox(label, value, icon) {
  return `
    <div style="text-align:center;padding:12px;background:var(--color-surface-offset);border-radius:var(--radius-sm)">
      <div style="font-size:1.4rem">${icon}</div>
      <div style="font-size:1.1rem;font-weight:700;margin-top:4px">${value}</div>
      <div style="font-size:0.75rem;color:var(--color-text-muted)">${label}</div>
    </div>`;
}

function formatShortDate(dateStr) {
  // Use local date constructor to avoid UTC off-by-one in UTC+7
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
