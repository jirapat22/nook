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
    case 'mentor':       return '🧭';
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
// last 5 mentions as sub-notes. Pass an optional `mentions` array to skip
// the DB lookup (used by the bulk sync path to avoid N+1 queries).
async function personToOrbitItem(person, mentions) {
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

  return {
    externalId: `nook-person-${person.id}`,
    title: person.name,
    emoji: relEmoji(person.relationship_type),
    body: person.notes || (person.relationship_type ? `${person.relationship_type[0].toUpperCase()}${person.relationship_type.slice(1)}` : ''),
    status: 'ACTIVE',
    notes,
  };
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
      SELECT id, name, relationship_type, notes, photo_url, aliases
      FROM people ORDER BY name
    `);
    if (!people.rows.length) return { ok: true, count: 0 };

    const items = [];
    for (const p of people.rows) {
      items.push(await personToOrbitItem(p));
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
