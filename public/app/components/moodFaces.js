// MoodFaces — a one-tap overall-mood picker (5 faces). Shared by the save flow
// and the entry detail view so "set my mood" is always a single tap, never a
// slider. Each face maps to a representative 0-10 overall value.

const MOOD_FACES = [
  { emoji: '😞', value: 2, label: 'Rough' },
  { emoji: '🙁', value: 4, label: 'Meh'   },
  { emoji: '😐', value: 5, label: 'Okay'  },
  { emoji: '🙂', value: 7, label: 'Good'  },
  { emoji: '😄', value: 9, label: 'Great' },
];

// Which face best represents a given 0-10 overall value (-1 = none selected).
function faceIndexForValue(v) {
  if (v == null) return -1;
  if (v <= 2) return 0;
  if (v <= 4) return 1;
  if (v === 5) return 2;
  if (v <= 7) return 3;
  return 4;
}

// HTML for the faces row. Buttons carry data-value; the caller wires clicks.
export function renderMoodFaces(selectedValue) {
  const sel = faceIndexForValue(selectedValue);
  return `<div class="mood-faces" role="group" aria-label="Overall mood">
    ${MOOD_FACES.map((f, i) => `
      <button type="button" class="mood-face${i === sel ? ' selected' : ''}" data-value="${f.value}" aria-label="${f.label}" title="${f.label}">
        <span class="mood-face-emoji">${f.emoji}</span>
        <span class="mood-face-label">${f.label}</span>
      </button>`).join('')}
  </div>`;
}

// Wire a rendered faces row: calls onPick(value) on tap and moves the selection.
export function wireMoodFaces(root, onPick) {
  const faces = root.querySelectorAll('.mood-face');
  faces.forEach(face => {
    face.addEventListener('click', () => {
      faces.forEach(f => f.classList.remove('selected'));
      face.classList.add('selected');
      onPick(parseInt(face.dataset.value, 10));
    });
  });
}
