require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db/db');

const entriesRouter = require('./routes/entries');
const aiRouter = require('./routes/ai');
const insightsRouter = require('./routes/insights');
const peopleRouter = require('./routes/people');
const tagsRouter = require('./routes/tags');
const { syncAllPeople, markPersonDeleted } = require('./lib/orbit');
const { saveReport, reportHandled, flushUnsent } = require('./lib/reports');

const app = express();
const PORT = process.env.PORT || 3000;

// Auto-initialise database schema on startup (idempotent — uses IF NOT EXISTS)
async function initDB() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await db.query(schema);
    console.log('✅ Database schema ready');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
    // Don't crash — app still starts, individual routes will surface errors
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Capture any 5xx response as a backend report (route-handled DB errors etc.),
// in one place instead of touching every catch block. The global error handler
// below reports uncaught errors with a real stack and sets _reported to avoid a
// duplicate here. Skips the report endpoint itself (no self-loops).
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => { res.locals._body = body; return origJson(body); };
  res.on('finish', () => {
    if (res.statusCode >= 500 && !res.locals._reported && req.path !== '/api/reports') {
      const b = res.locals._body || {};
      reportHandled(new Error(b.error || `HTTP ${res.statusCode}`),
        { method: req.method, path: req.originalUrl, code: b.code, statusCode: res.statusCode });
    }
  });
  next();
});

// Bug/idea reports — store locally + best-effort forward to Orbit. Always
// resolves fast and never errors out to the client (reporting must not block).
app.post('/api/reports', async (req, res) => {
  try {
    const { source, message, stack, context } = req.body || {};
    const result = await saveReport({ source, message, stack, context });
    res.status(201).json({ ok: true, ...result });
  } catch {
    res.status(200).json({ ok: false });
  }
});

