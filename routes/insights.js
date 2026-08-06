const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { getGroqKey, groqChatRetrying, sendIfRateLimited } = require('../lib/groq');
const { reportHandled } = require('../lib/reports');
const { computeStreak } = require('../lib/streak');

// Helper: parse range param to interval
function rangeToInterval(range) {
  switch (range) {
    case '7d':   return '7 days';
    case '30d':  return '30 days';
    case '90d':  return '90 days';
    case '1y':   return '1 year';
    default:     return '30 days';
  }
}

// GET /api/insights/mood-trends?range=7d|30d|90d
router.get('/mood-trends', async (req, res) => {
  try {
    const interval = rangeToInterval(req.query.range);
    const result = await db.query(`
      SELECT
        date,
        ROUND(AVG(mood_energy))         as mood_energy,
        ROUND(AVG(mood_happiness))      as mood_happiness,
        ROUND(AVG(mood_anxiety))        as mood_anxiety,
        ROUND(AVG(mood_confidence))     as mood_confidence,
        ROUND(AVG(mood_motivation))     as mood_motivation,
        ROUND(AVG(mood_social_battery)) as mood_social_battery,
        ROUND(AVG(mood_physical))       as mood_physical,
        ROUND(AVG(mood_focus))          as mood_focus,
        ROUND(AVG(mood_overall))        as mood_overall
      FROM entries
      WHERE date >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY date
      ORDER BY date ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('mood-trends error:', err);
    res.status(500).json({ error: 'Failed to load mood trends', code: 'DB_ERROR' });
  }
});

// GET /api/insights/correlations
// Excludes AI-inferred moods (mood_source = 'ai_detected') from correlations.
// Reason: correlations imply causation. Building those on AI guesses
// (which sometimes misread tone) creates false patterns. Confirmed moods only.
router.get('/correlations', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        la.area,
        ROUND(AVG(e.mood_overall), 1)   as avg_mood,
        ROUND(AVG(e.mood_energy), 1)    as avg_energy,
        ROUND(AVG(e.mood_happiness), 1) as avg_happiness,
        ROUND(AVG(e.mood_anxiety), 1)   as avg_anxiety,
        COUNT(*)::int                   as entry_count
      FROM entries e,
        jsonb_array_elements_text(e.life_areas) la(area)
      WHERE e.mood_overall IS NOT NULL
        AND (e.mood_source IS NULL OR e.mood_source != 'ai_detected')
        AND jsonb_array_length(e.life_areas) > 0
      GROUP BY la.area
      HAVING COUNT(*) >= 3
      ORDER BY avg_mood DESC NULLS LAST
    `);

    // Overall average uses same filter so the delta is apples-to-apples
    const overall = await db.query(`
      SELECT ROUND(AVG(mood_overall), 1) as global_avg
      FROM entries
      WHERE mood_overall IS NOT NULL
        AND (mood_source IS NULL OR mood_source != 'ai_detected')
    `);
    const globalAvg = parseFloat(overall.rows[0]?.global_avg) || 5;

    const correlations = result.rows.map(row => ({
      ...row,
      global_avg: globalAvg,
      delta: row.avg_mood ? Math.round((parseFloat(row.avg_mood) - globalAvg) * 10) / 10 : null,
    }));

    res.json(correlations);
  } catch (err) {
    console.error('correlations error:', err);
    res.status(500).json({ error: 'Failed to load correlations', code: 'DB_ERROR' });
  }
});

// GET /api/insights/streaks — always derived from the entry dates themselves,
// never from a stored counter. Prefer the client's local calendar day
// (?today=YYYY-MM-DD): the server runs in UTC, which is a different day from
// the user's clock (e.g. Auckland +12), so a UTC "today" would mis-judge
// whether today/yesterday were journaled.
router.get('/streaks', async (req, res) => {
  try {
    const datesResult = await db.query('SELECT DISTINCT date FROM entries');
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '') ? req.query.today : undefined;
    res.json(computeStreak(datesResult.rows.map(r => r.date), today));
  } catch (err) {
    console.error('streaks error:', err);
    res.status(500).json({ error: 'Failed to load streaks', code: 'DB_ERROR' });
  }
});

