import { api } from '../app.js';

export class SearchView {
  constructor() { this._debounce = null; }

  async mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="search-view">
        <div class="search-bar-wrap">
          <div class="search-input-row">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input type="search" class="search-input" id="search-input"
              placeholder="Search entries, people, themes…" autocomplete="off" spellcheck="false">
            <button class="search-clear hidden" id="search-clear" aria-label="Clear">✕</button>
          </div>
        </div>
        <div id="search-results" class="search-results">
          <div class="search-prompt">
            <div class="search-prompt-icon">🔍</div>
            <p>Search across all your entries</p>
            <p class="text-xs text-faint mt-4">Try a person's name, a feeling, or a place</p>
          </div>
        </div>
      </div>
    `;

    const input   = container.querySelector('#search-input');
    const clearBtn = container.querySelector('#search-clear');
    const results  = container.querySelector('#search-results');

    // Auto-focus search input
    setTimeout(() => input.focus(), 80);

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.classList.toggle('hidden', !q);
      clearTimeout(this._debounce);
      if (!q) {
        results.innerHTML = `<div class="search-prompt"><div class="search-prompt-icon">🔍</div><p>Search across all your entries</p></div>`;
        return;
      }
      results.innerHTML = '<div class="loading-spinner" style="padding:32px 0"></div>';
      this._debounce = setTimeout(() => this.doSearch(q), 280);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      results.innerHTML = `<div class="search-prompt"><div class="search-prompt-icon">🔍</div><p>Search across all your entries</p></div>`;
      input.focus();
    });
  }

  async doSearch(query) {
    const results = this.container.querySelector('#search-results');
    try {
      const entries = await api.get(`/api/entries?search=${encodeURIComponent(query)}&limit=30`);

      if (!entries.length) {
        results.innerHTML = `
          <div class="search-prompt">
            <div class="search-prompt-icon">🌿</div>
            <p>Nothing found for <strong>${escHtml(query)}</strong></p>
            <p class="text-xs text-faint mt-4">Try a different word or a person's name</p>
          </div>`;
        return;
      }

      results.innerHTML = `
        <div class="search-count">${entries.length} result${entries.length !== 1 ? 's' : ''}</div>
        <div class="entry-cards-grid">
          ${entries.map(e => searchCard(e, query)).join('')}
        </div>
      `;

      results.querySelectorAll('.entry-preview-card').forEach(card => {
        card.addEventListener('click', () => { location.hash = `#new-entry/${card.dataset.id}`; });
      });
    } catch {
      results.innerHTML = `<div class="search-prompt"><p>Search unavailable — try again</p></div>`;
    }
  }

  destroy() { clearTimeout(this._debounce); }
}

function searchCard(entry, query) {
  const d       = String(entry.date).split('T')[0];
  const label   = new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const mood    = entry.mood_overall;
  const moodCls = mood == null ? 'none' : mood >= 7 ? 'high' : mood >= 4 ? 'mid' : 'low';
  const themes  = Array.isArray(entry.key_themes) ? entry.key_themes.slice(0, 3) : [];
  const summary = highlight(entry.ai_summary || entry.important_today || 'Entry recorded', query);

  return `
    <div class="entry-preview-card" data-id="${entry.id}">
      <div class="entry-card-header">
        <span class="entry-card-date">${label}${entry.time_of_day ? ' · ' + entry.time_of_day : ''}</span>
        ${mood != null ? `<span class="entry-card-mood"><span class="mood-dot ${moodCls}"></span>${mood}/10</span>` : ''}
      </div>
      <p class="entry-card-summary">${summary}</p>
      ${themes.length ? `<div class="entry-card-tags">${themes.map(t => `<span class="entry-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function highlight(text, query) {
  if (!query || !text) return escHtml(text || '');
  const safe = escHtml(text);
  const esc  = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${esc})`, 'gi'), '<mark class="search-hl">$1</mark>');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
