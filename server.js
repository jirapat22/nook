require('dotenv').config();
// Pin the server clock to UTC before anything constructs a Date. node-postgres
// parses a DATE column into a JS Date at *local* midnight, and this file then
// reads it back with getUTC* while deriving "today" from local getters — which
// only agree when the host is UTC. Railway happens to be (entry dates come
// back as ...T00:00:00.000Z), so this changes nothing today; it stops a host
// timezone change from silently shifting every date by a day.
process.env.TZ = process.env.TZ || 'UTC';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db/db');

const entriesRouter = require('./routes/entries');
const aiRouter = require('./routes/ai');
const insightsRouter = require('./routes/insights');
const peopleRouter = require('./routes/people');
const tagsRouter = require('./routes/tags');
const { syncAllPeople, markPersonDeleted, resolveBugReport, flushUnsyncedPeople } = require('./lib/orbit');
const { saveReport, reportHandled, flushUnsent } = require('./lib/reports');
const { computeStreak, toDateStr, serverToday } = require('./lib/streak');

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
// No CORS middleware: the frontend is served from this same Express app
// (express.static below) and every fetch() call uses a relative /api/...
// path — there's no legitimate cross-origin browser use case. A permissive
// cors() here was effectively "any website can call this API" whenever
// APP_PASSWORD is unset, since the browser wouldn't block the request.
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
    const b = res.locals._body || {};
    // AUTH_NOT_CONFIGURED is a deployment state, not a crash: it's returned
    // before any handler runs, on *every* API call, for as long as
    // APP_PASSWORD is unset. Reporting it filed one bug per request and
    // buried the real reports under a flood of identical ones.
    if (res.statusCode >= 500 && !res.locals._reported
        && req.path !== '/api/reports' && b.code !== 'AUTH_NOT_CONFIGURED') {
      reportHandled(new Error(b.error || `HTTP ${res.statusCode}`),
        { method: req.method, path: req.originalUrl, code: b.code, statusCode: res.statusCode });
    }
  });
  next();
});

// ─── Auth: optional shared-password gate ────────────────────────────
// Set APP_PASSWORD in the environment to lock the API. When it's unset, the
// app stays open (so existing/local deploys don't break). The client gets a
// deterministic token (sha256 of the password) after /api/login and sends it
// as x-app-token on every request.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const EXPECTED_TOKEN = APP_PASSWORD
  ? crypto.createHash('sha256').update(APP_PASSWORD).digest('hex')
  : null;

