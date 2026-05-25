const express = require('express');
const router = express.Router();
const db = require('../db/db');

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

    res.json({
      ...personResult.rows[0],
      mentions: mentions.rows,
      emotion_breakdown: emotions.rows,
      all_facts: allFacts,
    });
  } catch (err) {
    console.error('GET /api/people/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch person', code: 'DB_ERROR' });
  }
});

// POST /api/people — create person
router.post('/', async (req, res) => {
  try {
    const { name, relationship_type, notes, profile_data = {} } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });

    const result = await db.query(`
      INSERT INTO people (name, relationship_type, notes, profile_data)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, relationship_type, notes, JSON.stringify(profile_data)]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/people error:', err);
    res.status(500).json({ error: 'Failed to create person', code: 'DB_ERROR' });
  }
});

// PUT /api/people/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, relationship_type, notes, profile_data } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
    if (relationship_type !== undefined) { updates.push(`relationship_type = $${idx++}`); params.push(relationship_type); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); params.push(notes); }
    if (profile_data !== undefined) { updates.push(`profile_data = $${idx++}`); params.push(JSON.stringify(profile_data)); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const result = await db.query(
      `UPDATE people SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/people/:id error:', err);
    res.status(500).json({ error: 'Failed to update person', code: 'DB_ERROR' });
  }
});

// DELETE /api/people/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM people WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Person not found', code: 'NOT_FOUND' });
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

// POST /api/people/link-mention — link an AI-detected person mention to an entry
router.post('/link-mention', async (req, res) => {
  try {
    const { person_id, entry_id, context, sentiment_score, facts_extracted = [], emotion_toward } = req.body;
    const result = await db.query(`
      INSERT INTO person_mentions (person_id, entry_id, context, sentiment_score, facts_extracted, emotion_toward)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [person_id, entry_id, context, sentiment_score, JSON.stringify(facts_extracted), emotion_toward]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('link-mention error:', err);
    res.status(500).json({ error: 'Failed to link mention', code: 'DB_ERROR' });
  }
});

module.exports = router;
