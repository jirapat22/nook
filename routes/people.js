const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { syncPerson, markPersonDeleted } = require('../lib/orbit');

// GET /api/people
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.*,
        COUNT(pm.id)::int                          as mention_count,
        MAX(pm.mentioned_at)                       as last_mentioned,
        ROUND(AVG(pm.sentiment_score), 1)          as avg_sentiment
      FROM people p
      LEFT JOIN person_mentions pm ON pm.person_id = p.id
      GROUP BY p.id
      ORDER BY last_mentioned DESC NULLS LAST, p.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/people error:', err);
    res.status(500).json({ error: 'Failed to fetch people', code: 'DB_ERROR' });
  }
});

// GET /api/people/:id — full profile + recent mentions
router.get('/:id', async (req, res) => {
  try {
    const personResult = await db.query('SELECT * FROM people WHERE id = $1', [req.params.id]);
    if (!personResult.rows.length) {
      return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' });
    }

    // COUNT(*) OVER() runs before LIMIT is applied, so every row carries the
    // TRUE total (not just how many of the 20 came back) — the header count
    // was previously just missing here (only GET /api/people, the list
    // route, ever computed it), so it silently showed "0 mentions" while
    // this same list rendered below it.
    const mentions = await db.query(`
      SELECT pm.*, e.date, e.ai_summary, LEFT(e.cleaned_content, 200) as entry_preview,
        COUNT(*) OVER() as total_mention_count
      FROM person_mentions pm
      JOIN entries e ON e.id = pm.entry_id
      WHERE pm.person_id = $1
      ORDER BY pm.mentioned_at DESC
      LIMIT 20
    `, [req.params.id]);
    const mentionCount = mentions.rows[0]?.total_mention_count ?? 0;

    // Emotion breakdown
    const emotions = await db.query(`
      SELECT emotion_toward, COUNT(*)::int as count
      FROM person_mentions
      WHERE person_id = $1 AND emotion_toward IS NOT NULL
      GROUP BY emotion_toward
      ORDER BY count DESC
    `, [req.params.id]);

    // Aggregate all facts
    const factsResult = await db.query(`
      SELECT facts_extracted FROM person_mentions
      WHERE person_id = $1 AND jsonb_array_length(facts_extracted) > 0
    `, [req.params.id]);

    const allFacts = [];
    const seen = new Set();
    for (const row of factsResult.rows) {
      for (const fact of (row.facts_extracted || [])) {
        const key = fact.toLowerCase().trim();
        if (!seen.has(key)) { seen.add(key); allFacts.push(fact); }
      }
    }

    // Who introduced this person (the named introducer), if any
    let introducedBy = null;
    if (personResult.rows[0].introduced_by_id) {
      const r = await db.query('SELECT id, name, photo_url FROM people WHERE id = $1', [personResult.rows[0].introduced_by_id]);
      introducedBy = r.rows[0] || null;
    }
    // Who THIS person introduced (reverse FK lookup)
    const introduced = await db.query(
      'SELECT id, name, photo_url FROM people WHERE introduced_by_id = $1 ORDER BY name ASC',
      [req.params.id]
    );

    res.json({
      ...personResult.rows[0],
      mention_count: mentionCount,
      mentions: mentions.rows,
      emotion_breakdown: emotions.rows,
      all_facts: allFacts,
      introduced_by: introducedBy,
      introduced: introduced.rows,
    });
  } catch (err) {
    console.error('GET /api/people/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch person', code: 'DB_ERROR' });
  }
});

