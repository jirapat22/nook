// The one place that decides whether an entry was written after the fact, and
// by how many days.
//
// Two views want this (the entry header and the day timeline), and this
// codebase has been bitten three times by the same rule living in more than one
// file — the Groq client drifted into two implementations, escHtml into eleven,
// the streak into three. So it lives here once.
//
// Everything is derived from what every entry already stores: `date` (the day
// being written about) against the local day `created_at` landed on. No new
// column, no migration, and it reads correctly for entries written long before
// this existed.

// Anything written before 4am belongs to the day that just ended. Writing at
// 00:30 about the evening you just had is ordinary journaling, not a backlog,
// and tagging it as one would make the tag meaningless on the nights it fires
// most often.
const GRACE_HOURS = 4;

// Postgres DATE columns come back through pg as full timestamps
// ("2026-08-12T00:00:00.000Z") because no type parser is registered, which is
// why every consumer in this app trims at the T. Returns null on anything that
// isn't a real Y-M-D — lib/streak.js shipped without this check and a junk
// string sailed through into the arithmetic.
function dayPart(value) {
  const s = String(value ?? '').split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Whole days from one Y-M-D to another. Both endpoints go through Date.UTC so a
// DST boundary between them can't turn 24h into 23 and round the wrong way.
function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// The local calendar day a Date falls on. Deliberately not toISOString() —
// that's UTC, and at UTC+7 it names the wrong day for anything before 07:00,
// which is exactly the window the grace period is about.
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A note on `is_backdated`, which this deliberately does NOT consult.
//
// That column stores what the client believed at write time, from its own local
// date, so it is the one signal that survives an offline write: a queued entry
// gets created_at at SYNC time, which makes the lag below over-report. Vetoing
// on the flag would fix that.
//
// It would also break a more common case. The PUT route rewrites `date` but
// never recomputes `is_backdated`, so moving an entry's date backwards leaves
// the flag stale at false — and the veto would then hide a tag that genuinely
// belongs. `updated_at` can't separate the two either: analyze PUTs its summary
// back seconds after almost every save, so nearly every entry looks edited.
//
// Trading a common wrong answer for a rare one is a bad deal, so the flag stays
// stored (it is still the durable record, and the basis of any real fix) and
// unread. Closing the offline gap properly means persisting the client's local
// write date, which routes/entries.js already receives as `today` and discards.

// How many days after the fact this entry was written. 0 means same day, or not
// knowable — either way, callers treat it as "not backlogged".
export function backlogDays(entry) {
  const about = dayPart(entry && entry.date);
  if (!about || !entry || !entry.created_at) return 0;
  const written = new Date(entry.created_at);
  if (Number.isNaN(written.getTime())) return 0;
  // Shift by absolute milliseconds rather than setHours(), so the grace window
  // stays a real four hours across a clock change.
  const journalDay = localDay(new Date(written.getTime() - GRACE_HOURS * 3600000));
  const lag = daysBetween(about, journalDay);
  return lag > 0 ? lag : 0;
}

export function backlogText(days) {
  return days === 1 ? 'written a day later' : `written ${days} days later`;
}

// `variant` picks the presentation, never the rule: 'full' for the entry header
// where there's room to spell it out, 'compact' for the timeline where there
// isn't. Every string here is a literal, so there is nothing to escape.
export function backlogBadge(entry, variant = 'full') {
  const days = backlogDays(entry);
  if (!days) return '';
  const text = backlogText(days);
  return variant === 'compact'
    ? `<span class="backlog-tag" title="${text.charAt(0).toUpperCase() + text.slice(1)}">⏳ ${days}d late</span>`
    : `<span class="backlog-tag">⏳ Backlog · ${text}</span>`;
}
