// One look for a quick memory, wherever it shows up (home timeline, day view,
// the Remember screen) — plus the tap-to-edit/delete sheet that goes with it.
import { api, showToast } from '../app.js';
import { escHtml } from '../html.js';

// The AI files each memory under one kind; the emoji makes it scannable.
export const KIND_EMOJI = {
  person: '👤', place: '📍', idea: '💡', money: '💰',
  date: '📅', fact: '📌', todo: '✅', other: '🧠',
};

// "12 Mar 2027" — NZ-style day-month order.
function fmtDate(d) {
  const s = String(d || '').split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// `showDate` — the captured day, for lists that aren't already grouped by day.
export function memoryCardHtml(m, { showDate = false } = {}) {
  const emoji = KIND_EMOJI[m.kind] || '🧠';
  const time = m.created_at
    ? new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';
  const people = Array.isArray(m.people) ? m.people : [];
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const meta = [showDate ? fmtDate(m.date) : time, m.entry_mode === 'voice' ? '🎙' : ''].filter(Boolean).join(' · ');
  return `
    <div class="memory-card" data-memory-id="${escHtml(m.id)}" role="button" tabindex="0">
      <div class="memory-card-icon">${emoji}</div>
      <div class="memory-card-body">
        <div class="memory-card-head">
          <span class="memory-card-title">${escHtml(m.title || (m.analyzed ? 'Memory' : 'Tidying up…'))}</span>
          <span class="memory-card-meta">${escHtml(meta)}</span>
        </div>
        <p class="memory-card-text">${escHtml(m.content)}</p>
        ${(people.length || tags.length || m.event_date) ? `
        <div class="memory-card-chips">
          ${m.event_date ? `<span class="entry-card-tag">📅 ${escHtml(fmtDate(m.event_date))}</span>` : ''}
          ${people.map(p => p.id
            ? `<a class="entry-card-tag memory-person" href="#person/${escHtml(p.id)}">👤 ${escHtml(p.name)}</a>`
            : `<span class="entry-card-tag">👤 ${escHtml(p.name)}</span>`).join('')}
          ${tags.map(t => `<span class="entry-card-tag">${escHtml(t)}</span>`).join('')}
        </div>` : ''}
      </div>
    </div>`;
}

// Tapping a card opens a small sheet to edit or delete it. `memories` is the
// list the cards were rendered from; `onChange` re-renders after a change.
export function wireMemoryCards(root, memories, onChange) {
  root.querySelectorAll('.memory-card').forEach(card => {
    const open = (e) => {
      if (e.target.closest('a')) return; // a person chip navigates instead
      const m = memories.find(x => x.id === card.dataset.memoryId);
      if (m) openMemorySheet(m, onChange);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });
  });
}

function openMemorySheet(m, onChange) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-title">${KIND_EMOJI[m.kind] || '🧠'} ${escHtml(m.title || 'Memory')}</div>
      <textarea class="textarea" id="memory-edit-text" style="min-height:110px;margin-bottom:16px">${escHtml(m.content)}</textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="memory-delete" style="color:var(--color-danger)">Delete</button>
        <button class="btn btn-secondary" id="memory-cancel">Cancel</button>
        <button class="btn btn-primary" id="memory-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelector('#memory-cancel').addEventListener('click', close);

  modal.querySelector('#memory-save').addEventListener('click', async () => {
    const content = modal.querySelector('#memory-edit-text').value.trim();
    if (!content) return;
    if (content === m.content) return close();
    try {
      await api.put(`/api/memories/${m.id}`, { content });
      close();
      showToast('Memory updated');
      onChange?.();
    } catch (err) {
      // Queued by the service worker — it goes through once there's signal.
      if (err.queued) { close(); showToast('Offline — will sync when you’re back online'); return; }
      showToast('Could not save that', 'error');
    }
  });

  modal.querySelector('#memory-delete').addEventListener('click', async () => {
    if (!confirm('Delete this memory? This can\'t be undone.')) return;
    try {
      await api.delete(`/api/memories/${m.id}`);
      close();
      showToast('Memory deleted');
      onChange?.();
    } catch (err) {
      // Queued by the service worker — it goes through once there's signal.
      if (err.queued) { close(); showToast('Offline — will sync when you’re back online'); return; }
      showToast('Could not delete that', 'error');
    }
  });
}
