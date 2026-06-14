// Activity tags — the fixed set the AI uses (must match routes/ai.js) plus the
// emoji/label mapping and helpers for the glanceable "what I did" chip rows.

export const ACTIVITY_META = {
  work:     { emoji: '💼', label: 'Work' },
  gym:      { emoji: '🏋️', label: 'Gym' },
  social:   { emoji: '👥', label: 'Social' },
  family:   { emoji: '👨‍👩‍👧', label: 'Family' },
  food:     { emoji: '🍽️', label: 'Food' },
  shopping: { emoji: '🛒', label: 'Shopping' },
  chores:   { emoji: '🧹', label: 'Chores' },
  travel:   { emoji: '✈️', label: 'Travel' },
  hobby:    { emoji: '🎮', label: 'Hobby' },
  rest:     { emoji: '😌', label: 'Rest' },
  health:   { emoji: '🩺', label: 'Health' },
  study:    { emoji: '📚', label: 'Study' },
  date:     { emoji: '❤️', label: 'Date' },
  outdoors: { emoji: '🌳', label: 'Outdoors' },
};

// Canonical display order for the chip row.
export const ACTIVITY_ORDER = ['work','gym','social','family','food','shopping','chores','travel','hobby','rest','health','study','date','outdoors'];

// Union of activity keys across a day's entries, ordered and capped for display.
export function dayActivityKeys(entries, cap = 6) {
  const set = new Set();
  for (const e of (entries || [])) for (const k of (e.activities || [])) set.add(k);
  return ACTIVITY_ORDER.filter(k => set.has(k)).slice(0, cap);
}

// HTML for a chip row. Unknown keys are skipped. Returns '' when nothing to show.
export function renderActivityChips(keys, wrapClass = 'day-card-activities') {
  const chips = (keys || [])
    .filter(k => ACTIVITY_META[k])
    .map(k => `<span class="activity-chip">${ACTIVITY_META[k].emoji} ${ACTIVITY_META[k].label}</span>`);
  return chips.length ? `<div class="${wrapClass}">${chips.join('')}</div>` : '';
}
