const express = require('express');
const router = express.Router();
const db = require('../db/db');

// Supported managed fields (jsonb array columns on entries)
const FIELDS = new Set(['tags', 'key_themes', 'life_areas']);

function assertField(field, res) {
  if (!FIELDS.has(field)) {
    res.status(400).json({ error: `Invalid field. Must be one of: ${[...FIELDS].join(', ')}`, code: 'VALIDATION_ERROR' });
    return false;
  }
  return true;
}

// GET /api/tags?field=tags|key_themes|life_areas — list all values + counts
router.get('/', async (req, res) => {
  const field = req.query.field || 'tags';
  if (!assertField(field, res)) return;
  try {
    const result = await db.query(`
      SELECT t.value AS tag, COUNT(*)::int AS count
      FROM entries e, jsonb_array_elements_text(e.${field}) t(value)
      GROUP BY t.value
      ORDER BY count DESC, t.value ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/tags error:', err);
    res.status(500).json({ error: 'Failed to list tags', code: 'DB_ERROR' });
  }
});

// PUT /api/tags/rename — rename one tag everywhere it appears
router.put('/rename', async (req, res) => {
  const { field = 'tags', from, to } = req.body;
  if (!assertField(field, res)) return;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required', code: 'VALIDATION_ERROR' });
  if (from === to) return res.json({ updated: 0 });
  try {
    const result = await db.query(`
      UPDATE entries
      SET ${field} = (
        SELECT COALESCE(jsonb_agg(DISTINCT
          CASE WHEN value = $1 THEN $2 ELSE value END
        ), '[]'::jsonb)
        FROM jsonb_array_elements_text(${field}) t(value)
      ),
      updated_at = NOW()
      WHERE ${field} @> jsonb_build_array($1::text)
      RETURNING id
    `, [from, to]);
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error('PUT /api/tags/rename error:', err);
    res.status(500).json({ error: 'Failed to rename tag', code: 'DB_ERROR' });
  }
});

// DELETE /api/tags?field=...&tag=... — remove a tag from all entries
router.delete('/', async (req, res) => {
  const { field = 'tags', tag } = req.query;
  if (!assertField(field, res)) return;
  if (!tag) return res.status(400).json({ error: 'tag is required', code: 'VALIDATION_ERROR' });
  try {
    const result = await db.query(`
      UPDATE entries
      SET ${field} = ${field} - $1::text,
          updated_at = NOW()
      WHERE ${field} @> jsonb_build_array($1::text)
      RETURNING id
    `, [tag]);
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error('DELETE /api/tags error:', err);
    res.status(500).json({ error: 'Failed to delete tag', code: 'DB_ERROR' });
  }
});

// POST /api/tags/merge — replace each source tag with the target tag
router.post('/merge', async (req, res) => {
  const { field = 'tags', from = [], into } = req.body;
  if (!assertField(field, res)) return;
  if (!Array.isArray(from) || !from.length || !into) {
    return res.status(400).json({ error: 'from (array) and into are required', code: 'VALIDATION_ERROR' });
  }
  try {
    const result = await db.query(`
      UPDATE entries
      SET ${field} = (
        SELECT COALESCE(jsonb_agg(DISTINCT
          CASE WHEN value = ANY($1::text[]) THEN $2 ELSE value END
        ), '[]'::jsonb)
        FROM jsonb_array_elements_text(${field}) t(value)
      ),
      updated_at = NOW()
      WHERE ${field} ?| $1::text[]
      RETURNING id
    `, [from, into]);
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error('POST /api/tags/merge error:', err);
    res.status(500).json({ error: 'Failed to merge tags', code: 'DB_ERROR' });
  }
});

module.exports = router;