// GET /api/insights/topic-frequency
router.get('/topic-frequency', async (req, res) => {
  try {
    const interval = rangeToInterval(req.query.range || '30d');
    const result = await db.query(`
      SELECT
        la.area,
        COUNT(*)::int as count,
        ROUND(AVG(e.mood_overall), 1) as avg_mood
      FROM entries e,
        jsonb_array_elements_text(e.life_areas) la(area)
      WHERE e.date >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY la.area
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('topic-frequency error:', err);
    res.status(500).json({ error: 'Failed to load topic frequency', code: 'DB_ERROR' });
  }
});

// GET /api/insights/day-patterns
router.get('/day-patterns', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        EXTRACT(DOW FROM date)::int         as day_of_week,
        TO_CHAR(date, 'Day')                as day_name,
        ROUND(AVG(mood_overall), 1)         as avg_mood,
        ROUND(AVG(mood_energy), 1)          as avg_energy,
        ROUND(AVG(mood_happiness), 1)       as avg_happiness,
        COUNT(*)::int                       as entry_count
      FROM entries
      WHERE mood_overall IS NOT NULL
        AND (mood_source IS NULL OR mood_source != 'ai_detected')
      GROUP BY EXTRACT(DOW FROM date), TO_CHAR(date, 'Day')
      ORDER BY day_of_week ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('day-patterns error:', err);
    res.status(500).json({ error: 'Failed to load day patterns', code: 'DB_ERROR' });
  }
});

// GET /api/insights/top-people?range=30d — most-mentioned people in the period
router.get('/top-people', async (req, res) => {
  try {
    const interval = rangeToInterval(req.query.range || '30d');
    const result = await db.query(`
      SELECT
        p.id, p.name, p.relationship_type, p.photo_url,
        COUNT(pm.id)::int                 AS mention_count,
        ROUND(AVG(pm.sentiment_score), 1) AS avg_sentiment,
        MAX(e.date)                       AS last_mentioned_date
      FROM person_mentions pm
      JOIN people p   ON p.id = pm.person_id
      JOIN entries e  ON e.id = pm.entry_id
      WHERE e.date >= CURRENT_DATE - INTERVAL '${interval}'
      GROUP BY p.id, p.name, p.relationship_type, p.photo_url
      ORDER BY mention_count DESC, last_mentioned_date DESC
      LIMIT 8
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('top-people error:', err);
    res.status(500).json({ error: 'Failed to load top people', code: 'DB_ERROR' });
  }
});

// GET /api/insights/love-life-trends
router.get('/love-life-trends', async (req, res) => {
  try {
    const interval = rangeToInterval(req.query.range || '30d');
    const result = await db.query(`
      SELECT
        date,
        love_life_emotion_intensity,
        LEFT(love_life_ai_summary, 80) as summary_preview
      FROM entries
      WHERE has_love_life_content = TRUE
        AND love_life_emotion_intensity IS NOT NULL
        AND date >= CURRENT_DATE - INTERVAL '${interval}'
      ORDER BY date ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('love-life-trends error:', err);
    res.status(500).json({ error: 'Failed to load love life trends', code: 'DB_ERROR' });
  }
});

// GET /api/insights/weekly-compare?week1=2025-W20&week2=2025-W21
router.get('/weekly-compare', async (req, res) => {
  try {
    // week format: YYYY-WNN
    function weekBounds(weekStr) {
      if (!weekStr) return null;
      const [year, week] = weekStr.split('-W').map(Number);
      const jan4 = new Date(year, 0, 4);
      const start = new Date(jan4);
      start.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
      };
    }

    async function weekStats(bounds) {
      if (!bounds) return null;
      const r = await db.query(`
        SELECT
          COUNT(*)::int                       as total_entries,
          COUNT(DISTINCT date)::int           as journaled_days,
          ROUND(AVG(mood_overall), 1)         as avg_mood,
          ROUND(AVG(mood_energy), 1)          as avg_energy,
          ROUND(AVG(mood_happiness), 1)       as avg_happiness,
          ROUND(AVG(mood_anxiety), 1)         as avg_anxiety
        FROM entries
        WHERE date BETWEEN $1 AND $2
      `, [bounds.start, bounds.end]);
      const themes = await db.query(`
        SELECT t.theme, COUNT(*)::int as count
        FROM entries e, jsonb_array_elements_text(e.key_themes) t(theme)
        WHERE e.date BETWEEN $1 AND $2
        GROUP BY t.theme ORDER BY count DESC LIMIT 5
      `, [bounds.start, bounds.end]);
      return { ...r.rows[0], bounds, top_themes: themes.rows };
    }

    const w1 = weekBounds(req.query.week1);
    const w2 = weekBounds(req.query.week2);

    const [stats1, stats2] = await Promise.all([weekStats(w1), weekStats(w2)]);
    res.json({ week1: stats1, week2: stats2 });
  } catch (err) {
    console.error('weekly-compare error:', err);
    res.status(500).json({ error: 'Failed to load weekly comparison', code: 'DB_ERROR' });
  }
});

// GET /api/insights/weekly-summary
router.get('/weekly-summary', async (req, res) => {
  try {
    const apiKey = await getGroqKey();

    const entries = await db.query(`
      SELECT date, ai_summary, key_themes, mood_overall, life_areas, important_today
      FROM entries
      WHERE date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY date ASC
    `);

    if (!entries.rows.length) {
      return res.json({ summary: 'No entries this week yet — start journaling and check back!' });
    }

    if (!apiKey) {
      const days = entries.rows.map(e => `${e.date}: ${e.ai_summary || e.important_today || 'Entry recorded'}`).join('\n');
      return res.json({ summary: `This week you journaled ${entries.rows.length} time${entries.rows.length !== 1 ? 's' : ''}.\n\n${days}` });
    }

    // Cap each line: this asks for 2-3 paragraphs, and the key's
    // tokens-per-minute budget is shared with /ai/analyze and /ai/reflect —
    // a week of long summaries was enough to 429 on its own.
    const entryData = entries.rows.map(e =>
      `${String(e.date).split('T')[0]}: ${(e.ai_summary || e.important_today || 'Entry recorded').slice(0, 250)} [mood: ${e.mood_overall ?? '?'}/10]`
    ).join('\n');

    const result = await groqChatRetrying(apiKey, [
      {
        role: 'system',
        content: 'You are Nook, a warm personal journal companion. Write a friendly weekly summary in 2-3 short paragraphs. Highlight patterns, growth moments, recurring themes, and one gentle observation. Keep it personal and warm, not clinical. Return JSON: { "summary": "..." }',
      },
      { role: 'user', content: `My entries this week:\n${entryData}` },
    ], { max_tokens: 512 });

    res.json({ summary: typeof result.summary === 'string' ? result.summary : '' });
  } catch (err) {
    console.error('weekly-summary error:', err);
    // This route used to raise a bare `new Error('Groq error')` and answer 500
    // for every failure — including a plain rate limit. That put it in the
    // frontend's crash funnel (report.js funnels >= 500), so each 429 filed a
    // bug report, and the finish-hook in server.js filed a second one with the
    // real cause already thrown away. Answer 429 for load and don't report it.
    if (sendIfRateLimited(res, err, "Nook's AI is busy right now — try again in a moment.")) return;
    res.locals._reported = true;
    reportHandled(err, { method: req.method, path: req.originalUrl, groqStatus: err.status });
    res.status(500).json({ error: 'Could not generate summary', code: 'AI_ERROR' });
  }
});

module.exports = router;
