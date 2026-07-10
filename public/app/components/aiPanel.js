// AiPanel — displays the AI analysis results card

import { renderMoodFaces, wireMoodFaces } from './moodFaces.js';
import { renderMarkdown } from '../markdown.js';

export class AiPanel {
  constructor(analysis = {}, moodOverrides = {}, onMoodChange = () => {}, tagOverrides = null, onTagsChange = () => {}) {
    this.analysis     = analysis;
    this.moodOverrides = moodOverrides;
    this.onMoodChange = onMoodChange;
    this.onTagsChange = onTagsChange;
    this.showRaw      = false;
    // Editable copy of the AI's suggested tags — tapping × actually removes
    // one (the old toggle just dimmed a CSS class and changed nothing), and
    // you can type your own instead of only accepting what the AI guessed.
    // Seeded from tagOverrides when given so edits survive a follow-up
    // question triggering a fresh analysis (which would otherwise re-mount
    // a brand new panel from the new suggested_tags, discarding your edits).
    this.tags = Array.isArray(tagOverrides) ? [...tagOverrides]
      : Array.isArray(analysis.suggested_tags) ? [...analysis.suggested_tags] : [];
  }

  mount(container) {
    const a = this.analysis;
    if (!a || (!a.first_person_summary && !a.cleaned_content)) {
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
          ${this.renderMoodSection(a)}
          ${this.renderTags()}
          ${this.renderAreasAndPeople(a)}
          ${this.renderActionItems(a)}
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

    // People chips → navigate to profile
    container.querySelectorAll('.chip-person[data-name]').forEach(pill => {
      pill.addEventListener('click', async () => {
        // We'll just link to people list for now; full lookup requires async
        location.hash = '#people';
      });
    });

    this.wireTags(container);
  }

  // Editable tag list: each chip has a real × that removes it (the old chip
  // toggle just dimmed a CSS class and changed nothing on save), plus an
  // input to type your own instead of only accepting AI suggestions.
  wireTags(container) {
    container.querySelectorAll('.tag-chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.closest('.tag-chip')?.dataset.tag;
        this.tags = this.tags.filter(t => t !== tag);
        this.onTagsChange(this.tags);
        this.rerenderTags(container);
      });
    });
    const input = container.querySelector('#tag-add-input');
    const addBtn = container.querySelector('#tag-add-btn');
    const addTag = () => {
      const val = (input.value || '').trim();
      if (!val) return;
      if (!this.tags.some(t => t.toLowerCase() === val.toLowerCase())) {
        this.tags = [...this.tags, val];
        this.onTagsChange(this.tags);
        this.rerenderTags(container);
      }
      input.value = '';
      container.querySelector('#tag-add-input')?.focus();
    };
    addBtn?.addEventListener('click', addTag);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
  }

  rerenderTags(container) {
    const section = container.querySelector('#tags-section');
    if (!section) return;
    section.outerHTML = this.renderTags();
    this.wireTags(container);
  }

  renderSummary(a) {
    if (!a.cleaned_content && !a.first_person_summary) return '';
    return `
      <div>
        ${a.first_person_summary ? `
          <div class="ai-section-label">Today, in your words</div>
          <div class="ai-summary-text md-content" style="font-size:1rem;line-height:1.6;margin-bottom:10px">${renderMarkdown(a.first_person_summary)}</div>
        ` : ''}
        ${a.cleaned_content ? `
          <div id="cleaned-content" style="margin-top:8px">
            <div class="ai-section-label">Cleaned-up entry</div>
            <p class="ai-summary-text">${escHtml(a.cleaned_content)}</p>
          </div>
          ${a.raw_transcript || '' ? `
            <div id="raw-content" style="display:none;margin-top:8px">
              <div class="ai-section-label">Original</div>
              <p class="ai-summary-text text-muted" style="font-style:italic">${escHtml(a.raw_transcript || '')}</p>
            </div>
            <span class="ai-cleaned-toggle" id="toggle-raw">📄 Show original</span>
          ` : ''}
        ` : ''}
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
              <input type="checkbox" aria-label="${escHtml(item)}">
              <span>${escHtml(item)}</span>
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

  // Tags are the one editable chip type — actually add/remove, not a fake
  // toggle. Kept in its own section (not merged with areas/people) so the
  // add-tag input has somewhere to live without cluttering the read-only row.
  renderTags() {
    return `
      <div id="tags-section">
        <div class="ai-section-label">Tags</div>
        <div class="meta-chip-row">
          ${this.tags.map(tag => `
            <span class="chip chip-primary tag-chip" data-tag="${escHtml(tag)}">
              🏷 ${escHtml(tag)}
              <button type="button" class="tag-chip-remove" aria-label="Remove ${escHtml(tag)}">×</button>
            </span>`).join('')}
          <span class="tag-add-row">
            <input type="text" id="tag-add-input" class="tag-add-input" placeholder="+ add tag" maxlength="30">
            <button type="button" id="tag-add-btn" class="tag-add-btn" aria-label="Add tag">＋</button>
          </span>
        </div>
      </div>`;
  }

  // Life areas and people mentioned — AI-inferred categorization, not
  // something you curate per-entry the way tags are, so they stay read-only.
  renderAreasAndPeople(a) {
    const areas  = a.life_areas || [];
    const people = (a.people_mentioned || []).filter(p => p && p.name);
    if (!areas.length && !people.length) return '';

    return `
      <div>
        <div class="ai-section-label">Details</div>
        <div class="meta-chip-row">
          ${areas.map(area => `<span class="chip chip-primary">🧭 ${escHtml(area)}</span>`).join('')}
          ${people.map(p => {
            const name = String(p.name).trim();
            return `<span class="chip chip-person" data-name="${escHtml(name)}" title="${escHtml(p.context || '')}">👤 ${escHtml(name)}${p.uncertain ? ' ?' : ''}</span>`;
          }).join('')}
        </div>
      </div>`;
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
