import { api, showToast } from '../app.js';

export class PeopleView {
  constructor() {
    this.activeFilter = 'all';
    this.people = [];
  }

  async mount(container) {
    this.container = container;
    container.innerHTML = `
      <div class="people-view">
        <div class="page-header" style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1>People</h1>
            <p>Relationships & connections</p>
          </div>
          <button class="btn btn-primary btn-sm" id="add-person-btn">+ Add</button>
        </div>
        <div class="people-filter-bar" id="people-filter-bar"></div>
        <div id="people-list-container"></div>
      </div>
    `;

    container.querySelector('#add-person-btn').addEventListener('click', () => this.showAddModal());
    await this.loadPeople();
  }

  async loadPeople() {
    const listContainer = this.container.querySelector('#people-list-container');
    listContainer.innerHTML = '<div class="loading-spinner"></div>';

    try {
      this.people = await api.get('/api/people');
      if (!this.people.length) {
        this.container.querySelector('#people-filter-bar').innerHTML = '';
        listContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">👥</div>
            <h3>No people tracked yet</h3>
            <p>When you mention people in entries, Nook will suggest adding them here.</p>
            <button class="btn btn-primary btn-sm mt-12" id="empty-add-btn">Add someone</button>
          </div>`;
        listContainer.querySelector('#empty-add-btn')?.addEventListener('click', () => this.showAddModal());
        return;
      }

      this.renderFilterBar();
      this.renderList();
    } catch {
      listContainer.innerHTML = `<div class="empty-state"><div class="empty-state-icon">😕</div><p>Could not load people</p></div>`;
    }
  }

  renderFilterBar() {
    // Count people per relationship type and only show chips for groups that exist
    const counts = { all: this.people.length };
    for (const p of this.people) {
      const rel = p.relationship_type || 'unknown';
      counts[rel] = (counts[rel] || 0) + 1;
    }
    const groups = ['all', 'friend', 'family', 'partner', 'crush', 'colleague', 'pet', 'group', 'acquaintance', 'unknown'];
    const chips = groups.filter(g => counts[g] > 0).map(g => `
      <button class="people-filter-chip ${this.activeFilter === g ? 'active' : ''}" data-filter="${g}">
        ${g === 'all' ? 'All' : g[0].toUpperCase() + g.slice(1)}
        <span class="people-filter-count">${counts[g]}</span>
      </button>`).join('');
    const bar = this.container.querySelector('#people-filter-bar');
    bar.innerHTML = chips;
    bar.querySelectorAll('.people-filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.activeFilter = chip.dataset.filter;
        this.renderFilterBar();
        this.renderList();
      });
    });
  }

  renderList() {
    const listContainer = this.container.querySelector('#people-list-container');
    const filtered = this.activeFilter === 'all'
      ? this.people
      : this.people.filter(p => (p.relationship_type || 'unknown') === this.activeFilter);

    if (!filtered.length) {
      listContainer.innerHTML = `<div class="empty-state" style="padding:24px 0"><p class="text-muted">No people in this category yet.</p></div>`;
      return;
    }

    listContainer.innerHTML = `<div class="people-list">${filtered.map(p => personCard(p)).join('')}</div>`;
    listContainer.querySelectorAll('.person-card').forEach(card => {
      card.addEventListener('click', () => {
        location.hash = `#person/${card.dataset.id}`;
      });
    });
  }

  showAddModal(prefill = {}) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Add person</div>
        <div class="form-group photo-upload-group">
          <div class="photo-upload-preview" id="photo-preview">
            <span class="photo-upload-initials">?</span>
          </div>
          <div class="photo-upload-actions">
            <label class="btn btn-secondary btn-sm" for="photo-file-input">📷 Add photo</label>
            <button type="button" class="btn btn-ghost btn-sm hidden" id="photo-remove">Remove</button>
            <input type="file" id="photo-file-input" accept="image/*" style="display:none">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Full name</label>
          <input type="text" class="input" id="person-name" value="${prefill.name || ''}" placeholder="e.g. Rafaella, Mum, Work Alex">
        </div>
        <div class="form-group">
          <label class="form-label">Nicknames &amp; aliases</label>
          <input type="text" class="input" id="person-aliases" value="${(prefill.aliases || []).join(', ')}" placeholder="e.g. Raf, Ella — separate with commas">
          <div id="nickname-suggestions" style="margin-top:6px"></div>
          <div style="font-size:0.75rem;color:var(--color-text-faint);margin-top:4px">Nook will recognise all of these names in your entries</div>
        </div>
        <div class="form-group">
          <label class="form-label">Relationship</label>
          <select class="select input" id="person-type">
            ${['friend','family','crush','partner','colleague','pet','group','acquaintance','unknown'].map(t =>
              `<option value="${t}" ${prefill.relationship_type === t ? 'selected' : ''}>${capitalize(t)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Notes (optional)</label>
          <textarea class="textarea" id="person-notes" placeholder="Anything you want to remember..." style="min-height:80px"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-save">Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#modal-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    // Photo upload handling
    let photoDataUrl = prefill.photo_url || null;
    const preview = modal.querySelector('#photo-preview');
    const removeBtn = modal.querySelector('#photo-remove');
    const nameInputForInitials = () => modal.querySelector('#person-name').value;
    const setPreview = (url) => {
      if (url) {
        preview.innerHTML = `<img src="${url}" alt="">`;
        removeBtn.classList.remove('hidden');
      } else {
        const initials = (nameInputForInitials() || '?').split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase();
        preview.innerHTML = `<span class="photo-upload-initials">${initials || '?'}</span>`;
        removeBtn.classList.add('hidden');
      }
    };
    setPreview(photoDataUrl);
    modal.querySelector('#person-name')?.addEventListener('input', () => { if (!photoDataUrl) setPreview(null); });
    modal.querySelector('#photo-file-input').addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        photoDataUrl = await resizeImageToDataUrl(file, 240);
        setPreview(photoDataUrl);
      } catch {
        showToast('Could not load image', 'error');
      }
    });
    removeBtn.addEventListener('click', () => { photoDataUrl = null; setPreview(null); });

    modal.querySelector('#modal-save').addEventListener('click', async () => {
      const name = modal.querySelector('#person-name').value.trim();
      if (!name) { showToast('Name is required', ''); return; }
      const aliases = modal.querySelector('#person-aliases').value
        .split(',').map(s => s.trim()).filter(s => s.length > 0);
      try {
        await api.post('/api/people', {
          name,
          aliases,
          relationship_type: modal.querySelector('#person-type').value,
          notes: modal.querySelector('#person-notes').value.trim(),
          photo_url: photoDataUrl,
        });
        modal.remove();
        showToast('Person added!', 'success');
        await this.loadPeople();
      } catch {
        showToast('Could not add person', 'error');
      }
    });

    // Auto-suggest common nicknames as the user types the name
    const nameInput      = modal.querySelector('#person-name');
    const aliasesInput   = modal.querySelector('#person-aliases');
    const suggestionsDiv = modal.querySelector('#nickname-suggestions');
    const updateSuggestions = () => {
      const name = nameInput.value.trim().toLowerCase();
      const currentAliases = aliasesInput.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const suggestions = getNicknamesFor(name).filter(n => !currentAliases.includes(n));
      if (!suggestions.length) { suggestionsDiv.innerHTML = ''; return; }
      suggestionsDiv.innerHTML = `
        <div style="font-size:0.7rem;color:var(--color-text-muted);margin-bottom:4px">Also known as:</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${suggestions.map(n => `<button type="button" class="nickname-suggest" data-name="${n}">+ ${n}</button>`).join('')}
        </div>`;
      suggestionsDiv.querySelectorAll('.nickname-suggest').forEach(btn => {
        btn.addEventListener('click', () => {
          const current = aliasesInput.value.trim();
          const prefix  = current && !current.endsWith(',') ? current + ', ' : current;
          aliasesInput.value = prefix + btn.dataset.name;
          updateSuggestions();
        });
      });
    };
    nameInput.addEventListener('input', updateSuggestions);
    aliasesInput.addEventListener('input', updateSuggestions);
    updateSuggestions();

    nameInput.focus();
  }

  destroy() {}
}

// Common English nickname ↔ formal-name pairs (lowercase, bidirectional).
// Kept in sync with entry.js NICKNAME_GROUPS — duplicated rather than imported
// to avoid an extra HTTP round-trip in this small app.
const NICKNAME_GROUPS = [
  ['michael', 'mike', 'mick', 'mickey'],
  ['robert', 'bob', 'bobby', 'rob', 'robbie'],
  ['william', 'bill', 'billy', 'will', 'willie'],
  ['richard', 'rick', 'ricky', 'dick'],
  ['elizabeth', 'liz', 'lizzy', 'beth', 'betty', 'eliza', 'ellie', 'libby'],
  ['henry', 'hank', 'harry'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny'],
  ['jonathan', 'jon', 'jonny'],
  ['margaret', 'peggy', 'maggie', 'meg'],
  ['sarah', 'sally', 'sara'],
  ['thomas', 'tom', 'tommy'],
  ['nicholas', 'nick', 'nicky'],
  ['anthony', 'tony'],
  ['steven', 'stephen', 'steve', 'stevie'],
  ['christopher', 'chris', 'christie'],
  ['christina', 'chris', 'tina', 'christy'],
  ['alexander', 'alex', 'al', 'xander'],
  ['alexandra', 'alex', 'sandra', 'sasha'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam', 'sammy'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy'],
  ['daniel', 'dan', 'danny'],
  ['benjamin', 'ben', 'benji'],
  ['joseph', 'joe', 'joey'],
  ['matthew', 'matt', 'matty'],
  ['andrew', 'andy', 'drew'],
  ['patricia', 'pat', 'patty', 'tricia'],
  ['rebecca', 'becky', 'becca'],
  ['katherine', 'kate', 'katie', 'kathy', 'kat'],
  ['catherine', 'cathy', 'kate', 'katie', 'cat'],
  ['jennifer', 'jen', 'jenny'],
  ['stephanie', 'steph', 'stephie'],
  ['charles', 'charlie', 'chuck'],
  ['dorothy', 'dot', 'dotty', 'dory'],
  ['rafaella', 'raf', 'raph', 'ella', 'rafa'],
  ['gabriella', 'gabby', 'ella', 'gabi'],
  ['isabella', 'isa', 'bella', 'izzy'],
];

// Read an image file, downscale to fit in `maxSize` px (longest side), return
// data URL. Keeps photo storage tiny (~10-30KB JPEG) so we can keep them inline
// in the database without needing object storage.
function resizeImageToDataUrl(file, maxSize = 240) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function getNicknamesFor(name) {
  if (!name || name.length < 3) return [];
  // Only suggest from the FIRST word (handles "Mike Smith" → still suggests Michael)
  const firstWord = name.split(/\s+/)[0].toLowerCase();
  const group = NICKNAME_GROUPS.find(g => g.includes(firstWord));
  return group ? group.filter(n => n !== firstWord) : [];
}

export class PersonView {
  constructor(params = []) {
    this.personId = params[0];
    this.chart = null;
    this.container = null;
  }

  async mount(container) {
    this.container = container;
    if (!this.personId) { location.hash = '#people'; return; }

    try {
      const person = await api.get(`/api/people/${this.personId}`);
      this.renderProfile(container, person);
    } catch {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">😕</div><h3>Person not found</h3><a href="#people" class="btn btn-primary btn-sm mt-12">Back</a></div>`;
    }
  }

  renderProfile(container, person) {
    const initials = person.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const avgSentiment = person.avg_sentiment ?? 0;
    const sentClass = avgSentiment > 1 ? 'positive' : avgSentiment < -1 ? 'negative' : 'neutral';
    const sentIcon  = avgSentiment > 1 ? '😊' : avgSentiment < -1 ? '😟' : '😐';

    container.innerHTML = `
      <div class="person-profile">
        <div class="back-btn" id="back-btn">← People</div>

        <div class="person-profile-header">
          <div class="person-profile-avatar${person.photo_url ? ' has-photo' : ''}">${person.photo_url ? `<img src="${person.photo_url}" alt="">` : initials}</div>
          <div class="person-profile-title">
            <h2>${person.name}</h2>
            <p>${person.relationship_type ? capitalize(person.relationship_type) : 'Person'} · ${person.mention_count || 0} mention${person.mention_count !== 1 ? 's' : ''}</p>
            ${Array.isArray(person.aliases) && person.aliases.length ? `
              <p style="font-size:0.8rem;color:var(--color-text-faint);margin-top:2px">
                Also: ${person.aliases.join(', ')}
              </p>` : ''}
          </div>
        </div>

        ${person.notes ? `
        <div class="card mb-12">
          <div class="ai-section-label">Notes</div>
          <p style="font-size:0.9375rem;line-height:1.65">${person.notes}</p>
        </div>` : ''}

        ${person.all_facts?.length ? `
        <div class="card mb-12">
          <div class="ai-section-label">What I know about ${person.name}</div>
          <div class="facts-list mt-8">
            ${person.all_facts.map(f => `<span class="fact-chip">${f}</span>`).join('')}
          </div>
        </div>` : ''}

        ${person.emotion_breakdown?.length ? `
        <div class="card mb-12">
          <div class="ai-section-label">How I feel around ${person.name}</div>
          <div class="tags-row mt-8">
            ${person.emotion_breakdown.map(e => `
              <span class="chip">${e.emotion_toward} <span style="color:var(--color-text-faint);margin-left:3px">${e.count}×</span></span>`
            ).join('')}
          </div>
        </div>` : ''}

        ${person.mentions?.length ? `
        <div class="card mb-12">
          <div class="ai-section-label" style="margin-bottom:12px">Recent Mentions</div>
          <div class="mentions-timeline" id="mentions-timeline">
            ${person.mentions.map((m, i) => `
              <div class="mention-item">
                <div class="mention-line">
                  <div class="mention-dot"></div>
                  ${i < person.mentions.length - 1 ? '<div class="mention-tail"></div>' : ''}
                </div>
                <div class="mention-content">
                  <div class="mention-date">${formatDate(m.date)}</div>
                  <div class="mention-context">${m.context || m.entry_preview || ''}</div>
                  ${m.emotion_toward ? `<span class="mention-emotion">${m.emotion_toward}</span>` : ''}
                </div>
              </div>`
            ).join('')}
          </div>
        </div>` : `
        <div class="empty-state" style="padding:32px 0">
          <div class="empty-state-icon">📝</div>
          <p>${person.name} hasn't been mentioned in any entries yet</p>
        </div>`}

        <div class="entry-detail-actions">
          <button class="btn btn-secondary btn-sm" id="edit-person-btn">Edit</button>
          <button class="btn btn-secondary btn-sm" id="merge-person-btn">Merge into…</button>
          <button class="btn btn-danger btn-sm" id="delete-person-btn">Delete</button>
        </div>
      </div>
    `;

    container.querySelector('#back-btn').addEventListener('click', () => { location.hash = '#people'; });
    container.querySelector('#delete-person-btn').addEventListener('click', async () => {
      if (!confirm(`Delete ${person.name}? All their mentions will be removed.`)) return;
      await api.delete(`/api/people/${this.personId}`);
      showToast('Person removed', '');
      location.hash = '#people';
    });
    container.querySelector('#edit-person-btn').addEventListener('click', () => {
      this.showEditModal(person);
    });
    container.querySelector('#merge-person-btn').addEventListener('click', () => {
      this.showMergeModal(person);
    });
  }

  async showMergeModal(person) {
    let people;
    try {
      people = await api.get('/api/people');
    } catch {
      showToast('Could not load people', 'error');
      return;
    }
    const others = people.filter(p => p.id !== person.id);
    if (!others.length) {
      showToast('No other people to merge into', '');
      return;
    }
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Merge ${person.name} into…</div>
        <p style="font-size:0.875rem;color:var(--color-text-muted);margin-bottom:16px">
          <strong>${person.name}</strong> will be deleted. Their mentions &amp; name will move to the chosen person.
        </p>
        <div class="form-group">
          <label class="form-label">Merge into</label>
          <select class="select input" id="merge-target">
            ${others.map(p => `<option value="${p.id}">${p.name}${Array.isArray(p.aliases) && p.aliases.length ? ` (${p.aliases.join(', ')})` : ''}</option>`).join('')}
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="merge-cancel">Cancel</button>
          <button class="btn btn-danger" id="merge-confirm">Merge &amp; delete ${person.name}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#merge-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#merge-confirm').addEventListener('click', async () => {
      const targetId = modal.querySelector('#merge-target').value;
      const targetName = others.find(p => String(p.id) === String(targetId))?.name || 'them';
      if (!confirm(`Merge "${person.name}" into "${targetName}"?\nThis cannot be undone — ${person.name} will be deleted.`)) return;
      try {
        await api.post(`/api/people/${this.personId}/merge`, { target_id: targetId });
        modal.remove();
        showToast(`Merged ${person.name} into ${targetName} ✓`, 'success');
        location.hash = `#person/${targetId}`;
      } catch {
        showToast('Could not merge people', 'error');
      }
    });
  }

  showEditModal(person) {
    const existingAliases = Array.isArray(person.aliases) ? person.aliases : [];
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    const initials = person.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Edit ${person.name}</div>
        <div class="form-group photo-upload-group">
          <div class="photo-upload-preview" id="edit-photo-preview">
            ${person.photo_url ? `<img src="${person.photo_url}" alt="">` : `<span class="photo-upload-initials">${initials}</span>`}
          </div>
          <div class="photo-upload-actions">
            <label class="btn btn-secondary btn-sm" for="edit-photo-file">📷 ${person.photo_url ? 'Change' : 'Add'} photo</label>
            <button type="button" class="btn btn-ghost btn-sm ${person.photo_url ? '' : 'hidden'}" id="edit-photo-remove">Remove</button>
            <input type="file" id="edit-photo-file" accept="image/*" style="display:none">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Full name</label>
          <input type="text" class="input" id="edit-name" value="${person.name}">
        </div>
        <div class="form-group">
          <label class="form-label">Nicknames &amp; aliases</label>
          <input type="text" class="input" id="edit-aliases" value="${existingAliases.join(', ')}" placeholder="e.g. Raf, Ella — separate with commas">
          <div style="font-size:0.75rem;color:var(--color-text-faint);margin-top:4px">Nook will recognise all of these names in your entries</div>
        </div>
        <div class="form-group">
          <label class="form-label">Relationship</label>
          <select class="select input" id="edit-type">
            ${['friend','family','crush','partner','colleague','pet','group','acquaintance','unknown'].map(t =>
              `<option value="${t}" ${person.relationship_type === t ? 'selected' : ''}>${capitalize(t)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea class="textarea" id="edit-notes" style="min-height:80px">${person.notes || ''}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="edit-cancel">Cancel</button>
          <button class="btn btn-primary" id="edit-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#edit-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    // Photo upload in edit modal
    let photoDataUrl = person.photo_url || null;
    let photoChanged = false; // only send photo_url if user touched it
    const preview = modal.querySelector('#edit-photo-preview');
    const removeBtn = modal.querySelector('#edit-photo-remove');
    const renderPreview = () => {
      if (photoDataUrl) {
        preview.innerHTML = `<img src="${photoDataUrl}" alt="">`;
        removeBtn.classList.remove('hidden');
      } else {
        preview.innerHTML = `<span class="photo-upload-initials">${initials}</span>`;
        removeBtn.classList.add('hidden');
      }
    };
    modal.querySelector('#edit-photo-file').addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        photoDataUrl = await resizeImageToDataUrl(file, 240);
        photoChanged = true;
        renderPreview();
      } catch {
        showToast('Could not load image', 'error');
      }
    });
    removeBtn.addEventListener('click', () => {
      photoDataUrl = null;
      photoChanged = true;
      renderPreview();
    });

    modal.querySelector('#edit-save').addEventListener('click', async () => {
      const aliases = modal.querySelector('#edit-aliases').value
        .split(',').map(s => s.trim()).filter(s => s.length > 0);
      const payload = {
        name: modal.querySelector('#edit-name').value.trim(),
        aliases,
        relationship_type: modal.querySelector('#edit-type').value,
        notes: modal.querySelector('#edit-notes').value.trim(),
      };
      if (photoChanged) payload.photo_url = photoDataUrl;
      try {
        await api.put(`/api/people/${this.personId}`, payload);
        modal.remove();
        const updated = await api.get(`/api/people/${this.personId}`);
        this.renderProfile(this.container, updated);
        showToast('Updated!', 'success');
      } catch {
        showToast('Could not update', 'error');
      }
    });
  }

  destroy() {
    this.chart?.destroy?.();
  }
}

function personCard(p) {
  const initials = p.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  const lastMentioned = p.last_mentioned
    ? new Date(p.last_mentioned).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : 'Never mentioned';
  const sentiment = parseFloat(p.avg_sentiment) || 0;
  const sentCls = sentiment > 1 ? 'sentiment-positive' : sentiment < -1 ? 'sentiment-negative' : 'sentiment-neutral';
  const sentIcon = sentiment > 1 ? '😊' : sentiment < -1 ? '😟' : '😐';
  const avatarInner = p.photo_url ? `<img src="${p.photo_url}" alt="">` : initials;

  return `
    <div class="person-card" data-id="${p.id}">
      <div class="person-avatar${p.photo_url ? ' has-photo' : ''}">${avatarInner}</div>
      <div class="person-info">
        <div class="person-name">${p.name}</div>
        <div class="person-meta">
          <span>${p.relationship_type ? capitalize(p.relationship_type) : '—'}</span>
          <span>·</span>
          <span>${p.mention_count || 0} mentions</span>
          <span class="sentiment-indicator ${sentCls}">${sentIcon}</span>
        </div>
        <div class="text-xs text-faint mt-4">Last: ${lastMentioned}</div>
      </div>
    </div>`;
}

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : '';
}

function formatDate(dateStr) {
  // Use local date constructor to avoid UTC off-by-one in UTC+7
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