// Failing open is fine on localhost, but on a public host it means the whole
// journal — entries, people, notes — is readable AND writable by anyone with
// the URL, silently. So: warn locally, refuse to serve the API in production.
// (`/health` is deliberately outside /api/* so Railway's healthcheck still
// passes and this doesn't turn into a restart loop.)
const IS_HOSTED = !!(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
if (!EXPECTED_TOKEN) {
  console.warn('');
  console.warn('  ⚠️  APP_PASSWORD is not set — the API is UNAUTHENTICATED.');
  console.warn('     Every /api/* route would be open to anyone with this URL,');
  console.warn('     including reading and deleting entries.');
  console.warn(IS_HOSTED
    ? '     Refusing to serve /api/* until APP_PASSWORD is set.'
    : '     Allowed here because this looks like local development.');
  console.warn('');
}
// orbit-summary stays public (Orbit's widget fetches it); login is how you
// get in; orbit/webhook is authenticated separately below via the shared
// ORBIT_INGEST_SECRET (X-API-Key), not the app password — Orbit calling in
// has no way to know a Nook user's x-app-token.
const AUTH_EXEMPT = new Set(['/api/login', '/api/orbit-summary', '/api/orbit/webhook']);

app.post('/api/login', (req, res) => {
  if (!EXPECTED_TOKEN) return res.json({ ok: true, token: null, authRequired: false });
  const pw = Buffer.from(String((req.body && req.body.password) || ''));
  const expected = Buffer.from(APP_PASSWORD);
  const ok = pw.length === expected.length && crypto.timingSafeEqual(pw, expected);
  if (ok) return res.json({ ok: true, token: EXPECTED_TOKEN, authRequired: true });
  return res.status(401).json({ ok: false, error: 'Wrong password', code: 'BAD_PASSWORD' });
});

app.use((req, res, next) => {
  // Match on a lowercased path. Express's own routing is case-INSENSITIVE by
  // default, so `app.use('/api/entries', ...)` happily serves `GET
  // /API/entries` — but a case-sensitive `req.path.startsWith('/api/')` here
  // said "not an API request" and waved it straight through to the handler.
  // That was a full auth bypass (read *and* write: `DELETE /API/entries/:id`
  // ran too) for anyone who just changed the case of the prefix. This gate
  // must never be narrower than the router it guards.
  const apiPath = req.path.toLowerCase();
  if (!apiPath.startsWith('/api/')) return next();     // app shell + static stay open
  // No password configured on a hosted deploy: serve nothing rather than
  // serve everything. Static assets still load so the app can render and
  // explain itself instead of just hanging.
  if (!EXPECTED_TOKEN && IS_HOSTED) {
    return res.status(503).json({
      error: 'This Nook has no APP_PASSWORD set, so its API is disabled. Set APP_PASSWORD in the server environment to unlock it.',
      code: 'AUTH_NOT_CONFIGURED',
    });
  }
  if (!EXPECTED_TOKEN) return next();                  // local dev, auth disabled
  if (AUTH_EXEMPT.has(apiPath)) return next();
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-app-token'] || '';
  if (tok && tok === EXPECTED_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
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

// Clear captured reports — either all of them, or a single one via ?id=.
// For "I've seen this, stop showing it" once you've diagnosed/fixed an
// issue, not for hiding errors as they happen (auto-capture keeps running).
// Deliberately local-only — does not touch Orbit. See POST /:id/resolve
// below for the "this is actually done" path used by the Ideas & Bugs
// checklist, which does propagate.
app.delete('/api/reports', async (req, res) => {
  try {
    const { id } = req.query;
    const result = id
      ? await db.query('DELETE FROM reports WHERE id = $1', [id])
      : await db.query('DELETE FROM reports');
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear reports', code: 'DB_ERROR' });
  }
});

// Resolve EVERY captured report: mark each one resolved on Orbit, then drop
// the local row.
//
// This is the path that was missing. The reports viewer's only bulk action was
// DELETE /api/reports, which is deliberately local-only — and the single
// Orbit-propagating resolve below was wired exclusively to the Ideas & Bugs
// checklist, which only ever contains notes the user typed by hand. So an
// auto-captured error (which is nearly all of them) had NO route out of
// Orbit's inbox from inside Nook, and worse, "Clear all" hid it locally while
// leaving it in Orbit forever — so it kept coming back in every digest with
// nothing left on this side to explain why.
//
// Unlike the single-report resolve, a row whose Orbit call FAILED is kept
// locally so it can be retried; losing the backlog to a transient Orbit outage
// would put us right back in the same hole.
app.post('/api/reports/resolve-all', async (req, res) => {
  try {
    const r = await db.query('SELECT id, orbit_id FROM reports ORDER BY created_at ASC');
    let resolved = 0, orphaned = 0, failed = 0;
    for (const row of r.rows) {
      if (!row.orbit_id) {
        // Forwarded before the orbit_id column existed (or never forwarded).
        // Orbit matches by id only, with no content fallback, so this one can
        // never be resolved remotely — drop it here and report the count.
        orphaned++;
        await db.query('DELETE FROM reports WHERE id = $1', [row.id]);
        continue;
      }
      const out = await resolveBugReport(row.orbit_id).catch(err => ({ ok: false, error: err.message }));
      if (out.ok || out.skipped) {
        resolved++;
        await db.query('DELETE FROM reports WHERE id = $1', [row.id]);
      } else {
        failed++;
      }
    }
    res.json({ ok: true, resolved, orphaned, failed, total: r.rows.length });
  } catch (err) {
    console.error('POST /api/reports/resolve-all error:', err);
    res.status(500).json({ error: 'Failed to resolve reports', code: 'DB_ERROR' });
  }
});

// Resolve a report — used by the Ideas & Bugs checklist (settings.js) when a
// bug/idea note is checked done or deleted. Awaits Orbit's actual result
// (a single PATCH — worth the extra round-trip to know it really worked)
// and includes it in the response so the caller isn't just told "ok" for a
// call that only touched the local row. Always removes the local row
// regardless of Orbit's outcome, same as before.
app.post('/api/reports/:id/resolve', async (req, res) => {
  try {
    const r = await db.query('SELECT orbit_id FROM reports WHERE id = $1', [req.params.id]);
    const orbitId = r.rows[0]?.orbit_id;
    const orbitResult = orbitId
      ? await resolveBugReport(orbitId).catch(err => ({ ok: false, error: err.message }))
      : { skipped: true, reason: 'report has no orbit_id' };
    await db.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true, orbit: orbitResult });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve report', code: 'DB_ERROR' });
  }
});

// Orbit → Nook webhook: fired when a bug/idea report resolves on Orbit's
// side. Fires for BOTH a resolve done directly in Orbit's UI and as an echo
// of Nook's own PATCH resolve call above (same handler on Orbit's end
// serves both paths) — so this must be idempotent: if the local row is
// already gone (Nook resolved it first), this is a harmless no-op.
// Auth is the shared ORBIT_INGEST_SECRET via X-API-Key, not the app
// password — see AUTH_EXEMPT above.
app.post('/api/orbit/webhook', async (req, res) => {
  const secret = process.env.ORBIT_INGEST_SECRET;
  if (!secret || req.headers['x-api-key'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
  const { id, app: sourceApp } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required', code: 'VALIDATION_ERROR' });
  // Defensive only — a correct sender should never call this for another
  // app's report, but nothing stops treating a wrong-app id as "not ours."
  if (sourceApp && sourceApp !== 'nook') return res.json({ ok: true, skipped: 'not a nook report' });

  try {
    const r = await db.query('SELECT id FROM reports WHERE orbit_id = $1', [id]);
    const localReportId = r.rows[0]?.id;
    if (localReportId) {
      await db.query('DELETE FROM reports WHERE id = $1', [localReportId]);
      // The Ideas & Bugs checklist note (settings.dev_notes) references this
      // report by Nook's local id, not Orbit's — filter it out there too so
      // a note resolved on Orbit's side doesn't keep sitting in the checklist.
      const s = await db.query("SELECT value FROM settings WHERE key = 'dev_notes'");
      const notes = Array.isArray(s.rows[0]?.value) ? s.rows[0].value : [];
      const filtered = notes.filter(n => n.report_id !== localReportId);
      if (filtered.length !== notes.length) {
        await db.query(
          "INSERT INTO settings (key, value) VALUES ('dev_notes', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
          [JSON.stringify(filtered)]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/orbit/webhook error:', err);
    res.status(500).json({ error: 'Failed to process webhook', code: 'DB_ERROR' });
  }
});

// Health check — Railway (railway.toml) polls this and restarts the service
// on failure. It used to return "ok" unconditionally, so a broken DB
// connection or a schema init failure (initDB() below swallows those to
// keep the process alive) would show as a healthy green check while every
// /api/* route was actually 500ing. Ping the DB so a real outage surfaces.
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', timestamp: new Date().toISOString() });
  }
});

// Settings API (simple CRUD on the settings table)
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    // Never expose the secret over the API — only whether one is saved.
    const k = settings.groq_api_key;
    settings.groq_api_key_set = typeof k === 'string' && k !== 'null' && k.replace(/"/g, '').trim() !== '';
    delete settings.groq_api_key;
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
    // .catch on the ROLLBACK, matching every other transaction in the app. On
    // Express 4 an async handler that rejects never reaches the error handler,
    // so a ROLLBACK that itself throws (dead connection) left the request
    // hanging forever instead of returning a 500.
    await client.query('ROLLBACK').catch(() => {});
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
    const todayStr = serverToday();

    // Last entry — for freshness only. Entry text is deliberately not
    // selected: this endpoint is public (see the stat line below).
    const lastEntry = await db.query(`
      SELECT date, created_at
      FROM entries
      ORDER BY date DESC, created_at DESC
      LIMIT 1
    `);
    // Distinct journaled days, for streak calculation. Shares the one
    // implementation with /api/insights/streaks — this used to be a third
    // hand-rolled copy that mixed local and UTC date getters.
    const distinctDates = await db.query('SELECT DISTINCT date FROM entries');
    const { current: streak } = computeStreak(distinctDates.rows.map(r => r.date), todayStr);

    if (!lastEntry.rows.length) {
      return res.json({
        label: 'Journal',
        stat: 'No entries yet',
        status: 'paused',
        updatedAt: new Date().toISOString(),
      });
    }

    const last = lastEntry.rows[0];
    const lastStr = toDateStr(last.date);
    const daysSince = Math.floor((new Date(todayStr) - new Date(lastStr)) / 86400000);

    // Status: today/yesterday = active, 2-3 days = warning, older = paused
    const status = daysSince <= 1 ? 'active' : daysSince <= 3 ? 'warning' : 'paused';

    const streakLabel = streak > 0 ? `🔥 ${streak}-day streak` : 'No streak';
    const freshness = daysSince === 0 ? 'today' : daysSince === 1 ? 'yesterday' : `${daysSince} days ago`;
    // Deliberately no entry text here. This endpoint is exempt from the auth
    // gate so Orbit's widget can poll it, which meant the snippet — a line of
    // the latest entry, names and all — was world-readable to anyone who
    // found the URL. Streak and freshness convey the same "am I keeping up?"
    // signal without publishing any journal content.
    const stat = `${streakLabel} · last entry ${freshness}`;

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
  try {
    const result = await syncAllPeople();
    res.json(result);
  } catch (err) {
    console.error('POST /api/sync-orbit error:', err);
    res.status(500).json({ error: 'Sync failed', code: 'ORBIT_ERROR' });
  }
});

// Mark an array of Orbit external IDs as DONE (archived). Used to clean up
// stale nodes that were deleted from the DB before Orbit was notified.
// Body: { ids: ["uuid1", "uuid2", ...], name: "Latte" }
// Every id must be a real UUID. This validated nothing before, so pasting the
// snippet without substituting the placeholder pushed a node with externalId
// "nook-person-<uuid-from-externalId>" to Orbit — creating a junk node instead
// of archiving the intended one, and still answering ok:true. An id that isn't
// a person UUID cannot match any node Nook ever created, so it can only ever
// do damage; reject it rather than forward it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.post('/api/orbit/mark-deleted', async (req, res) => {
  const { ids, name = '(deleted)' } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids must be a non-empty array', code: 'VALIDATION_ERROR' });
  }
  const bad = ids.filter(id => !UUID_RE.test(String(id)));
  if (bad.length) {
    return res.status(400).json({
      error: `Not a person UUID: ${bad.map(b => JSON.stringify(b)).join(', ')}. Use the uuid from the node's externalId (nook-person-<uuid>).`,
      code: 'VALIDATION_ERROR',
    });
  }
  const results = await Promise.all(ids.map(id => markPersonDeleted(id, name).catch(e => ({ ok: false, error: e.message }))));
  // ok reflects what actually happened. Reporting ok:true for a batch where
  // every push failed is how a no-op reads as a success.
  res.json({ ok: results.every(r => r.ok), results });
});

// SPA fallback — serve index.html for any unknown route
// Unknown API routes return JSON 404 instead of the SPA shell (clearer errors).
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

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

// Start server — init DB first, then re-forward any unsent reports and re-push
// any people whose Orbit node is behind their row, then listen.
initDB().then(() => {
  flushUnsent().catch(() => {});
  // People sync is fire-and-forget at the point of the edit, so a push that
  // failed (Orbit down, mid-deploy, a blip) used to be lost silently and Nook
  // and Orbit would disagree forever. Retry the stale ones at boot and on an
  // interval; both no-op cheaply when nothing is stale.
  flushUnsyncedPeople().catch(() => {});
  setInterval(() => { flushUnsyncedPeople().catch(() => {}); }, 10 * 60 * 1000).unref();
  app.listen(PORT, () => {
    console.log(`🌿 Nook is running at http://localhost:${PORT}`);
  });
});
