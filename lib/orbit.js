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

async function postToOrbit(payload) {
  const url = process.env.ORBIT_URL;
  const secret = process.env.ORBIT_INGEST_SECRET;
  if (!url || !secret) return { skipped: true, reason: 'ORBIT_URL or ORBIT_INGEST_SECRET not configured' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[Orbit] ingest non-ok ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[Orbit] ingest failed:', err.message);
    return { ok: false, error: err.message };
  }
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
async function syncPerson(person) {
  const item = await personToOrbitItem(person);
  return postToOrbit({
    source: APP_NAME,
    target: 'People',
    as: 'node',
    items: [item],
  });
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
      SELECT id, name, relationship_type, notes, photo_url, aliases, subgroup, introduced_by_id
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
    return { ...result, count: items.length };
  } catch (err) {
    console.warn('[Orbit] syncAllPeople failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { postToOrbit, syncPerson, markPersonDeleted, syncAllPeople, APP_NAME };
