// Bug/idea report pipeline: store in Postgres, best-effort forward to Orbit.
// Everything here is best-effort — callers never block and never see throws.

const db = require('../db/db');
const { postToOrbit, APP_NAME } = require('./orbit');

const AUTO_SOURCES = new Set(['frontend', 'backend']);

function toOrbitItem(r) {
  const body = [
    r.stack || '',
    r.context && Object.keys(r.context).length ? JSON.stringify(r.context) : '',
  ].filter(Boolean).join('\n\n');
  return {
    externalId: `nook-report-${r.id}`,
    title: (r.message || 'Report').slice(0, 120),
    body,
    status: 'ACTIVE',
    app: APP_NAME,
    source: r.source,
  };
}

// Forward one stored report to Orbit; flip orbit_sent on success.
async function forwardReport(r) {
  const res = await postToOrbit({
    source: APP_NAME,
    app: APP_NAME,
    target: 'Feedback',
    as: 'node',
    items: [toOrbitItem(r)],
  });
  if (res.ok) {
    await db.query('UPDATE reports SET orbit_sent = TRUE WHERE id = $1', [r.id]).catch(() => {});
  }
  return res;
}

// Store a report and best-effort forward it. Auto sources are deduped on a
// 5-minute (source, message, stack) window; manual submissions always go through.
async function saveReport({ source, message, stack, context }) {
  source = AUTO_SOURCES.has(source) || source === 'manual' ? source : 'frontend';
  message = String(message || '').slice(0, 4000);
  stack = stack ? String(stack).slice(0, 8000) : null;
  context = context && typeof context === 'object' ? context : {};

  if (AUTO_SOURCES.has(source)) {
    try {
      const dup = await db.query(
        `SELECT 1 FROM reports
           WHERE source = $1 AND message = $2 AND COALESCE(stack, '') = COALESCE($3, '')
             AND created_at > NOW() - INTERVAL '5 minutes'
           LIMIT 1`,
        [source, message, stack]
      );
      if (dup.rows.length) return { deduped: true };
    } catch { /* dedupe is best-effort; fall through to insert */ }
  }

  let row;
  try {
    const r = await db.query(
      `INSERT INTO reports (app, source, message, stack, context)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [APP_NAME, source, message, stack, JSON.stringify(context)]
    );
    row = r.rows[0];
  } catch (err) {
    console.warn('[reports] insert failed:', err.message);
    return { ok: false, error: err.message };
  }

  forwardReport(row).catch(() => {}); // fire-and-forget; startup flush retries
  return { ok: true, id: row.id };
}

// Backend equivalent of the frontend reportHandled — for catch blocks that
// swallow a "shouldn't happen" error. Pass ctx with method + path.
function reportHandled(err, ctx = {}) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? err.stack : null;
  // Don't await — never let reporting slow down or break the failing handler.
  saveReport({ source: 'backend', message, stack, context: { ...ctx, kind: 'handled' } })
    .catch(() => {});
}

// On boot, re-forward every report with orbit_sent=0. Stop on the first failure
// (Orbit down) and leave the rest for the next boot.
async function flushUnsent() {
  if (!process.env.ORBIT_URL) return;
  try {
    const r = await db.query('SELECT * FROM reports WHERE orbit_sent = FALSE ORDER BY created_at ASC');
    for (const row of r.rows) {
      const res = await forwardReport(row);
      if (!res.ok) break;
    }
  } catch (err) {
    console.warn('[reports] flushUnsent failed:', err.message);
  }
}

module.exports = { saveReport, reportHandled, flushUnsent, forwardReport };
