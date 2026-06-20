// Activity tags — the fixed set the AI uses (must match routes/ai.js) plus the
// emoji/label mapping and helpers for the glanceable "what I did" chip rows.

// Insertion order is also the display order for the chip row.
const ACTIVITY_META = {
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
const ACTIVITY_ORDER = Object.keys(ACTIVITY_META);

// Union of activity keys across a day's entries, ordered and capped for display.
export function dayActivityKeys(entries) {
  const set = new Set();
  for (const e of (entries || [])) for (const k of (e.activities || [])) set.add(k);
  return ACTIVITY_ORDER.filter(k => set.has(k)).slice(0, 6);
}

// HTML for a chip row. Unknown keys are skipped. Returns '' when nothing to show.
export function renderActivityChips(keys) {
  const chips = (keys || [])
    .filter(k => ACTIVITY_META[k])
    .map(k => `<span class="activity-chip">${ACTIVITY_META[k].emoji} ${ACTIVITY_META[k].label}</span>`);
  return chips.length ? `<div class="day-card-activities">${chips.join('')}</div>` : '';
}
