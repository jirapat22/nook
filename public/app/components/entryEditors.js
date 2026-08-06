// Inline editors for the three things you most often want to fix on an entry:
// its mood, its details (themes / tags / life areas) and the people in it.
//
// Shared by the entry detail view and the day view so both stay in step —
// these started as one implementation inside entry.js, and the day view is
// where you actually land when you tap an entry from Home, so it needed the
// same controls rather than a second copy of them.
//
// Each html() returns a self-contained block; wireEntryEditors() then wires
// whichever of them exist inside the root you pass it. The root is what scopes
// the queries, so the day view can render one set per entry without their
// selectors colliding.

import { api, showToast } from '../app.js';
import { renderMoodFaces, wireMoodFaces } from './moodFaces.js';
import { escHtml } from '../html.js';

const CHIP_FIELDS = [
  { field: 'key_themes', label: 'Themes',     icon: '🧵', chipClass: 'chip-primary', placeholder: 'Add a theme…' },
  { field: 'tags',       label: 'Tags',       icon: '🏷', chipClass: '',             placeholder: 'Add a tag…' },
  { field: 'life_areas', label: 'Life areas', icon: '🧭', chipClass: '',             placeholder: 'Add a life area…' },
];

const asArray = v => Array.isArray(v) ? v : [];

export function moodEditorHtml(entry) {
  // Only nudge to confirm when there's an AI-guessed mood not yet signed off;
  // otherwise this is just a plain mood control.
  const unconfirmed = entry.mood_overall != null
    && !['user_confirmed', 'user_edited'].includes(entry.mood_source);
  const label = unconfirmed
    ? "Nook's guess — tap to change"
    : entry.mood_overall != null ? 'Mood' : 'How did this feel?';
  return `
    <div class="entry-editor-mood" data-editor="mood">
      <span class="chip-edit-label">${label}</span>
      ${renderMoodFaces(entry.mood_overall)}
    </div>`;
}

export function detailsEditorHtml(entry) {
  return `
    <div data-editor="details">
      ${CHIP_FIELDS.map(f => chipRowHtml(f, asArray(entry[f.field]))).join('')}
    </div>`;
}

export function peopleEditorHtml(entry) {
  const mentions = asArray(entry.people_mentions);
  return `
    <div data-editor="people">
      <span class="chip-edit-label">People</span>
      <div class="entry-people-list">
        ${mentions.map(m => `
          <span class="entry-person-chip">
            <a href="#person/${m.person_id}" class="entry-person-link">
              <span class="entry-person-name">${escHtml(m.name)}</span>
              ${m.relationship_type ? `<span class="entry-person-rel">${escHtml(m.relationship_type)}</span>` : ''}
            </a>
            <button class="person-unlink-btn" data-mention-id="${m.id}" data-name="${escHtml(m.name)}" title="Remove from this entry">×</button>
          </span>`).join('')}
        <button class="chip-add-btn" data-add-person="1" title="Add a person">+</button>
      </div>
    </div>`;
}

// One editable chip row. Every chip carries an ×; the + swaps itself for a
// text input. Written once and reused for all three fields.
function chipRowHtml({ field, label, icon, chipClass, placeholder }, values) {
  return `
    <div class="chip-edit-group">
      <span class="chip-edit-label">${label}</span>
      <div class="meta-chip-row">
        ${values.map(v => `
          <span class="chip ${chipClass}">${icon} ${escHtml(v)}<button class="chip-remove" data-field="${field}" data-value="${escHtml(v)}" title="Remove ${escHtml(v)}">×</button></span>`).join('')}
        <button class="chip-add-btn" data-field="${field}" title="Add">+</button>
        <input type="text" class="input chip-add-input hidden" data-field="${field}" placeholder="${placeholder}">
      </div>
    </div>`;
}

