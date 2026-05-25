import { api, showToast } from '../app.js';

export class PeopleView {
  constructor() {}

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
      const people = await api.get('/api/people');
      if (!people.length) {
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

      listContainer.innerHTML = `<div class="people-list">${people.map(p => personCard(p)).join('')}</div>`;
      listContainer.querySelectorAll('.person-card').forEach(card => {
        card.addEventListener('click', () => {
          location.hash = `#person/${card.dataset.id}`;
        });
      });
    } catch {
      listContainer.innerHTML = `<div class="empty-state"><div class="empty-state-icon">😕</div><p>Could not load people</p></div>`;
    }
  }

  showAddModal(prefill = {}) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Add person</div>
        <div class="form-group">
          <label class="form-label">Name or nickname</label>
          <input type="text" class="input" id="person-name" value="${prefill.name || ''}" placeholder="e.g. Alex, Mum, Work Dave">
        </div>
        <div class="form-group">
          <label class="form-label">Relationship</label>
          <select class="select input" id="person-type">
            ${['friend','family','crush','partner','colleague','mentor','acquaintance','unknown'].map(t =>
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
    modal.querySelector('#modal-save').addEventListener('click', async () => {
      const name = modal.querySelector('#person-name').value.trim();
      if (!name) { showToast('Name is required', ''); return; }
      try {
        await api.post('/api/people', {
          name,
          relationship_type: modal.querySelector('#person-type').value,
          notes: modal.querySelector('#person-notes').value.trim(),
        });
        modal.remove();
        showToast('Person added!', 'success');
        await this.loadPeople();
      } catch {
        showToast('Could not add person', 'error');
      }
    });

    modal.querySelector('#person-name').focus();
  }

  destroy() {}
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
          <div class="person-profile-avatar">${initials}</div>
          <div class="person-profile-title">
            <h2>${person.name}</h2>
            <p>${person.relationship_type ? capitalize(person.relationship_type) : 'Person'} · ${person.mention_count || 0} mention${person.mention_count !== 1 ? 's' : ''}</p>
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
  }

  showEditModal(person) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Edit ${person.name}</div>
        <div class="form-group">
          <label class="form-label">Name</label>
          <input type="text" class="input" id="edit-name" value="${person.name}">
        </div>
        <div class="form-group">
          <label class="form-label">Relationship</label>
          <select class="select input" id="edit-type">
            ${['friend','family','crush','partner','colleague','mentor','acquaintance','unknown'].map(t =>
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
    modal.querySelector('#edit-save').addEventListener('click', async () => {
      try {
        await api.put(`/api/people/${this.personId}`, {
          name: modal.querySelector('#edit-name').value.trim(),
          relationship_type: modal.querySelector('#edit-type').value,
          notes: modal.querySelector('#edit-notes').value.trim(),
        });
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

  return `
    <div class="person-card" data-id="${p.id}">
      <div class="person-avatar">${initials}</div>
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
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