// Recent reports for the in-app viewer.
app.get('/api/reports', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await db.query(
      `SELECT id, app, source, message, context, orbit_sent, created_at
       FROM reports ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reports', code: 'DB_ERROR' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Settings API (simple CRUD on the settings table)
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res.status(500).json({ error: 'Failed to load settings', code: 'DB_ERROR' });
  }
});

app.put('/api/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  try {
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    );
    res.json({ key, value });
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res.status(500).json({ error: 'Failed to save setting', code: 'DB_ERROR' });
  }
});

app.put('/api/settings', async (req, res) => {
  const updates = req.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(updates)) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, JSON.stringify(value)]
      );
    }
    await client.query('COMMIT');
    res.json({ updated: Object.keys(updates).length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/settings bulk error:', err);
    res.status(500).json({ error: 'Failed to save settings', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

// Export routes
app.get('/api/export/json', async (req, res) => {
  try {
    const [entries, people, mentions] = await Promise.all([
      db.query('SELECT * FROM entries ORDER BY date DESC'),
      db.query('SELECT * FROM people ORDER BY name'),
      db.query('SELECT * FROM person_mentions ORDER BY mentioned_at DESC'),
    ]);
    res.json({
      exported_at: new Date().toISOString(),
      entries: entries.rows,
      people: people.rows,
      person_mentions: mentions.rows,
    });
  } catch (err) {
    console.error('Export JSON error:', err);
    res.status(500).json({ error: 'Export failed', code: 'EXPORT_ERROR' });
  }
});

app.get('/api/export/pdf', (req, res) => {
  res.status(501).json({
    error: 'PDF export is coming soon',
    code: 'NOT_IMPLEMENTED',
    message: 'This feature is on the roadmap. Use JSON export for now.',
  });
});

// API routes
app.use('/api/entries', entriesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/people', peopleRouter);
app.use('/api/tags', tagsRouter);

// ─── Orbit integration ──────────────────────────────────────────────
// PART 2 — Public live-data summary for the Orbit hub.
// Returns Nook's most useful current stat: journal streak + freshness.
// Registered BEFORE the SPA catch-all so it returns JSON, not index.html.
app.get('/api/orbit-summary', async (req, res) => {
  try {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    // Last entry — for freshness + a short snippet
    const lastEntry = await db.query(`
      SELECT date, created_at,
             COALESCE(important_today, ai_summary, '') AS snippet
      FROM entries
      ORDER BY date DESC, created_at DESC
      LIMIT 1
    `);
    // Distinct journaled days, for streak calculation
    const distinctDates = await db.query(`
      SELECT DISTINCT date FROM entries ORDER BY date DESC
    `);
    const dateSet = new Set(distinctDates.rows.map(r => {
      const d = r.date instanceof Date ? r.date : new Date(r.date);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }));
    // Walk backwards from today (or yesterday) counting consecutive days
    let streak = 0;
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
    let cursor = dateSet.has(todayStr) ? new Date(today)
               : dateSet.has(yStr)     ? new Date(yesterday)
               : null;
    while (cursor) {
      const cs = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`;
      if (dateSet.has(cs)) { streak++; cursor.setDate(cursor.getDate() - 1); } else break;
    }

    if (!lastEntry.rows.length) {
      return res.json({
        label: 'Journal',
        stat: 'No entries yet',
        status: 'paused',
        updatedAt: new Date().toISOString(),
      });
    }

    const last = lastEntry.rows[0];
    const lastDate = last.date instanceof Date ? last.date : new Date(last.date);
    const lastStr = `${lastDate.getUTCFullYear()}-${String(lastDate.getUTCMonth()+1).padStart(2,'0')}-${String(lastDate.getUTCDate()).padStart(2,'0')}`;
    const daysSince = Math.floor((new Date(todayStr) - new Date(lastStr)) / 86400000);

    // Status: today/yesterday = active, 2-3 days = warning, older = paused
    const status = daysSince <= 1 ? 'active' : daysSince <= 3 ? 'warning' : 'paused';

    const streakLabel = streak > 0 ? `🔥 ${streak}-day streak` : 'No streak';
    const snippet = (last.snippet || '').trim().slice(0, 80);
    const freshness = daysSince === 0 ? 'today' : daysSince === 1 ? 'yesterday' : `${daysSince} days ago`;
    const stat = snippet
      ? `${streakLabel} · ${freshness}: "${snippet}${last.snippet && last.snippet.length > 80 ? '…' : ''}"`
      : `${streakLabel} · last entry ${freshness}`;

    res.json({
      label: 'Journal',
      stat,
      status,
      updatedAt: (last.created_at || new Date()).toISOString(),
    });
  } catch (err) {
    console.error('GET /api/orbit-summary error:', err);
    // Even on failure, return a valid shape so Orbit's widget doesn't break
    res.json({
      label: 'Journal',
      stat: 'unavailable',
      status: 'paused',
      updatedAt: new Date().toISOString(),
    });
  }
});

// PART 3 — On-demand bulk resync of all Nook people to Orbit.
// Useful when first connecting, or after a re-deploy with new ORBIT_* env vars.
app.post('/api/sync-orbit', async (req, res) => {
  const result = await syncAllPeople();
  res.json(result);
});

// Mark an array of Orbit external IDs as DONE (archived). Used to clean up
// stale nodes that were deleted from the DB before Orbit was notified.
// Body: { ids: ["uuid1", "uuid2", ...], name: "Latte" }
app.post('/api/orbit/mark-deleted', async (req, res) => {
  const { ids = [], name = '(deleted)' } = req.body;
  if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
  const results = await Promise.all(ids.map(id => markPersonDeleted(id, name).catch(e => ({ ok: false, error: e.message }))));
  res.json({ ok: true, results });
});

// SPA fallback — serve index.html for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler — anything that reaches here is a "shouldn't happen"
// error worth capturing (with the route that produced it).
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.locals._reported = true; // full stack here; skip the finish-hook duplicate
  reportHandled(err, { method: req.method, path: req.originalUrl });
  res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
});

// Start server — init DB first, then re-forward any unsent reports, then listen
initDB().then(() => {
  flushUnsent().catch(() => {});
  app.listen(PORT, () => {
    console.log(`🌿 Nook is running at http://localhost:${PORT}`);
  });
});
