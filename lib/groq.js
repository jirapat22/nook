// One place for talking to Groq.
//
// This started as a private helper inside routes/ai.js, and routes/insights.js
// grew its own hand-rolled copy of the same fetch. The copy drifted: it never
// read `retry-after`, never retried, and turned every rate limit into a 500 —
// which the frontend reporter funnels as a crash. So the exact "Groq 429 filed
// as a bug report" problem that was fixed in /reflect was still live on
// /insights/weekly-summary, because the fix only ever touched one of the two
// implementations. Both now go through here.

const fetch = require('node-fetch');
const db = require('../db/db');

// Primary model is higher quality; fallback is far cheaper with much higher
// rate limits, so analysis still completes when the primary is throttled.
const PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Groq's token-per-minute budget is shared across every endpoint on the key,
// so a burst — analysing an entry and then asking for reflection questions
// moments later — can 429 with nothing actually wrong. Those are transient by
// definition. Anything that isn't (bad key, malformed request) must fail
// immediately rather than burn retries on a request that can never succeed.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

// Resolve the API key: env var (Railway secret) first, then the DB setting.
async function getGroqKey() {
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here') {
    return process.env.GROQ_API_KEY;
  }
  const row = await db.query("SELECT value FROM settings WHERE key = 'groq_api_key'");
  const val = row.rows[0]?.value;
  if (val && val !== 'null' && val !== '"null"') {
    return String(val).replace(/^"|"$/g, '') || null;
  }
  return null;
}

// One chat completion. Throws on any non-2xx with `.status` and `.retryAfter`
// attached so callers can distinguish load from a real fault.
async function groqChat(apiKey, messages, { temperature = 0.3, max_tokens = 2048, model = PRIMARY_MODEL } = {}) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Groq API error ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    // Groq sends retry-after on a 429; it knows when the token bucket refills
    // better than any backoff we'd guess at.
    const ra = parseFloat(res.headers.get('retry-after'));
    err.retryAfter = Number.isFinite(ra) ? ra : null;
    throw err;
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Groq returned no choices');
  // finish_reason 'length' means the JSON was cut off mid-stream — parsing it
  // would throw anyway, but flag it explicitly so the caller/logs are clear.
  if (choice.finish_reason === 'length') {
    throw new Error('Groq response truncated (hit max_tokens) — raise the limit');
  }
  try {
    return JSON.parse(choice.message.content);
  } catch {
    throw new Error('Groq returned malformed JSON');
  }
}

// groqChat plus bounded backoff for transient statuses only.
async function groqChatRetrying(apiKey, messages, opts = {}, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await groqChat(apiKey, messages, opts);
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_STATUSES.has(err.status) || attempt === maxAttempts - 1) throw err;
      const waitMs = err.retryAfter != null
        ? Math.min(err.retryAfter * 1000 + 250, 12000)
        : 1500 * (attempt + 1);
      console.warn(`[groq] ${err.status} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// A rate limit that outlived the retries is load, not a defect. Answering 429
// (rather than 500) is what keeps it out of the frontend's crash funnel —
// report.js funnels anything >= 500 straight into the bug inbox.
// Returns true if it handled the response, so callers can `if (...) return;`.
function sendIfRateLimited(res, err, message) {
  if (err?.status !== 429) return false;
  res.status(429).json({
    error: message,
    code: 'AI_RATE_LIMIT',
    retry_after: Math.ceil(err.retryAfter || 30),
  });
  return true;
}

module.exports = {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  TRANSIENT_STATUSES,
  sleep,
  getGroqKey,
  groqChat,
  groqChatRetrying,
  sendIfRateLimited,
};
