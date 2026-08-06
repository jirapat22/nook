// Journal streak, computed from the entry dates themselves.
//
// There used to be three of these: a stored `settings.streak_count` counter
// incremented on save, a recomputation in /api/insights/streaks, and a third
// inline copy in /api/orbit-summary. The stored counter was the one that
// caused the visible bug — it was only ever written when an entry was saved,
// so it never decayed, and the badge kept showing 68 for days after the streak
// had actually broken. A derived number can't go stale, so this is the only
// implementation now and the counter is gone.
//
// All arithmetic is string-based over YYYY-MM-DD via Date.UTC, so it can't
// drift with the host timezone (see the TZ pin at the top of server.js).

// Normalise whatever the DATE column hands back — node-postgres gives a JS
// Date, a JSON round-trip gives an ISO string — to YYYY-MM-DD.
function toDateStr(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    // Validate the shape rather than trusting the split — an unparseable
    // string used to survive as its own "date" and inflate total_days.
    const s = value.split('T')[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function shiftDay(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().split('T')[0];
}

// Server's own calendar day, for when the client didn't send its local one.
function serverToday() {
  return new Date().toISOString().split('T')[0];
}

// `dates` — any iterable of entry dates (duplicates fine).
// `today`  — the client's local YYYY-MM-DD when known; the user's calendar day
//            is what decides whether a streak is still alive, not the server's.
function computeStreak(dates, today = serverToday()) {
  const dateSet = new Set([...dates].map(toDateStr).filter(Boolean));
  if (!dateSet.size) return { current: 0, longest: 0, total_days: 0 };

  // A streak is still alive if they wrote today OR yesterday — today isn't
  // over yet, so a blank today shouldn't retroactively break it.
  const yesterday = shiftDay(today, -1);
  let cursor = dateSet.has(today) ? today : dateSet.has(yesterday) ? yesterday : null;
  let current = 0;
  while (cursor && dateSet.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }

  const sorted = [...dateSet].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = shiftDay(sorted[i - 1], 1) === sorted[i] ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  return { current, longest, total_days: dateSet.size };
}

module.exports = { computeStreak, toDateStr, shiftDay, serverToday };
