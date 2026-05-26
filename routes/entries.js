const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/entries — list entries with optional filters
router.get('/', async (req, res) => {
  try {
    const { date, life_area, tag, search, limit = 50, offset = 0 } = req.query;
    let conditions = [];
    let params = [];
    let idx = 1;

    if (date) {
      conditions.push(`date = $${idx++}`);
      params.push(date);
    }
    if (life_area) {
      conditions.push(`life_areas @> $${idx++}::jsonb`);
      params.push(JSON.stringify([life_area]));
    }
    if (tag) {
      conditions.push(`tags @> $${idx++}::jsonb`);
      params.push(JSON.stringify([tag]));
    }
    if (search) {
      conditions.push(`(cleaned_content ILIKE $${idx} OR raw_transcript ILIKE $${idx} OR ai_summary ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT
        id, date, time_of_day, created_at, updated_at, is_backdated,
        ai_summary, key_themes, important_today, action_items,
        mood_overall, mood_energy, mood_happiness, mood_anxiety,
        life_areas, tags, entry_mode, has_love_life_content
      FROM entries
      ${where}
      ORDER BY date DESC, created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/entries error:', err);
    res.status(500).json({ error: 'Failed to fetch entries', code: 'DB_ERROR' });
  }
});

// GET /api/entries/calendar/:year/:month
router.get('/calendar/:year/:month', async (req, res) => {
  try {
    const { year, month } = req.params;
    const result = await db.query(`
      SELECT
        date,
        COUNT(*) as entry_count,
        AVG(mood_overall) as avg_mood,
        MAX(mood_overall) as max_mood,
        BOOL_OR(has_love_life_content) as has_love_life
      FROM entries
      WHERE EXTRACT(YEAR FROM date) = $1
        AND EXTRACT(MONTH FROM date) = $2
      GROUP BY date
      ORDER BY date ASC
    `, [year, month]);

    res.json(result.rows.map(row => ({
      date: row.date,
      entry_count: parseInt(row.entry_count),
      avg_mood: row.avg_mood ? Math.round(parseFloat(row.avg_mood) * 10) / 10 : null,
      has_love_life: row.has_love_life,
    })));
  } catch (err) {
    console.error('GET /api/entries/calendar error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar data', code: 'DB_ERROR' });
  }
});

// GET /api/entries/on-this-day — entries from the same calendar day in past years
router.get('/on-this-day', async (req, res) => {
  try {
    const today = new Date();
    const result = await db.query(`
      SELECT id, date, time_of_day, ai_summary, important_today,
             mood_overall, key_themes, has_love_life_content
      FROM entries
      WHERE EXTRACT(MONTH FROM date) = $1
        AND EXTRACT(DAY FROM date) = $2
        AND date::date < $3::date
      ORDER BY date DESC
      LIMIT 5
    `, [today.getMonth() + 1, today.getDate(), today.toISOString().split('T')[0]]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/entries/on-this-day error:', err);
    res.status(500).json({ error: 'Failed to fetch on-this-day entries', code: 'DB_ERROR' });
  }
});

// GET /api/entries/:id — single entry with full data
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM entries WHERE id = $1', [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Entry not found', code: 'NOT_FOUND' });
    }

    // Also fetch people mentions for this entry
    const mentions = await db.query(`
      SELECT pm.*, p.name, p.relationship_type
      FROM person_mentions pm
      JOIN people p ON p.id = pm.person_id
      WHERE pm.entry_id = $1
    `, [req.params.id]);

    res.json({ ...result.rows[0], people_mentions: mentions.rows });
  } catch (err) {
    console.error('GET /api/entries/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch entry', code: 'DB_ERROR' });
  }
});

// POST /api/entries — create entry
router.post('/', async (req, res) => {
  try {
    const {
      date = new Date().toISOString().split('T')[0],
      time_of_day,
      raw_transcript,
      cleaned_content,
      user_edited_content,
      ai_summary,
      key_themes = [],
      action_items = [],
      important_today,
      mood_energy,
      mood_happiness,
      mood_anxiety,
      mood_confidence,
      mood_motivation,
      mood_social_battery,
      mood_physical,
      mood_focus,
      mood_overall,
      mood_source,
      life_areas = [],
      tags = [],
      entry_mode = 'text',
      has_love_life_content = false,
      love_life_raw,
      love_life_cleaned,
      love_life_emotion_intensity,
      love_life_ai_summary,
      is_backdated = false,
    } = req.body;

    const today = new Date().toISOString().split('T')[0];
    const actualIsBackdated = is_backdated || date < today;

    const result = await db.query(`
      INSERT INTO entries (
        date, time_of_day, raw_transcript, cleaned_content, user_edited_content,
        ai_summary, key_themes, action_items, important_today,
        mood_energy, mood_happiness, mood_anxiety, mood_confidence, mood_motivation,
        mood_social_battery, mood_physical, mood_focus, mood_overall, mood_source,
        life_areas, tags, entry_mode, has_love_life_content,
        love_life_raw, love_life_cleaned, love_life_emotion_intensity, love_life_ai_summary,
        is_backdated
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26, $27,
        $28
      ) RETURNING *
    `, [
      date, time_of_day, raw_transcript, cleaned_content, user_edited_content,
      ai_summary, JSON.stringify(key_themes), JSON.stringify(action_items), important_today,
      mood_energy, mood_happiness, mood_anxiety, mood_confidence, mood_motivation,
      mood_social_battery, mood_physical, mood_focus, mood_overall, mood_source,
      JSON.stringify(life_areas), JSON.stringify(tags), entry_mode, has_love_life_content,
      love_life_raw, love_life_cleaned, love_life_emotion_intensity, love_life_ai_summary,
      actualIsBackdated,
    ]);

    const newEntry = result.rows[0];

    // Update streak
    await updateStreak(date);

    res.status(201).json(newEntry);
  } catch (err) {
    console.error('POST /api/entries error:', err);
    res.status(500).json({ error: 'Failed to create entry', code: 'DB_ERROR' });
  }
});

// PUT /api/entries/:id — update entry
router.put('/:id', async (req, res) => {
  try {
    const fields = [
      'date', 'time_of_day', 'raw_transcript', 'cleaned_content', 'user_edited_content',
      'ai_summary', 'key_themes', 'action_items', 'important_today',
      'mood_energy', 'mood_happiness', 'mood_anxiety', 'mood_confidence', 'mood_motivation',
      'mood_social_battery', 'mood_physical', 'mood_focus', 'mood_overall', 'mood_source',
      'life_areas', 'tags', 'has_love_life_content',
      'love_life_raw', 'love_life_cleaned', 'love_life_emotion_intensity', 'love_life_ai_summary',
    ];

    const jsonFields = new Set(['key_themes', 'action_items', 'life_areas', 'tags']);
    const updates = [];
    const params = [];
    let idx = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        params.push(jsonFields.has(field) ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const result = await db.query(
      `UPDATE entries SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Entry not found', code: 'NOT_FOUND' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /api/entries/:id error:', err);
    res.status(500).json({ error: 'Failed to update entry', code: 'DB_ERROR' });
  }
});

// DELETE /api/entries/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM entries WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Entry not found', code: 'NOT_FOUND' });
    }
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/entries/:id error:', err);
    res.status(500).json({ error: 'Failed to delete entry', code: 'DB_ERROR' });
  }
});

// Helper: update streak count in settings
async function updateStreak(newDate) {
  try {
    const lastRow = await db.query("SELECT value FROM settings WHERE key = 'last_journal_date'");
    const streakRow = await db.query("SELECT value FROM settings WHERE key = 'streak_count'");

    const lastDate = lastRow.rows[0]?.value;
    const currentStreak = parseInt(streakRow.rows[0]?.value) || 0;

    const today = new Date(newDate);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let newStreak = currentStreak;
    if (!lastDate || lastDate === 'null') {
      newStreak = 1;
    } else if (lastDate === `"${yesterdayStr}"` || lastDate === yesterdayStr) {
      newStreak = currentStreak + 1;
    } else if (lastDate !== `"${newDate}"` && lastDate !== newDate) {
      newStreak = 1;
    }

    await db.query(
      "INSERT INTO settings (key, value) VALUES ('streak_count', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [JSON.stringify(newStreak)]
    );
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('last_journal_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [JSON.stringify(newDate)]
    );
  } catch (err) {
    console.error('updateStreak error:', err);
  }
}

module.exports = router;