// Wire every editor found inside `root` for `entry`. onChanged() runs after any
// successful save (and after a cancel, so the + reappears) — the host view
// decides how to re-render.
export function wireEntryEditors(root, entry, onChanged) {
  const entryId = entry.id;
  const refresh = () => Promise.resolve(onChanged?.());

  const save = async (patch, successMsg) => {
    try {
      await api.put(`/api/entries/${entryId}`, patch);
    } catch {
      showToast('Could not save — try again', 'error');
      return;
    }
    // Refresh outside the try: the write already succeeded, so a failure to
    // re-render (a network blip on the refetch) must not report itself as
    // "could not save" on a change that did land.
    if (successMsg) showToast(successMsg, 'success');
    await refresh();
  };

  // ── Mood ──
  const faces = root.querySelector('[data-editor="mood"] .mood-faces');
  if (faces) {
    wireMoodFaces(faces, v => save({ mood_overall: v, mood_source: 'user_edited' }));
  }

  // ── Details chips ──
  const current = field => asArray(entry[field]);

  root.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const { field, value } = btn.dataset;
      save({ [field]: current(field).filter(v => v !== value) });
    });
  });

  root.querySelectorAll('.chip-add-btn[data-field]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = root.querySelector(`.chip-add-input[data-field="${btn.dataset.field}"]`);
      if (!input) return;
      btn.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
    });
  });

  root.querySelectorAll('.chip-add-input').forEach(input => {
    const field = input.dataset.field;
    let done = false; // both Enter and the follow-on blur fire; only act once
    const commit = () => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      // Re-render on cancel/duplicate too, so the + comes back and the input
      // clears without needing a bespoke reset path.
      if (!value || current(field).includes(value)) return refresh();
      return save({ [field]: [...current(field), value] });
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; refresh(); }
    });
    input.addEventListener('blur', commit);
  });

  // ── People ──
  root.querySelectorAll('.person-unlink-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { mentionId, name } = btn.dataset;
      if (!confirm(`Remove ${name} from this entry?`)) return;
      try {
        // Same endpoint as the person profile's unlink — it also strips the
        // name from detected_people so it can't resurface as "Nook spotted".
        await api.delete(`/api/people/mention/${mentionId}`);
      } catch {
        showToast('Could not remove', 'error');
        return;
      }
      showToast(`Removed ${name}`, '');
      await refresh();
    });
  });

  root.querySelector('[data-add-person]')?.addEventListener('click', () => {
    showLinkPersonModal(entryId, refresh);
  });
}

// Pick or create a person and link them to this entry. onLinked() runs on
// success so the caller can re-render.
export async function showLinkPersonModal(entryId, onLinked) {
  let allPeople = [];
  try { allPeople = await api.get('/api/people'); } catch {}

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-handle"></div>
      <div class="modal-title">Link a person to this entry</div>

      <div class="form-group">
        <label class="form-label">Pick an existing person</label>
        <select class="select input" id="link-person-select">
          <option value="">— Choose —</option>
          ${allPeople.map(p => `<option value="${p.id}">${escHtml(p.name)}${p.relationship_type ? ' · ' + escHtml(p.relationship_type) : ''}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">How were they mentioned? (optional)</label>
        <input type="text" class="input" id="link-person-context" placeholder="e.g. had lunch with Honda">
      </div>

      <details style="margin-bottom:12px">
        <summary style="font-size:0.85rem;color:var(--color-text-muted);cursor:pointer">+ Create & link a new person</summary>
        <div class="form-group" style="margin-top:10px">
          <input type="text" class="input" id="link-new-name" placeholder="Name" style="margin-bottom:6px">
          <select class="select input" id="link-new-rel">
            ${['friend','family','crush','partner','colleague','pet','group','acquaintance','unknown'].map(t =>
              `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
          </select>
        </div>
      </details>

      <div class="modal-actions">
        <button class="btn btn-secondary" id="link-cancel">Cancel</button>
        <button class="btn btn-primary" id="link-save">Link</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const cleanup = () => modal.remove();
  modal.querySelector('#link-cancel').addEventListener('click', cleanup);
  modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });

  modal.querySelector('#link-save').addEventListener('click', async () => {
    const existingId = modal.querySelector('#link-person-select').value;
    const context    = modal.querySelector('#link-person-context').value.trim();
    const newName    = modal.querySelector('#link-new-name').value.trim();
    const newRel     = modal.querySelector('#link-new-rel').value;

    let personId = existingId;
    let personName = allPeople.find(p => p.id === existingId)?.name || '';

    if (!personId && newName) {
      try {
        const created = await api.post('/api/people', { name: newName, relationship_type: newRel });
        personId   = created.id;
        personName = created.name;
      } catch {
        showToast('Could not create person', 'error');
        return;
      }
    }

    if (!personId) { showToast('Pick or create a person first', ''); return; }

    const saveBtn = modal.querySelector('#link-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Linking…';

    try {
      await api.post('/api/people/link-mention', {
        person_id: personId,
        entry_id: entryId,
        context: context || null,
        sentiment_score: null,
        facts_extracted: [],
        emotion_toward: null,
        link_method: 'manual',
      });
    } catch {
      showToast('Could not link — try again', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Link';
      return;
    }
    // Everything past here is outside the try, same as save() above: the link
    // already landed, so a failing re-render must not report itself as "could
    // not link" — and it can't, since the catch used to run against a modal
    // that had just been removed.
    modal.remove();
    showToast(`Linked ${personName} to this entry ✓`, 'success');
    await onLinked?.();
  });
}