// POST /api/people — create person
router.post('/', async (req, res) => {
  try {
    const { name, relationship_type, notes, profile_data = {}, aliases = [], photo_url, subgroup, introduced_by_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });

    const result = await db.query(`
      INSERT INTO people (name, relationship_type, notes, profile_data, aliases, photo_url, subgroup, introduced_by_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [name, relationship_type, notes, JSON.stringify(profile_data), JSON.stringify(aliases), photo_url || null,
        subgroup || null, introduced_by_id || null]);

    // Fire-and-forget push to Orbit. Don't await — never block the user.
    syncPerson(result.rows[0]).catch(() => {});

    // Past entries mentioning this name are surfaced via GET
    // /:id/backfill-candidates (called by the client right after this
    // returns) and only linked once the user reviews and confirms — see
    // that route for why. Auto-linking blind on a name match used to run
    // right here; it silently attached unrelated entries whenever two
    // different people shared a name.

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/people error:', err);
    res.status(500).json({ error: 'Failed to create person', code: 'DB_ERROR' });
  }
});

// POST /api/people/dedup — merge duplicate people with the same name (case-insensitive)
// Keeps the entry with the most mentions (ties broken by earliest created_at).
router.post('/dedup', async (req, res) => {
  const client = await db.getClient();
  try {
    const dupsResult = await client.query(`
      SELECT LOWER(name) as name_lc, COUNT(*) as cnt
      FROM people
      GROUP BY LOWER(name)
      HAVING COUNT(*) > 1
    `);
    const merged = [];
    await client.query('BEGIN');
    for (const row of dupsResult.rows) {
      const group = await client.query(`
        SELECT p.id, p.name, p.aliases, COALESCE(COUNT(pm.id), 0)::int as mentions
        FROM people p
        LEFT JOIN person_mentions pm ON pm.person_id = p.id
        WHERE LOWER(p.name) = $1
        GROUP BY p.id
        ORDER BY mentions DESC, p.created_at ASC
      `, [row.name_lc]);
      const [keeper, ...dupes] = group.rows;
      // Track accumulated aliases in memory so each iteration builds on the
      // previous one (keeper.aliases from the SELECT is never mutated in-place).
      let accumulated = Array.isArray(keeper.aliases) ? [...keeper.aliases] : [];
      for (const dupe of dupes) {
        // Lock the dupe's people row before moving its mentions — without
        // this, a concurrent POST /link-mention could insert a new mention
        // against dupe.id in the gap between the move and the delete below,
        // and that mention would be silently cascade-deleted with the dupe
        // row. The lock forces any concurrent FK insert referencing this
        // row to wait until this transaction commits.
        await client.query('SELECT id FROM people WHERE id = $1 FOR UPDATE', [dupe.id]);
        // Tell Orbit to archive this node BEFORE we lose the ID
        markPersonDeleted(dupe.id, dupe.name).catch(() => {});
        // Move mentions, merge aliases, delete dupe
        await client.query('UPDATE person_mentions SET person_id = $1 WHERE person_id = $2', [keeper.id, dupe.id]);
        const mergedAliases = new Set([...accumulated, dupe.name, ...(Array.isArray(dupe.aliases) ? dupe.aliases : [])]);
        mergedAliases.delete(keeper.name);
        accumulated = [...mergedAliases]; // carry forward for next iteration
        await client.query('UPDATE people SET aliases = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(accumulated), keeper.id]);
        await client.query('DELETE FROM people WHERE id = $1', [dupe.id]);
      }
      merged.push({ kept: keeper.name, removed: dupes.length });
    }
    await client.query('COMMIT');
    res.json({ ok: true, merged });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/people/dedup error:', err);
    res.status(500).json({ error: 'Dedup failed', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

// PUT /api/people/:id
router.put('/:id', async (req, res) => {
  try {
    const updates = [];
    const params = [];
    let idx = 1;

    const { name, relationship_type, notes, profile_data, aliases, photo_url, subgroup, introduced_by_id } = req.body;
    if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
    if (relationship_type !== undefined) { updates.push(`relationship_type = $${idx++}`); params.push(relationship_type); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); params.push(notes); }
    if (profile_data !== undefined) { updates.push(`profile_data = $${idx++}`); params.push(JSON.stringify(profile_data)); }
    if (aliases !== undefined) { updates.push(`aliases = $${idx++}`); params.push(JSON.stringify(aliases)); }
    if (photo_url !== undefined) { updates.push(`photo_url = $${idx++}`); params.push(photo_url); }
    if (subgroup !== undefined) { updates.push(`subgroup = $${idx++}`); params.push(subgroup || null); }
    if (introduced_by_id !== undefined) { updates.push(`introduced_by_id = $${idx++}`); params.push(introduced_by_id || null); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const result = await db.query(
      `UPDATE people SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' });

    // Fire-and-forget push to Orbit so the node reflects the latest fields.
    syncPerson(result.rows[0]).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/people/:id error:', err);
    res.status(500).json({ error: 'Failed to update person', code: 'DB_ERROR' });
  }
});

