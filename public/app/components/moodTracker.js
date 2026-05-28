// MoodTracker — lets user confirm uncertain mood dimensions

export class MoodTracker {
  constructor(mood = {}, onChange = () => {}) {
    this.mood     = mood;
    this.onChange = onChange;
    this.overrides = {};
  }

  mount(container) {
    const uncertain = this.mood.uncertain_dimensions || [];
    if (!uncertain.length) { container.innerHTML = ''; return; }

    container.innerHTML = `
      <div class="card mt-12" style="margin:12px 16px">
        <div class="card-title mb-12">🎚️ Confirm mood details</div>
        <p class="text-sm text-muted mb-12">Nook wasn't sure about these — how would you rate them?</p>
        <div class="mood-tracker-grid" id="mood-sliders"></div>
      </div>
    `;

    const grid = container.querySelector('#mood-sliders');
    grid.innerHTML = uncertain.map(dim => `
      <div class="mood-slider-card">
        <div class="mood-slider-header">
          <span class="mood-slider-label">${capitalize(dim.replace('_', ' '))}</span>
          <span class="mood-slider-value muted" id="val-${dim}">${this.mood[dim] != null ? this.mood[dim] : '—'}</span>
        </div>
        <input type="range" class="range-slider" min="0" max="10" step="1"
          value="${this.mood[dim] ?? 5}"
          data-dim="${dim}"
          id="slider-${dim}">
        <div class="text-xs text-faint" style="margin-top:4px">Drag to set — leave alone if you'd rather not say</div>
      </div>
    `).join('');

    grid.querySelectorAll('input[type=range]').forEach(slider => {
      const dim = slider.dataset.dim;
      const valEl = container.querySelector(`#val-${dim}`);
      slider.addEventListener('input', e => {
        const v = parseInt(e.target.value);
        if (valEl) {
          valEl.textContent = v;
          valEl.classList.remove('muted');
        }
        this.overrides[dim] = v;
        this.onChange(this.overrides);
      });
    });
  }
}

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : '';
}
