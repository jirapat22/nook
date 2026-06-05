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

    const mentions = await db.query(`
      SELECT pm.*, e.date, e.ai_summary, LEFT(e.cleaned_content, 200) as entry_preview
      FROM person_mentions pm
      JOIN entries e ON e.id = pm.entry_id
      WHERE pm.person_id = $1
      ORDER BY pm.mentioned_at DESC
      LIMIT 20
    `, [req.params.id]);

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

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/people error:', err);
    res.status(500).json({ error: 'Failed to create person', code: 'DB_ERROR' });
  }
});

// POST /api/people/dedup — merge duplicate people with the same name (case-insensitive)
// Keeps the entry with the most mentions (ties broken by earliest created_at).
router.post('/dedup', async (req, res) => {
  try {
    const dupsResult = await db.query(`
      SELECT LOWER(name) as name_lc, COUNT(*) as cnt
      FROM people
      GROUP BY LOWER(name)
      HAVING COUNT(*) > 1
    `);
    const merged = [];
    for (const row of dupsResult.rows) {
      const group = await db.query(`
        SELECT p.id, p.name, p.aliases, COALESCE(COUNT(pm.id), 0)::int as mentions
        FROM people p
        LEFT JOIN person_mentions pm ON pm.person_id = p.id
        WHERE LOWER(p.name) = $1
        GROUP BY p.id
        ORDER BY mentions DESC, p.created_at ASC
      `, [row.name_lc]);
      const [keeper, ...dupes] = group.rows;
      for (const dupe of dupes) {
        // Move mentions, merge aliases, delete dupe
        await db.query('UPDATE person_mentions SET person_id = $1 WHERE person_id = $2', [keeper.id, dupe.id]);
        const allAliases = new Set([...(keeper.aliases || []), dupe.name, ...(dupe.aliases || [])]);
        allAliases.delete(keeper.name);
        await db.query('UPDATE people SET aliases = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify([...allAliases]), keeper.id]);
        await db.query('DELETE FROM people WHERE id = $1', [dupe.id]);
      }
      merged.push({ kept: keeper.name, removed: dupes.length });
    }
    res.json({ ok: true, merged });
  } catch (err) {
    console.error('POST /api/people/dedup error:', err);
    res.status(500).json({ error: 'Dedup failed', code: 'DB_ERROR' });
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
  try {
    // Grab the name first so we can mark the Orbit node as archived
    const before = await db.query('SELECT name FROM people WHERE id = $1', [req.params.id]);
    const result = await db.query('DELETE FROM people WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' });

    // Fire-and-forget archive in Orbit (status: DONE)
    markPersonDeleted(req.params.id, before.rows[0]?.name).catch(() => {});

    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/people/:id error:', err);
    res.status(500).json({ error: 'Failed to delete person', code: 'DB_ERROR' });
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
  try {
    const sourceId = req.params.id; // UUID — do NOT parseInt
    const { target_id } = req.body;
    if (!target_id) return res.status(400).json({ error: 'target_id is required', code: 'VALIDATION_ERROR' });
    if (String(sourceId) === String(target_id)) return res.status(400).json({ error: 'Cannot merge a person with themselves', code: 'VALIDATION_ERROR' });

    const sourceResult = await db.query('SELECT name, aliases FROM people WHERE id = $1', [sourceId]);
    if (!sourceResult.rows.length) return res.status(404).json({ error: 'Source person not found', code: 'NOT_FOUND' });

    const targetResult = await db.query('SELECT name, aliases FROM people WHERE id = $1', [target_id]);
    if (!targetResult.rows.length) return res.status(404).json({ error: 'Target person not found', code: 'NOT_FOUND' });

    const sourceName = sourceResult.rows[0].name;
    const sourceAliases = sourceResult.rows[0].aliases || [];
    const targetName = targetResult.rows[0].name;
    const targetAliases = targetResult.rows[0].aliases || [];

    // Add source name + source aliases to target aliases (deduplicated, exclude target name itself)
    const newAliasSet = new Set([...targetAliases, sourceName, ...sourceAliases]);
    newAliasSet.delete(targetName);
    const newAliases = [...newAliasSet];

    // Move all mentions from source to target
    await db.query('UPDATE person_mentions SET person_id = $1 WHERE person_id = $2', [target_id, sourceId]);

    // Update target aliases
    await db.query('UPDATE people SET aliases = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(newAliases), target_id]);

    // Delete source person
    await db.query('DELETE FROM people WHERE id = $1', [sourceId]);

    const updated = await db.query('SELECT * FROM people WHERE id = $1', [target_id]);
    res.json({ merged: true, person: updated.rows[0] });
  } catch (err) {
    console.error('POST /api/people/:id/merge error:', err);
    res.status(500).json({ error: 'Failed to merge people', code: 'DB_ERROR' });
  }
});

// POST /api/people/link-mention — link an AI-detected person mention to an entry
router.post('/link-mention', async (req, res) => {
  try {
    const { person_id, entry_id, context, sentiment_score, facts_extracted = [], emotion_toward, link_method } = req.body;
    const result = await db.query(`
      INSERT INTO person_mentions (person_id, entry_id, context, sentiment_score, facts_extracted, emotion_toward, link_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
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
  try {
    const result = await db.query(
      `DELETE FROM person_mentions WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mention not found', code: 'NOT_FOUND' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/people/mention/:id error:', err);
    res.status(500).json({ error: 'Failed to delete mention', code: 'DB_ERROR' });
  }
});

module.exports = router;