// DELETE /api/people/:id
router.delete('/:id', async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Lock the row first — same reasoning as /dedup and /merge: without this,
    // a concurrent POST /link-mention could insert a fresh mention against
    // this id in the gap before the cascade delete, and it'd be silently
    // lost along with everything else.
    const before = await client.query('SELECT name, aliases FROM people WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!before.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' }); }

    // Entries this person was actually linked to — grab them before the
    // cascade delete removes the evidence. entries.detected_people is a
    // denormalized JSONB snapshot from analysis time; deleting the person
    // row never touched it, so "Emily" kept resurfacing under "Nook also
    // spotted — not added yet" on every entry she'd been linked to, even
    // after she was deleted, since that section only checks names linked
    // *on that entry* (person_mentions), which the cascade had just wiped.
    const affected = await client.query('SELECT DISTINCT entry_id FROM person_mentions WHERE person_id = $1', [req.params.id]);

    const result = await client.query('DELETE FROM people WHERE id = $1 RETURNING id', [req.params.id]);

    if (affected.rows.length) {
      const names = new Set([before.rows[0].name, ...(Array.isArray(before.rows[0].aliases) ? before.rows[0].aliases : [])]
        .map(n => String(n).toLowerCase()));
      for (const { entry_id } of affected.rows) {
        const entryRow = await client.query('SELECT detected_people FROM entries WHERE id = $1', [entry_id]);
        const detected = Array.isArray(entryRow.rows[0]?.detected_people) ? entryRow.rows[0].detected_people : [];
        const cleaned = detected.filter(p => !names.has(String(p?.name || '').toLowerCase()));
        if (cleaned.length !== detected.length) {
          await client.query('UPDATE entries SET detected_people = $1 WHERE id = $2', [JSON.stringify(cleaned), entry_id]);
        }
      }
    }

    await client.query('COMMIT');

    // Fire-and-forget archive in Orbit (status: DONE)
    markPersonDeleted(req.params.id, before.rows[0]?.name).catch(() => {});

    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/people/:id error:', err);
    res.status(500).json({ error: 'Failed to delete person', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

// GET /api/people/:id/sentiment-trend
router.get('/:id/sentiment-trend', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        e.date,
        ROUND(AVG(pm.sentiment_score), 1) as avg_sentiment,
        STRING_AGG(pm.emotion_toward, ', ') as emotions
      FROM person_mentions pm
      JOIN entries e ON e.id = pm.entry_id
      WHERE pm.person_id = $1
      GROUP BY e.date
      ORDER BY e.date ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('sentiment-trend error:', err);
    res.status(500).json({ error: 'Failed to load sentiment trend', code: 'DB_ERROR' });
  }
});

