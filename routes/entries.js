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
    // Full-text search using search_vector (GIN-indexed). Falls back to ILIKE
    // for very short queries or punctuation-heavy queries that tsquery handles poorly.
    let rankSelect = '';
    let orderBy = 'date DESC, created_at DESC';
    if (search) {
      const trimmed = search.trim();
      const useFTS = trimmed.length >= 3 && /\w/.test(trimmed);
      if (useFTS) {
        conditions.push(`(
          search_vector @@ plainto_tsquery('english', $${idx})
          OR cleaned_content ILIKE $${idx + 1}
          OR ai_summary ILIKE $${idx + 1}
        )`);
        rankSelect = `, ts_rank(search_vector, plainto_tsquery('english', $${idx})) as search_rank`;
        orderBy = 'search_rank DESC NULLS LAST, date DESC, created_at DESC';
        params.push(trimmed);
        params.push(`%${trimmed}%`);
        idx += 2;
      } else {
        conditions.push(`(
          cleaned_content ILIKE $${idx} OR
          raw_transcript  ILIKE $${idx} OR
          ai_summary      ILIKE $${idx} OR
          key_themes::text ILIKE $${idx} OR
          tags::text       ILIKE $${idx}
        )`);
        params.push(`%${trimmed}%`);
        idx++;
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT
        id, date, time_of_day, created_at, updated_at, is_backdated,
        ai_summary, key_themes, important_today, action_items, action_items_state,
        mood_overall, mood_energy, mood_happiness, mood_anxiety,
        life_areas, tags, entry_mode, has_love_life_content${rankSelect}
      FROM entries
      ${where}
      ORDER BY ${orderBy}
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
// Accepts ?date=YYYY-MM-DD (client's local date) to avoid server UTC vs user timezone mismatch
router.get('/on-this-day', async (req, res) => {
  try {
    const dateStr = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : new Date().toISOString().split('T')[0];
    const [year, month, day] = dateStr.split('-').map(Number);
    const result = await db.query(`
      SELECT id, date, time_of_day, ai_summary, important_today,
             mood_overall, key_themes, has_love_life_content
      FROM entries
      WHERE EXTRACT(MONTH FROM date) = $1
        AND EXTRACT(DAY FROM date) = $2
        AND date::date < $3::date
      ORDER BY date DESC
      LIMIT 5
    `, [month, day, dateStr]);
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
      first_person_summary,
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
        ai_summary, first_person_summary, key_themes, action_items, important_today,
        mood_energy, mood_happiness, mood_anxiety, mood_confidence, mood_motivation,
        mood_social_battery, mood_physical, mood_focus, mood_overall, mood_source,
        life_areas, tags, entry_mode, has_love_life_content,
        love_life_raw, love_life_cleaned, love_life_emotion_intensity, love_life_ai_summary,
        is_backdated
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27, $28,
        $29
      ) RETURNING *
    `, [
      date, time_of_day, raw_transcript, cleaned_content, user_edited_content,
      ai_summary, first_person_summary, JSON.stringify(key_themes), JSON.stringify(action_items), important_today,
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
      'ai_summary', 'first_person_summary', 'key_themes', 'action_items', 'important_today',
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

// PUT /api/entries/:id/action-item — set state of one action item
// Body: { text, state: 'done' | 'snoozed' | 'dismissed' | 'pending', snooze_days?: 7 }
router.put('/:id/action-item', async (req, res) => {
  try {
    const { text, state, snooze_days = 7 } = req.body;
    // Backward compat: accept legacy { done: bool }
    let finalState = state;
    if (finalState === undefined && req.body.done !== undefined) {
      finalState = req.body.done ? 'done' : 'pending';
    }
    if (!text || !finalState) return res.status(400).json({ error: 'text and state are required', code: 'VALIDATION_ERROR' });
    if (!['done', 'snoozed', 'dismissed', 'pending'].includes(finalState)) {
      return res.status(400).json({ error: 'invalid state', code: 'VALIDATION_ERROR' });
    }

    // Compute snooze_until if snoozing
    let snoozeUntilUpdate = null;
    if (finalState === 'snoozed') {
      const d = new Date();
      d.setDate(d.getDate() + Number(snooze_days));
      snoozeUntilUpdate = d.toISOString().split('T')[0];
    }

    const params = [text, finalState, req.params.id];
    let snoozeSql = '';
    if (snoozeUntilUpdate) {
      snoozeSql = `, action_items_snooze_until = COALESCE(action_items_snooze_until, '{}'::jsonb) || jsonb_build_object($1::text, $4::text)`;
      params.push(snoozeUntilUpdate);
    } else {
      // Clear any prior snooze date for this item when state is not snoozed
      snoozeSql = `, action_items_snooze_until = COALESCE(action_items_snooze_until, '{}'::jsonb) - $1::text`;
    }

    const result = await db.query(
      `UPDATE entries
         SET action_items_state = COALESCE(action_items_state, '{}'::jsonb) || jsonb_build_object($1::text, $2::text)
             ${snoozeSql},
             updated_at = NOW()
       WHERE id = $3
       RETURNING action_items_state, action_items_snooze_until`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found', code: 'NOT_FOUND' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT action-item error:', err);
    res.status(500).json({ error: 'Failed to update action item', code: 'DB_ERROR' });
  }
});

// GET /api/entries/mood-cleanup/preview — count how many entries would be touched
// by the cleanup, so the UI can show "this will affect N entries" before commit.
router.get('/mood-cleanup/preview', async (req, res) => {
  try {
    // Same conditions as the cleanup, but counts only
    const overall = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM entries
      WHERE mood_overall = 5
        AND (mood_source = 'ai_detected' OR mood_source IS NULL)
    `);
    const subDims = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM entries
      WHERE (mood_source = 'ai_detected' OR mood_source IS NULL)
        AND (
          (CASE WHEN mood_energy = 5         THEN 1 ELSE 0 END +
           CASE WHEN mood_happiness = 5      THEN 1 ELSE 0 END +
           CASE WHEN mood_anxiety = 5        THEN 1 ELSE 0 END +
           CASE WHEN mood_confidence = 5     THEN 1 ELSE 0 END +
           CASE WHEN mood_motivation = 5     THEN 1 ELSE 0 END +
           CASE WHEN mood_social_battery = 5 THEN 1 ELSE 0 END +
           CASE WHEN mood_physical = 5       THEN 1 ELSE 0 END +
           CASE WHEN mood_focus = 5          THEN 1 ELSE 0 END) >= 3
        )
    `);
    res.json({
      overall_5s: overall.rows[0].n,
      entries_with_3plus_sub_5s: subDims.rows[0].n,
    });
  } catch (err) {
    console.error('mood-cleanup/preview error:', err);
    res.status(500).json({ error: 'Preview failed', code: 'DB_ERROR' });
  }
});

// POST /api/entries/mood-cleanup — apply the same safeguard the analyze endpoint
// uses on new entries to clean up existing AI-defaulted moods.
// NEVER touches mood_source = 'user_edited' entries.
router.post('/mood-cleanup', async (req, res) => {
  try {
    // Rule 1: null mood_overall=5 for AI-detected entries (5/10 is the LLM hedge)
    const r1 = await db.query(`
      UPDATE entries SET mood_overall = NULL, updated_at = NOW()
      WHERE mood_overall = 5
        AND (mood_source = 'ai_detected' OR mood_source IS NULL)
      RETURNING id
    `);

    // Rule 2: entries with 3+ sub-dimensions exactly 5 → null all the 5s
    const r2 = await db.query(`
      UPDATE entries SET
        mood_energy         = CASE WHEN mood_energy = 5         THEN NULL ELSE mood_energy         END,
        mood_happiness      = CASE WHEN mood_happiness = 5      THEN NULL ELSE mood_happiness      END,
        mood_anxiety        = CASE WHEN mood_anxiety = 5        THEN NULL ELSE mood_anxiety        END,
        mood_confidence     = CASE WHEN mood_confidence = 5     THEN NULL ELSE mood_confidence     END,
        mood_motivation     = CASE WHEN mood_motivation = 5     THEN NULL ELSE mood_motivation     END,
        mood_social_battery = CASE WHEN mood_social_battery = 5 THEN NULL ELSE mood_social_battery END,
        mood_physical       = CASE WHEN mood_physical = 5       THEN NULL ELSE mood_physical       END,
        mood_focus          = CASE WHEN mood_focus = 5          THEN NULL ELSE mood_focus          END,
        updated_at = NOW()
      WHERE (mood_source = 'ai_detected' OR mood_source IS NULL)
        AND (
          (CASE WHEN mood_energy = 5         THEN 1 ELSE 0 END +
           CASE WHEN mood_happiness = 5      THEN 1 ELSE 0 END +
           CASE WHEN mood_anxiety = 5        THEN 1 ELSE 0 END +
           CASE WHEN mood_confidence = 5     THEN 1 ELSE 0 END +
           CASE WHEN mood_motivation = 5     THEN 1 ELSE 0 END +
           CASE WHEN mood_social_battery = 5 THEN 1 ELSE 0 END +
           CASE WHEN mood_physical = 5       THEN 1 ELSE 0 END +
           CASE WHEN mood_focus = 5          THEN 1 ELSE 0 END) >= 3
        )
      RETURNING id
    `);

    res.json({
      overall_nulled: r1.rowCount,
      entries_sub_dims_nulled: r2.rowCount,
    });
  } catch (err) {
    console.error('mood-cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed', code: 'DB_ERROR' });
  }
});

// POST /api/entries/:id/followup — append a reflection follow-up to an existing entry
router.post('/:id/followup', async (req, res) => {
  try {
    const { text, question } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required', code: 'VALIDATION_ERROR' });

    const followup = {
      text,
      question: question || null,
      created_at: new Date().toISOString(),
      time_of_day: getTimeOfDayServer(),
    };

    const result = await db.query(`
      UPDATE entries
         SET followups = COALESCE(followups, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2
       RETURNING *
    `, [JSON.stringify(followup), req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found', code: 'NOT_FOUND' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/entries/:id/followup error:', err);
    res.status(500).json({ error: 'Failed to add follow-up', code: 'DB_ERROR' });
  }
});

function getTimeOfDayServer() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

// GET /api/entries/action-items/pending — outstanding action items from recent entries
// Excludes items that are: done, dismissed, or snoozed-until-future
// (Legacy 'true' boolean state is treated as 'done' for backward compat)
router.get('/action-items/pending', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const limit = parseInt(req.query.limit) || 5;
    const result = await db.query(`
      SELECT e.id as entry_id, e.date as entry_date, ai.value as text,
             (e.action_items_state ->> ai.value) as state
      FROM entries e, jsonb_array_elements_text(e.action_items) ai(value)
      WHERE e.date >= CURRENT_DATE - ($1 || ' days')::interval
        AND COALESCE(e.action_items_state ->> ai.value, '') NOT IN ('done', 'dismissed', 'true')
        AND (
          (e.action_items_state ->> ai.value) IS DISTINCT FROM 'snoozed'
          OR COALESCE((e.action_items_snooze_until ->> ai.value)::date, CURRENT_DATE) <= CURRENT_DATE
        )
      ORDER BY e.date DESC, e.created_at DESC
      LIMIT $2
    `, [days, limit]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET pending action-items error:', err);
    res.status(500).json({ error: 'Failed to load pending action items', code: 'DB_ERROR' });
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

// Pure string arithmetic on YYYY-MM-DD — no Date object, no timezone interference
function previousDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  // Date.UTC handles month/year rollover correctly. We never read back local
  // fields, only the UTC parts we just set — so server timezone is irrelevant.
  const t = Date.UTC(y, m - 1, d - 1);
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Helper: update streak count in settings
async function updateStreak(newDate) {
  try {
    const lastRow = await db.query("SELECT value FROM settings WHERE key = 'last_journal_date'");
    const streakRow = await db.query("SELECT value FROM settings WHERE key = 'streak_count'");

    const lastDate = lastRow.rows[0]?.value;
    const currentStreak = parseInt(streakRow.rows[0]?.value) || 0;

    const yesterdayStr = previousDay(newDate);

    let newStreak = currentStreak;
    if (!lastDate || lastDate === 'null') {
      newStreak = 1;
    } else if (lastDate === `"${yesterdayStr}"` || lastDate === yesterdayStr) {
      newStreak = currentStreak + 1;
    } else if (lastDate === `"${newDate}"` || lastDate === newDate) {
      // Same day — don't change streak (multiple entries one day still counts as 1 day)
      newStreak = currentStreak;
    } else {
      // Gap — streak broken
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
