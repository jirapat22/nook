// AiPanel — displays the AI analysis results card

import { renderMoodFaces, wireMoodFaces } from './moodFaces.js';

export class AiPanel {
  constructor(analysis = {}, moodOverrides = {}, onMoodChange = () => {}) {
    this.analysis     = analysis;
    this.moodOverrides = moodOverrides;
    this.onMoodChange = onMoodChange;
    this.showRaw      = false;
  }

  mount(container) {
    const a = this.analysis;
    if (!a || (!a.ai_summary && !a.first_person_summary && !a.cleaned_content)) {
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

    // One-tap overall mood (faces). Pre-selected to the AI's read; tapping
    // confirms or changes it and records it as a mood override.
    const facesEl = container.querySelector('.mood-faces');
    if (facesEl) {
      wireMoodFaces(facesEl, v => {
        this.moodOverrides = { ...this.moodOverrides, overall: v };
        this.onMoodChange(this.moodOverrides);
      });
    }
    // "add detail" reveals the 8 optional dimension sliders
    const detailToggle = container.querySelector('#mood-detail-toggle');
    const detailEl = container.querySelector('#mood-detail');
    detailToggle?.addEventListener('click', () => {
      const hidden = detailEl.classList.toggle('hidden');
      detailToggle.textContent = hidden ? '＋ add detail' : '－ hide detail';
    });

    // Mood dimension sliders (inside "add detail")
    container.querySelectorAll('.mood-confirm-slider').forEach(slider => {
      const dim = slider.dataset.dim;
      const valEl = container.querySelector(`#mood-val-${dim}`);
      const fill  = container.querySelector(`#mood-fill-${dim}`);
      const track = fill?.parentElement;
      slider.addEventListener('input', e => {
        const v = parseInt(e.target.value);
        if (valEl) {
          valEl.textContent = v;
          valEl.style.color = ''; // un-mute now that user has set a real value
        }
        if (fill)  fill.style.width = (v * 10) + '%';
        if (track) track.style.opacity = '1';
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
    if (!a.ai_summary && !a.cleaned_content && !a.first_person_summary) return '';
    return `
      <div>
        ${a.first_person_summary ? `
          <div class="ai-section-label">Today, in your words</div>
          <p class="ai-summary-text" style="font-size:1rem;line-height:1.6;margin-bottom:10px">${a.first_person_summary}</p>
        ` : ''}
        ${a.ai_summary ? `
          <div class="ai-section-label">Overview</div>
          <p class="ai-summary-text" style="font-style:italic;color:var(--color-text-muted)">${a.ai_summary}</p>
        ` : ''}
        ${a.cleaned_content ? `
          <div id="cleaned-content" style="margin-top:8px">
            <div class="ai-section-label">Cleaned-up entry</div>
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
    const mood = a.mood || {};
    const overall = typeof mood.overall === 'number' ? mood.overall : 5;
    const subDims = [
      { key: 'energy',        label: 'Energy'     },
      { key: 'happiness',     label: 'Happiness'  },
      { key: 'anxiety',       label: 'Anxiety'    },
      { key: 'confidence',    label: 'Confidence' },
      { key: 'motivation',    label: 'Motivation' },
      { key: 'social_battery',label: 'Social'     },
      { key: 'physical',      label: 'Physical'   },
      { key: 'focus',         label: 'Focus'      },
    ];

    // One-tap overall (pre-selected to Nook's read); the 8 dimensions are
    // tucked behind "add detail" so the common case is a single tap.
    return `
      <div>
        <div class="ai-section-label">How did today feel? <span style="color:var(--color-text-faint);font-weight:400">· tap to confirm</span></div>
        ${renderMoodFaces(overall)}
        <button type="button" class="mood-detail-toggle" id="mood-detail-toggle">＋ add detail</button>
        <div class="mood-detail hidden" id="mood-detail">
          ${subDims.map(d => {
            const v = mood[d.key];
            const has = typeof v === 'number';
            return `
              <div class="mood-edit-row">
                <div class="mood-edit-header">
                  <span class="mood-edit-label">${d.label}</span>
                  <span class="mood-edit-val ${has ? '' : 'muted'}" id="mood-val-${d.key}">${has ? v : '—'}</span>
                </div>
                <input type="range" class="range-slider mood-confirm-slider"
                  min="0" max="10" step="1" value="${has ? v : 5}" data-dim="${d.key}">
              </div>`;
          }).join('')}
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
    const people = (a.people_mentioned || []).filter(p => p && p.name);
    if (!people.length) return '';
    return `
      <div>
        <div class="ai-section-label">People mentioned</div>
        <div class="people-mention-list">
          ${people.map(p => {
            const name = String(p.name).trim();
            const initial = name ? name[0].toUpperCase() : '?';
            return `
            <div class="people-pill${p.uncertain ? ' people-pill-uncertain' : ''}" data-name="${escHtml(name)}" title="${escHtml(p.context || '')}">
              <div class="people-pill-avatar">${escHtml(initial)}</div>
              <span>${escHtml(name)}${p.uncertain ? ' <span style="opacity:0.6">?</span>' : ''}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
