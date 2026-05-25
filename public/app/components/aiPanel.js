// AiPanel — displays the AI analysis results card

export class AiPanel {
  constructor(analysis = {}, moodOverrides = {}, onMoodChange = () => {}) {
    this.analysis     = analysis;
    this.moodOverrides = moodOverrides;
    this.onMoodChange = onMoodChange;
    this.showRaw      = false;
  }

  mount(container) {
    const a = this.analysis;
    if (!a || (!a.cleaned_content && !a.ai_summary)) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="ai-panel">
        <div class="ai-panel-header">
          <div class="ai-panel-title">✨ Nook's Analysis</div>
          <button class="btn btn-ghost btn-sm" id="panel-collapse">Hide</button>
        </div>
        <div class="ai-panel-body" id="panel-body">
          ${this.renderSummary(a)}
          ${this.renderImportant(a)}
          ${this.renderActionItems(a)}
          ${this.renderMoodSection(a)}
          ${this.renderTagsAndAreas(a)}
          ${this.renderPeopleMentioned(a)}
        </div>
      </div>
    `;

    // Collapse toggle
    const body = container.querySelector('#panel-body');
    container.querySelector('#panel-collapse').addEventListener('click', function() {
      body.style.display = body.style.display === 'none' ? '' : 'none';
      this.textContent = body.style.display === 'none' ? 'Show' : 'Hide';
    });

    // Raw/cleaned toggle
    container.querySelector('#toggle-raw')?.addEventListener('click', () => {
      this.showRaw = !this.showRaw;
      const rawEl     = container.querySelector('#raw-content');
      const cleanedEl = container.querySelector('#cleaned-content');
      const btn       = container.querySelector('#toggle-raw');
      if (rawEl)     rawEl.style.display     = this.showRaw ? '' : 'none';
      if (cleanedEl) cleanedEl.style.display = this.showRaw ? 'none' : '';
      if (btn)       btn.textContent         = this.showRaw ? '↩ Show cleaned' : '📄 Show original';
    });

    // Mood dimension toggles for uncertain dimensions
    container.querySelectorAll('.mood-confirm-slider').forEach(slider => {
      const dim = slider.dataset.dim;
      const valEl = container.querySelector(`#mood-val-${dim}`);
      const fill  = container.querySelector(`#mood-fill-${dim}`);
      slider.addEventListener('input', e => {
        const v = parseInt(e.target.value);
        if (valEl)  valEl.textContent = v;
        if (fill)   fill.style.width = (v * 10) + '%';
        const updates = { ...this.moodOverrides, [dim]: v };
        this.moodOverrides = updates;
        this.onMoodChange(updates);
      });
    });

    // People pills → navigate to profile
    container.querySelectorAll('.people-pill[data-name]').forEach(pill => {
      pill.addEventListener('click', async () => {
        // We'll just link to people list for now; full lookup requires async
        location.hash = '#people';
      });
    });

    // Tag approve/reject
    container.querySelectorAll('.chip-btn[data-tag]').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('chip-primary');
      });
    });
  }

  renderSummary(a) {
    if (!a.ai_summary && !a.cleaned_content) return '';
    return `
      <div>
        <div class="ai-section-label">Summary</div>
        ${a.ai_summary ? `<p class="ai-summary-text">${a.ai_summary}</p>` : ''}
        ${a.cleaned_content ? `
          <div id="cleaned-content" style="margin-top:8px">
            <div class="ai-section-label">Cleaned entry</div>
            <p class="ai-summary-text">${a.cleaned_content}</p>
          </div>
          ${a.raw_transcript || '' ? `
            <div id="raw-content" style="display:none;margin-top:8px">
              <div class="ai-section-label">Original</div>
              <p class="ai-summary-text text-muted" style="font-style:italic">${a.raw_transcript || ''}</p>
            </div>
            <span class="ai-cleaned-toggle" id="toggle-raw">📄 Show original</span>
          ` : ''}
        ` : ''}
      </div>`;
  }

  renderImportant(a) {
    if (!a.important_today) return '';
    return `
      <div>
        <div class="ai-section-label">Most important</div>
        <div class="card" style="background:var(--color-primary-light);border-color:var(--color-primary);margin:0">
          <p style="font-size:0.9375rem;color:var(--color-primary);font-family:var(--font-display);font-style:italic">
            "${a.important_today}"
          </p>
        </div>
      </div>`;
  }

  renderActionItems(a) {
    const items = a.action_items || [];
    if (!items.length) return '';
    return `
      <div>
        <div class="ai-section-label">Action items</div>
        <div class="action-items-list">
          ${items.map(item => `
            <div class="action-item">
              <input type="checkbox" aria-label="${item}">
              <span>${item}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  renderMoodSection(a) {
    const mood = a.mood;
    if (!mood) return '';
    const dims = [
      { key: 'overall',       label: 'Overall'       },
      { key: 'energy',        label: 'Energy'        },
      { key: 'happiness',     label: 'Happiness'     },
      { key: 'anxiety',       label: 'Anxiety',      inverse: true },
      { key: 'confidence',    label: 'Confidence'    },
      { key: 'motivation',    label: 'Motivation'    },
      { key: 'social_battery',label: 'Social'        },
      { key: 'focus',         label: 'Focus'         },
    ];

    const uncertain = new Set(mood.uncertain_dimensions || []);
    const knownDims = dims.filter(d => mood[d.key] != null && !uncertain.has(d.key));
    const uncertain_dims = dims.filter(d => uncertain.has(d.key));

    if (!knownDims.length && !uncertain_dims.length) return '';

    return `
      <div>
        <div class="ai-section-label">Mood</div>
        <div class="mood-bars">
          ${knownDims.map(d => {
            const val = mood[d.key];
            const fillClass = d.inverse ? 'anxiety' : '';
            return `
              <div class="mood-bar-row">
                <span class="mood-bar-label">${d.label}</span>
                <div class="mood-bar-track">
                  <div class="mood-bar-fill ${fillClass}" style="width:${val * 10}%"></div>
                </div>
                <span class="mood-bar-value">${val}</span>
              </div>`;
          }).join('')}

          ${uncertain_dims.map(d => `
            <div class="mood-bar-row" style="flex-direction:column;align-items:flex-start;gap:4px">
              <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
                <span class="mood-bar-label">${d.label} <span style="color:var(--color-text-faint)">?</span></span>
                <span class="mood-bar-value" id="mood-val-${d.key}">${mood[d.key] ?? 5}</span>
              </div>
              <div style="width:100%;display:flex;align-items:center;gap:8px">
                <div class="mood-bar-track" style="flex:1">
                  <div class="mood-bar-fill" id="mood-fill-${d.key}" style="width:${(mood[d.key] ?? 5) * 10}%"></div>
                </div>
              </div>
              <input type="range" class="range-slider mood-confirm-slider"
                min="0" max="10" step="1"
                value="${mood[d.key] ?? 5}"
                data-dim="${d.key}"
                style="margin:0">
              <span class="mood-uncertain">How would you rate your ${d.label.toLowerCase()} today?</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  renderTagsAndAreas(a) {
    const tags  = a.suggested_tags || [];
    const areas = a.life_areas     || [];
    if (!tags.length && !areas.length) return '';

    return `
      <div>
        ${areas.length ? `
          <div class="ai-section-label">Life areas</div>
          <div class="tags-row mb-8">
            ${areas.map(area => `<span class="chip chip-primary">${area}</span>`).join('')}
          </div>` : ''}
        ${tags.length ? `
          <div class="ai-section-label">Suggested tags</div>
          <div class="tags-row">
            ${tags.map(tag => `<span class="chip chip-btn chip-primary" data-tag="${tag}">${tag} ✓</span>`).join('')}
          </div>` : ''}
      </div>`;
  }

  renderPeopleMentioned(a) {
    const people = a.people_mentioned || [];
    if (!people.length) return '';
    return `
      <div>
        <div class="ai-section-label">People mentioned</div>
        <div class="people-mention-list">
          ${people.map(p => `
            <div class="people-pill" data-name="${p.name}" title="${p.context || ''}">
              <div class="people-pill-avatar">${p.name[0].toUpperCase()}</div>
              <span>${p.name}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }
}
