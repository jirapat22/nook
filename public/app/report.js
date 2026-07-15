// Best-effort error/feedback reporting. Never blocks the user; every failure is
// swallowed. POSTs to /api/reports, which stores locally + forwards to Orbit.

const ENDPOINT = '/api/reports';
const OUTBOX_KEY = 'nook_report_outbox';
const MAX_AUTO_PER_LOAD = 25;       // funnel cap; manual + outbox bypass it
const APP_VERSION = 'nook-v78';     // keep in step with sw.js CACHE_NAME

let autoCount = 0;
let installed = false;

function baseContext(extra = {}) {
  return {
    screen: location.hash || '#home',
    url: location.href,
    version: APP_VERSION,
    userAgent: navigator.userAgent,
    ...extra,
  };
}

// Low-level POST. Returns true on success. NEVER throws and NEVER console.errors
// (that would recurse through the console wrapper).
async function postReport(body) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function clamp(s, n) { return s == null ? undefined : String(s).slice(0, n); }

// Automatic reports: capped per page load, fire-and-forget (never queued).
function funnel(report) {
  if (autoCount >= MAX_AUTO_PER_LOAD) return;
  autoCount++;
  postReport({
    source: report.source || 'frontend',
    message: clamp(report.message, 4000) || 'unknown',
    stack: clamp(report.stack, 8000),
    context: baseContext(report.context),
  });
}

// ── Outbox (manual reports only) ────────────────────────────
function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function writeOutbox(arr) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(arr.slice(-50))); } catch { /* private mode */ }
}
export async function flushOutbox() {
  const arr = readOutbox();
  if (!arr.length) return;
  const remaining = [];
  for (const body of arr) {
    if (!(await postReport(body))) remaining.push(body);
  }
  writeOutbox(remaining);
}

// ── Public API ──────────────────────────────────────────────

// Manual submission: ALWAYS sent (bypasses the cap); queued to retry if offline.
export async function reportManual({ message, context = {} } = {}) {
  const body = {
    source: 'manual',
    message: clamp(message, 4000) || 'feedback',
    context: baseContext({ kind: 'manual', ...context }),
  };
  if (!(await postReport(body))) writeOutbox([...readOutbox(), body]);
}

// A handled "shouldn't happen" error caught in a catch block.
export function reportHandled(err, ctx = {}) {
  funnel({
    source: 'frontend',
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : undefined,
    context: { ...ctx, kind: 'handled' },
  });
}

// Invariant check. If condition is false, report and CONTINUE — never throws.
export function assert(condition, message, ctx = {}) {
  if (condition) return true;
  funnel({ source: 'frontend', message: 'Invariant failed: ' + message, context: { ...ctx, kind: 'invariant' } });
  return false;
}

// Called by the api fetch wrapper. Reports server 5xx and write-request network
// failures only — not GET network blips, not 4xx, not the report endpoint.
// `code`/`serverError` are whatever the server's JSON error body said (e.g.
// code: 'AI_ERROR', serverError: 'AI analysis unavailable...') — genuinely
// more than just a bare status, even though the full internal cause (the
// actual Groq error) only ever exists in the matching backend-sourced report.
export function reportApiError({ method, path, status, error, code, serverError }) {
  if (path === ENDPOINT) return;
  const isWrite = /^(POST|PUT|DELETE|PATCH)$/i.test(method || '');
  if (status >= 500) {
    const codeStr = code ? ` [${code}]` : '';
    funnel({ source: 'frontend', message: `API ${status} ${method} ${path}${codeStr}`, context: { kind: 'api', method, path, status, code, serverError } });
  } else if (status == null && error && isWrite) {
    funnel({ source: 'frontend', message: `API network fail ${method} ${path}`, stack: String(error), context: { kind: 'api', method, path } });
  }
}

// Install global capture once.
export function installReporting() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e) => {
    // Opaque cross-origin script error with no detail — not actionable, ignore.
    if (!e.error && !e.filename && e.message === 'Script error.') return;
    funnel({
      source: 'frontend',
      message: e.message || 'window error',
      stack: e.error && e.error.stack,
      context: { kind: 'window', filename: e.filename, line: e.lineno, col: e.colno },
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    funnel({
      source: 'frontend',
      message: (r && r.message) ? r.message : String(r),
      stack: r && r.stack ? r.stack : undefined,
      context: { kind: 'unhandledrejection' },
    });
  });

  // Wrap console.error: still log, then forward (deduped server-side).
  const origError = console.error.bind(console);
  console.error = (...args) => {
    origError(...args);
    try {
      const message = args.map(a =>
        a instanceof Error ? (a.stack || a.message)
          : (a && typeof a === 'object' ? safeJson(a) : String(a))
      ).join(' ');
      if (message.includes(ENDPOINT)) return; // no self-loop
      funnel({ source: 'frontend', message, context: { kind: 'console' } });
    } catch { /* never let logging throw */ }
  };

  // Retry queued manual reports now and whenever connectivity returns.
  flushOutbox();
  window.addEventListener('online', flushOutbox);
}

function safeJson(o) { try { return JSON.stringify(o); } catch { return String(o); } }