// POST /api/people/:id/merge — merge source person into target
router.post('/:id/merge', async (req, res) => {
  const sourceId = req.params.id; // UUID — do NOT parseInt
  const { target_id } = req.body;
  if (!target_id) return res.status(400).json({ error: 'target_id is required', code: 'VALIDATION_ERROR' });
  if (String(sourceId) === String(target_id)) return res.status(400).json({ error: 'Cannot merge a person with themselves', code: 'VALIDATION_ERROR' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Lock the source row before moving its mentions — same reasoning as
    // /dedup: without this, a concurrent POST /link-mention could insert a
    // new mention against sourceId in the gap between the move and the
    // delete below, and it would be silently cascade-deleted with the
    // source row.
    const sourceResult = await client.query('SELECT name, aliases FROM people WHERE id = $1 FOR UPDATE', [sourceId]);
    if (!sourceResult.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Source person not found', code: 'NOT_FOUND' }); }

    const targetResult = await client.query('SELECT name, aliases FROM people WHERE id = $1', [target_id]);
    if (!targetResult.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Target person not found', code: 'NOT_FOUND' }); }

    const sourceName = sourceResult.rows[0].name;
    const sourceAliases = sourceResult.rows[0].aliases || [];
    const targetName = targetResult.rows[0].name;
    const targetAliases = targetResult.rows[0].aliases || [];

    // Add source name + source aliases to target aliases (deduplicated, exclude target name itself)
    const newAliasSet = new Set([...targetAliases, sourceName, ...sourceAliases]);
    newAliasSet.delete(targetName);
    const newAliases = [...newAliasSet];

    // Move all mentions from source to target
    await client.query('UPDATE person_mentions SET person_id = $1 WHERE person_id = $2', [target_id, sourceId]);

    // Update target aliases
    await client.query('UPDATE people SET aliases = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(newAliases), target_id]);

    // Delete source person
    await client.query('DELETE FROM people WHERE id = $1', [sourceId]);

    const updated = await client.query('SELECT * FROM people WHERE id = $1', [target_id]);
    await client.query('COMMIT');
    res.json({ merged: true, person: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/people/:id/merge error:', err);
    res.status(500).json({ error: 'Failed to merge people', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

// POST /api/people/link-mention — link an AI-detected person mention to an entry
router.post('/link-mention', async (req, res) => {
  try {
    const { person_id, entry_id, context, sentiment_score, facts_extracted = [], emotion_toward, link_method } = req.body;
    // ON CONFLICT guards against a race with backfillMentions inserting a row for
    // the same person+entry first (e.g. linking a brand-new person from inside an
    // entry triggers both paths). DO UPDATE (no-op) rather than DO NOTHING so
    // RETURNING always yields a row — otherwise result.rows[0] could be undefined.
    const result = await db.query(`
      INSERT INTO person_mentions (person_id, entry_id, context, sentiment_score, facts_extracted, emotion_toward, link_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (person_id, entry_id) DO UPDATE SET person_id = EXCLUDED.person_id
      RETURNING *
    `, [person_id, entry_id, context, sentiment_score, JSON.stringify(facts_extracted), emotion_toward, link_method || 'exact']);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('link-mention error:', err);
    res.status(500).json({ error: 'Failed to link mention', code: 'DB_ERROR' });
  }
});

// PUT /api/people/mention/:id — change the person a mention is linked to
// Used by the "wrong person?" undo flow
router.put('/mention/:id', async (req, res) => {
  try {
    const { person_id, link_method } = req.body;
    if (!person_id) return res.status(400).json({ error: 'person_id required', code: 'VALIDATION_ERROR' });

    const result = await db.query(
      `UPDATE person_mentions SET person_id = $1, link_method = COALESCE($2, link_method) WHERE id = $3 RETURNING *`,
      [person_id, link_method, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mention not found', code: 'NOT_FOUND' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/people/mention/:id error:', err);
    res.status(500).json({ error: 'Failed to update mention', code: 'DB_ERROR' });
  }
});

// DELETE /api/people/mention/:id — unlink a mention entirely
router.delete('/mention/:id', async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const mentionRow = await client.query('SELECT person_id, entry_id FROM person_mentions WHERE id = $1', [req.params.id]);
    if (!mentionRow.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Mention not found', code: 'NOT_FOUND' }); }
    const { person_id, entry_id } = mentionRow.rows[0];

    await client.query('DELETE FROM person_mentions WHERE id = $1', [req.params.id]);

    // Same reasoning as DELETE /api/people/:id: entries.detected_people is a
    // denormalized snapshot the mention delete alone never touches, so
    // without this the name would resurface under "Nook also spotted" the
    // next time this entry is opened — exactly the bug this route exists to
    // let a user fix (unlinking a wrongly-attached mention), just via a
    // different door. Skip the cleanup if another mention row still links
    // this same person to this same entry (rare, but possible if they were
    // mentioned twice) — only strip detected_people once truly unlinked.
    const stillLinked = await client.query(
      'SELECT 1 FROM person_mentions WHERE person_id = $1 AND entry_id = $2',
      [person_id, entry_id]
    );
    if (!stillLinked.rows.length) {
      const personRow = await client.query('SELECT name, aliases FROM people WHERE id = $1', [person_id]);
      if (personRow.rows.length) {
        const names = new Set(
          [personRow.rows[0].name, ...(Array.isArray(personRow.rows[0].aliases) ? personRow.rows[0].aliases : [])]
            .map(n => String(n).toLowerCase())
        );
        const entryRow = await client.query('SELECT detected_people FROM entries WHERE id = $1', [entry_id]);
        const detected = Array.isArray(entryRow.rows[0]?.detected_people) ? entryRow.rows[0].detected_people : [];
        const cleaned = detected.filter(p => !names.has(String(p?.name || '').toLowerCase()));
        if (cleaned.length !== detected.length) {
          await client.query('UPDATE entries SET detected_people = $1 WHERE id = $2', [JSON.stringify(cleaned), entry_id]);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ deleted: req.params.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/people/mention/:id error:', err);
    res.status(500).json({ error: 'Failed to delete mention', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

// Build a Postgres regex that matches any of the given names as whole words
// (case-insensitive). \m/\M word-boundary markers only recognise ASCII word
// characters, so they never anchor around non-Latin scripts (e.g. Thai
// names) — every neighbouring character looks like a "non-word" character
// and the match silently finds nothing. Apply \m\M only to ASCII names;
// match non-ASCII names as plain substrings.
function buildNamePattern(names) {
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const isAscii = n => /^[\x00-\x7F]*$/.test(n);
  return `(${names.map((n, i) => isAscii(n) ? `\\m${escaped[i]}\\M` : escaped[i]).join('|')})`;
}

// A snippet centered on the actual match, not just the first 200 characters
// of some other field — the earlier bulk-insert version stored
// LEFT(COALESCE(...)) regardless of which field matched, so a name that only
// appeared in raw_transcript could show a completely unrelated
// first_person_summary preview. This does a plain case-insensitive substring
// search purely to find *where* to center the snippet — it does not
// re-decide whether the text counts as a match (Postgres already decided
// that; see the route below for why re-deciding in a second regex engine is
// exactly what broke this).
function snippetAround(text, namesLC) {
  const lower = text.toLowerCase();
  let idx = -1, len = 0;
  for (const n of namesLC) {
    const i = lower.indexOf(n);
    if (i !== -1 && (idx === -1 || i < idx)) { idx = i; len = n.length; }
  }
  if (idx === -1) return text.slice(0, 160).trim(); // shouldn't happen, but degrade gracefully
  const start = Math.max(0, idx - 70);
  const end = Math.min(text.length, idx + len + 90);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// GET /api/people/:id/backfill-candidates — scan the last 90 days of entries
// for this person's name/aliases. Read-only, links nothing. Called by the
// client right after creating a person; the candidates are shown to the user
// to tick through before anything is actually linked (POST .../backfill-
// confirm below) — auto-linking on a bare name match used to run
// unconditionally here and silently attached entries that turned out to be
// about a different, same-named person.
router.get('/:id/backfill-candidates', async (req, res) => {
  try {
    const personResult = await db.query('SELECT name, aliases FROM people WHERE id = $1', [req.params.id]);
    if (!personResult.rows.length) return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' });
    const person = personResult.rows[0];
    const names = [person.name, ...(Array.isArray(person.aliases) ? person.aliases : [])].filter(Boolean);
    if (!names.length) return res.json([]);

    const pgPattern = buildNamePattern(names);

    // Have Postgres itself report which field matched via CASE — it's the
    // one engine actually deciding candidacy (the WHERE clause below), so
    // it's the only one that should get a vote. An earlier version of this
    // route re-checked each row with a separate JS regex "to confirm" and
    // silently dropped any row where the JS engine's \b word-boundary
    // didn't happen to agree with Postgres's \m\M — real candidates were
    // getting thrown away for no reason a user could see (reported: 5
    // candidates found, only 2 came back).
    const result = await db.query(`
      SELECT e.id, e.date,
        CASE
          WHEN e.first_person_summary ~* $1 THEN e.first_person_summary
          WHEN e.cleaned_content ~* $1 THEN e.cleaned_content
          WHEN e.raw_transcript ~* $1 THEN e.raw_transcript
        END as matched_text
      FROM entries e
      WHERE e.created_at >= NOW() - INTERVAL '90 days'
        AND (e.first_person_summary ~* $1 OR e.cleaned_content ~* $1 OR e.raw_transcript ~* $1)
        AND NOT EXISTS (
          SELECT 1 FROM person_mentions pm
          WHERE pm.person_id = $2 AND pm.entry_id = e.id
        )
      ORDER BY e.date DESC
      LIMIT 30
    `, [pgPattern, req.params.id]);

    const namesLC = names.map(n => n.toLowerCase());
    const candidates = result.rows
      .filter(e => e.matched_text) // guards a NULL edge case; the WHERE clause already guarantees a match
      .map(e => ({ entry_id: e.id, date: e.date, snippet: snippetAround(e.matched_text, namesLC) }));

    res.json(candidates);
  } catch (err) {
    console.error('GET /api/people/:id/backfill-candidates error:', err);
    res.status(500).json({ error: 'Failed to scan for mentions', code: 'DB_ERROR' });
  }
});

// POST /api/people/:id/backfill-confirm — link only the entry_ids the user
// actually ticked from the candidates list above.
router.post('/:id/backfill-confirm', async (req, res) => {
  try {
    const { entry_ids } = req.body;
    if (!Array.isArray(entry_ids) || !entry_ids.length) return res.json({ linked: 0 });
    // NULL sentiment_score so AVG() in GET /api/people ignores backfilled rows.
    // ON CONFLICT guards against a race with an explicit link-mention call
    // landing for the same person+entry in the meantime.
    const result = await db.query(`
      INSERT INTO person_mentions (person_id, entry_id, context, sentiment_score, facts_extracted, emotion_toward, link_method)
      SELECT $1, e.id,
        LEFT(COALESCE(e.first_person_summary, e.cleaned_content, e.raw_transcript, ''), 200),
        NULL, '[]', null, 'backfill'
      FROM entries e
      WHERE e.id = ANY($2::uuid[])
      ON CONFLICT (person_id, entry_id) DO NOTHING
      RETURNING entry_id
    `, [req.params.id, entry_ids]);
    res.json({ linked: result.rowCount });
  } catch (err) {
    console.error('POST /api/people/:id/backfill-confirm error:', err);
    res.status(500).json({ error: 'Failed to link mentions', code: 'DB_ERROR' });
  }
});

module.exports = router;
