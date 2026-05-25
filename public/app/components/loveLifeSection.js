// LoveLifeSection — displays love life content with guided prompts

const REFLECTION_PROMPTS = [
  'What actually happened vs. what did you interpret?',
  'What do you genuinely want here?',
  'What\'s the realistic worst case — and can you handle it?',
  'Is this anxiety talking, or a real feeling?',
];

export class LoveLifeSection {
  constructor(analysis = {}) {
    this.analysis = analysis;
  }

  mount(container) {
    const a = this.analysis;
    if (!a.has_love_life_content && !a.love_life_content) {
      container.innerHTML = '';
      return;
    }

    const intensity = a.love_life_emotion_intensity ?? 0;
    const showCooldown = intensity >= 7;

    container.innerHTML = `
      <div class="love-section" id="love-section-card">
        <div class="love-section-header" id="love-header">
          <div class="love-section-title">
            <span>💕</span>
            <span>Love Life</span>
            ${intensity > 0 ? `<span style="font-size:0.75rem;opacity:0.7">· Intensity ${intensity}/10</span>` : ''}
          </div>
          <span id="love-chevron">▼</span>
        </div>
        <div class="love-section-body" id="love-body">
          ${a.love_life_content ? `
            <p>${a.love_life_content}</p>
          ` : ''}

          ${showCooldown ? `
            <div class="cooldown-banner">
              <span>🌊</span>
              <span>This feels intense. Consider re-reading this tomorrow before taking any action.</span>
            </div>
          ` : ''}

          <div class="love-prompts">
            <div style="font-size:0.8125rem;color:var(--color-love);font-weight:600;margin-bottom:4px">
              Reflection prompts
            </div>
            ${REFLECTION_PROMPTS.map(p => `<div class="love-prompt">"${p}"</div>`).join('')}
          </div>
        </div>
      </div>
    `;

    // Toggle open/close
    const card   = container.querySelector('#love-section-card');
    const header = container.querySelector('#love-header');
    const chevron = container.querySelector('#love-chevron');

    header.addEventListener('click', () => {
      card.classList.toggle('open');
      chevron.textContent = card.classList.contains('open') ? '▲' : '▼';
    });
  }
}
