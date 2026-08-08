// Fire-and-forget push to the Orbit life-map hub.
// Reads ORBIT_URL + ORBIT_INGEST_SECRET from env. If either is missing or the
// request fails, log a warning and move on — never blocks the caller's flow.

const fetch = require('node-fetch');
const db = require('../db/db');

const APP_NAME = 'nook';

function relEmoji(rel) {
  switch ((rel || '').toLowerCase()) {
    case 'family':       return '👪';
    case 'partner':      return '💞';
    case 'crush':        return '💕';
    case 'friend':       return '🫂';
    case 'colleague':    return '💼';
    case 'pet':          return '🐾';
    case 'group':        return '👥';
    case 'acquaintance': return '🤝';
    default:             return '👤';
  }
}

// Shared POST helper — same auth/error handling for every Orbit endpoint,
// just a different path and body shape per caller.
async function postOrbitEndpoint(path, payload, logLabel) {
  const url = process.env.ORBIT_URL;
  const secret = process.env.ORBIT_INGEST_SECRET;
  if (!url || !secret) return { skipped: true, reason: 'ORBIT_URL or ORBIT_INGEST_SECRET not configured' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[Orbit] ${logLabel} non-ok ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[Orbit] ${logLabel} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Graph node sync (people) — Orbit's /api/ingest endpoint.
async function postToOrbit(payload) {
  return postOrbitEndpoint('/api/ingest', payload, 'ingest');
}

// Bug/idea reports — a distinct endpoint from graph-node ingest, and a
// distinct auth scheme too (X-API-Key, not x-ingest-secret): Orbit's
// bug-reports API predates the ingest-secret convention and was never
// unified with it. Posting a report through /api/ingest with
// target: 'Feedback' 400'd ("Category 'Feedback' not found") because that's
// not a real graph category — this is the actual feedback intake.
async function bugReportsRequest(method, path, payload) {
  const url = process.env.ORBIT_URL;
  const secret = process.env.ORBIT_INGEST_SECRET;
  if (!url || !secret) return { skipped: true, reason: 'ORBIT_URL or ORBIT_INGEST_SECRET not configured' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': secret },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[Orbit] bug-reports ${method} ${path} non-ok ${res.status}:`, JSON.stringify(body).slice(0, 200));
      return { ok: false, status: res.status, body };
    }
    return { ok: true, body };
  } catch (err) {
    console.warn(`[Orbit] bug-reports ${method} ${path} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Success returns 201 { received: true, id: '<cuid>' } — id must be saved by
// the caller (reports.orbit_id) since resolveBugReport matches by id only,
// with no content-based fallback.
async function postBugReport({ type, message, stack, context, created_at }) {
  return bugReportsRequest('POST', '/api/bug-reports', {
    app: APP_NAME,
    type, // 'bug_report' | 'idea'
    message,
    stack: stack || null,
    context: context || {},
    created_at,
  });
}

// Resolving a report actually hard-deletes it on Orbit's side (no "resolved"
// state persists there) — named for what it means on Nook's side, not for
// Orbit's literal storage behavior.
async function resolveBugReport(orbitId) {
  if (!orbitId) return { skipped: true, reason: 'no orbit id' };
  return bugReportsRequest('PATCH', `/api/bug-reports/${orbitId}`, { status: 'resolved' });
}

// Build the canonical Orbit item shape for one Nook person, including their
// last 5 mentions as sub-notes.
//   `mentions`    — optional array to skip the per-person mentions query
//   `peopleById`  — optional Map<id, person> for "metThrough" name lookup
//                   without an extra round-trip per item (used in bulk sync)
async function personToOrbitItem(person, mentions, peopleById) {
  if (!mentions) {
    try {
      const r = await db.query(`
        SELECT pm.context, pm.emotion_toward, pm.mentioned_at, e.date
        FROM person_mentions pm
        JOIN entries e ON e.id = pm.entry_id
        WHERE pm.person_id = $1
        ORDER BY pm.mentioned_at DESC
        LIMIT 5
      `, [person.id]);
      mentions = r.rows;
    } catch { mentions = []; }
  }

  const notes = (mentions || []).map(m => ({
    externalId: `nook-mention-${person.id}-${new Date(m.mentioned_at).getTime()}`,
    body: m.context || '(mentioned)',
    createdAt: new Date(m.mentioned_at).toISOString(),
  }));

  const item = {
    externalId: `nook-person-${person.id}`,
    title: person.name,
    emoji: relEmoji(person.relationship_type),
    body: person.notes || '',
    status: 'ACTIVE',
    notes,
  };
  // Orbit auto-creates a sub-branch per relationship (People → Family → Alice).
  // Only send when set — omitting leaves the person directly under People.
  if (person.relationship_type) {
    item.relationship_type = person.relationship_type;
  }
  // Friend circles / subgroups — Orbit can use this for deeper nesting
  // (People → Friend → Uni Squad → Alice).
  if (person.subgroup) {
    item.subgroup = person.subgroup;
  }
  // "Met through" — graph edge to another node. metThrough is the canonical
  // externalId for the introducer; metThroughName is a display-name convenience
  // so Orbit doesn't need to dereference the node just to show a label.
  if (person.introduced_by_id) {
    item.metThrough = `nook-person-${person.introduced_by_id}`;
    let name = peopleById?.get(person.introduced_by_id)?.name;
    if (!name) {
      try {
        const r = await db.query('SELECT name FROM people WHERE id = $1', [person.introduced_by_id]);
        name = r.rows[0]?.name;
      } catch {}
    }
    if (name) item.metThroughName = name;
  }
  return item;
}

// Push a single person (and their recent mentions) to Orbit's "People" category.
// Prefer syncPersonTracked below — this bare version has no durability.
async function syncPerson(person) {
  const item = await personToOrbitItem(person);
  return postToOrbit({
    source: APP_NAME,
    target: 'People',
    as: 'node',
    items: [item],
  });
}

// Record that a person's node matches a specific version of the row. Stamped
// with the row's own updated_at rather than NOW(): if an edit lands while the
// push is in flight, updated_at moves past the stamp and the row stays dirty,
// so the newer name gets pushed too instead of being masked as "synced".
async function markPersonSynced(personId, updatedAt) {
  return db.query(
    'UPDATE people SET orbit_synced_at = COALESCE($2::timestamptz, NOW()) WHERE id = $1',
    [personId, updatedAt || null]
  ).catch(() => {});
}

// syncPerson + durability. Every write path should call this instead.
//
// The push used to be `syncPerson(row).catch(() => {})` — result discarded,
// every failure swallowed, no retry and no record. That is why a rename could
// silently never reach Orbit: Nook said "Updated!", Orbit kept the old title,
// and nothing on either side could tell that they disagreed. Marking the row
// synced only on success means a failed push leaves it dirty for the flush
// below to pick up.
async function syncPersonTracked(person) {
  const res = await syncPerson(person);
  if (res.ok) await markPersonSynced(person.id, person.updated_at);
  return res;
}

// Re-push every person whose node is older than their row. Runs at boot and on
// an interval (see server.js), so a push that failed while Orbit was down or
// mid-deploy is retried rather than lost.
async function flushUnsyncedPeople() {
  if (!process.env.ORBIT_URL || !process.env.ORBIT_INGEST_SECRET) {
    return { skipped: true, reason: 'ORBIT_URL or ORBIT_INGEST_SECRET not configured' };
  }
  let rows;
  try {
    const r = await db.query(`
      SELECT id, name, relationship_type, notes, photo_url, aliases, subgroup, introduced_by_id, updated_at
      FROM people
      WHERE orbit_synced_at IS NULL OR orbit_synced_at < updated_at
      ORDER BY updated_at ASC
      LIMIT 200
    `);
    rows = r.rows;
  } catch (err) {
    console.warn('[Orbit] flushUnsyncedPeople query failed:', err.message);
    return { ok: false, error: err.message };
  }
  if (!rows.length) return { ok: true, synced: 0, pending: 0 };

  let synced = 0, failed = 0;
  for (const p of rows) {
    const out = await syncPersonTracked(p).catch(err => ({ ok: false, error: err.message }));
    if (out.ok) { synced++; continue; }
    failed++;
    // Orbit itself is unreachable or erroring — stop and retry the whole
    // backlog next time rather than firing the remaining requests at a service
    // that's down. A 4xx is that one row's problem, so keep going past it.
    if (out.error || (out.status && out.status >= 500)) break;
  }
  if (synced || failed) console.log(`[Orbit] people resync: ${synced} pushed, ${failed} failed, ${rows.length} were stale`);
  return { ok: true, synced, failed, pending: rows.length - synced };
}

// Mark a person as deleted in Orbit. Orbit's ingest treats status=DONE as
// archived/inactive — we don't have a hard delete on the ingest API.
async function markPersonDeleted(personId, personName) {
  return postToOrbit({
    source: APP_NAME,
    target: 'People',
    as: 'node',
    items: [{
      externalId: `nook-person-${personId}`,
      title: personName || '(deleted)',
      status: 'DONE',
    }],
  });
}

// Bulk push every Nook person in one request.
async function syncAllPeople() {
  try {
    const people = await db.query(`
      SELECT id, name, relationship_type, notes, photo_url, aliases, subgroup, introduced_by_id, updated_at
      FROM people ORDER BY name
    `);
    if (!people.rows.length) return { ok: true, count: 0 };

    // Pre-build an id→person map so metThroughName lookups are O(1) inside
    // the loop instead of an extra DB query per introducer.
    const peopleById = new Map(people.rows.map(p => [p.id, p]));
    const items = [];
    for (const p of people.rows) {
      items.push(await personToOrbitItem(p, undefined, peopleById));
    }
    const result = await postToOrbit({
      source: APP_NAME,
      target: 'People',
      as: 'node',
      items,
    });
    // One request covers every person, so on success stamp them all — otherwise
    // a manual "Sync all" would leave every row still looking dirty and the
    // background flush would immediately re-push what just went through.
    if (result.ok) {
      await Promise.all(people.rows.map(p => markPersonSynced(p.id, p.updated_at)));
    }
    return { ...result, count: items.length };
  } catch (err) {
    console.warn('[Orbit] syncAllPeople failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  postToOrbit, postBugReport, resolveBugReport,
  syncPerson, syncPersonTracked, flushUnsyncedPeople, markPersonSynced,
  markPersonDeleted, syncAllPeople, APP_NAME,
};
