// Journal streak, computed from the entry (and memory) dates themselves.
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

// Monday of the week a day falls in — the key for "one rest day per week".
function weekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return shiftDay(dateStr, -((dow + 6) % 7));
}

// Days that count toward the streak: any day with a journal entry OR a quick
// memory. Both call sites (/api/insights/streaks and /api/orbit-summary) use
// this one query so they can't drift apart again.
const ACTIVE_DATES_SQL = 'SELECT date FROM entries UNION SELECT date FROM memories';

// `dates` — any iterable of active dates (duplicates fine).
// `today`  — the client's local YYYY-MM-DD when known; the user's calendar day
//            is what decides whether a streak is still alive, not the server's.
//
// Rest days: one missed day per week (Mon–Sun) is forgiven, so a single off
// day doesn't wipe out a long streak. A rest day keeps the streak alive but
// doesn't add to it — the number is always "days you actually logged".
// A second miss in the same week, or two misses in a row within a week, breaks it.
function computeStreak(dates, today = serverToday()) {
  const dateSet = new Set([...dates].map(toDateStr).filter(Boolean));
  if (!dateSet.size) return { current: 0, longest: 0, total_days: 0, rest_used_this_week: false };

  // Walk every calendar day from the first logged day forward, like flipping
  // through a diary page by page. The walk stops at today if today is logged,
  // otherwise at yesterday — today isn't over yet, so a blank today shouldn't
  // count as a miss.
  const sorted = [...dateSet].sort();
  const end = dateSet.has(today) ? today : shiftDay(today, -1);
  const last = sorted[sorted.length - 1] > end ? sorted[sorted.length - 1] : end;

  let run = 0;                    // logged days in the streak we're walking
  let longest = 0;
  let restWeeks = new Set();      // weeks whose rest day this streak already used
  for (let day = sorted[0]; day <= last; day = shiftDay(day, 1)) {
    if (dateSet.has(day)) {
      run++;
      if (run > longest) longest = run;
    } else if (run > 0 && !restWeeks.has(weekOf(day))) {
      restWeeks.add(weekOf(day)); // forgiven — streak lives on, number unchanged
    } else {
      run = 0;                    // streak broken
      restWeeks = new Set();
    }
  }

  return {
    current: run,
    longest,
    total_days: dateSet.size,
    // Lets the UI say "rest day used this week" so the rule isn't a mystery.
    rest_used_this_week: run > 0 && restWeeks.has(weekOf(today)),
  };
}

module.exports = { computeStreak, toDateStr, shiftDay, serverToday, ACTIVE_DATES_SQL };
