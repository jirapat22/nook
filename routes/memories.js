// Quick memories — the "remember this" side of Nook.
//
// A journal entry is a reflection on the day; a memory is one small fact you
// want to be able to find again months later ("Sarah's birthday is 12 March",
// "lent Tom $50", "that ramen place in Ponsonby"). So this flow is built for
// speed: the save answers immediately, and the AI tidy-up (title, kind, tags,
// people, date) runs afterwards in the background. Finding things again is
// "Ask Nook": a plain-English question answered from your memories + journal.

const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { reportHandled } = require('../lib/reports');
const { getGroqKey, groqChatRetrying, sendIfRateLimited } = require('../lib/groq');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['person', 'place', 'idea', 'money', 'date', 'health', 'fact', 'todo', 'other'];
const MAX_CONTENT = 4000; // a memory is a note, not an essay

// Columns the client gets back for a memory (one list, used everywhere).
const COLS = 'id, date, created_at, updated_at, content, entry_mode, title, kind, tags, people, event_date, analyzed';

// ── AI tidy-up ──────────────────────────────────────────────────────────
// Ids being tidied right now, so the self-heal in GET / doesn't start a second
// run on a memory whose first run just hasn't finished yet.
const inFlight = new Set();

// Every tracked name and nickname → the person it belongs to, lowercased, so
// "sarah" written in a memory still links to "Sarah".
async function peopleLookup() {
  const { rows } = await db.query('SELECT id, name, aliases FROM people');
  const byName = new Map();
  for (const p of rows) {
    if (p.name) byName.set(p.name.toLowerCase(), { id: p.id, name: p.name });
    for (const a of (Array.isArray(p.aliases) ? p.aliases : [])) {
      if (a && !byName.has(String(a).toLowerCase())) byName.set(String(a).toLowerCase(), { id: p.id, name: p.name });
    }
  }
  return { byName, names: rows.map(p => p.name).filter(Boolean) };
}

// Ask the AI to label one memory, then write the labels back. Never throws:
// it's background work, and if it fails the memory is still saved — it just
// stays `analyzed = false` and gets another go the next time the list loads.
async function tidyMemory(id) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const apiKey = await getGroqKey();
    if (!apiKey) return; // no key configured — memories still work, just unlabelled

    const { rows } = await db.query('SELECT id, content, date FROM memories WHERE id = $1', [id]);
    const m = rows[0];
    if (!m) return;
    const captured = String(m.date instanceof Date ? m.date.toISOString() : m.date).split('T')[0];

    const { byName, names } = await peopleLookup();

    const system = `You label a short personal note ("memory") so it can be found again later.
Return ONLY a JSON object:
{
  "title": "a 2-6 word label for the memory, e.g. \\"Sarah's birthday\\", \\"Lent Tom $50\\", \\"Ramen place in Ponsonby\\"",
  "kind": "one of: ${KINDS.join(', ')}",
  "tags": ["0-4 short lowercase topic tags"],
  "people": ["every person named in the note"],
  "event_date": "YYYY-MM-DD if the note is ABOUT a specific date (a birthday, a deadline, when something happened), else null"
}
Kinds: person = a fact about someone; place = somewhere to go/remember; idea = an idea or plan; money = money owed/lent/spent; date = a birthday/anniversary/appointment; health = body, symptoms, treatment, sleep, fitness or how a remedy is going; fact = any other fact; todo = ONLY an explicit action to take (\"buy\", \"call\", \"book\") — an update on how something is going is not a todo; other = none fit.
The note was written on ${captured}; resolve relative dates ("yesterday", "next Friday") from that day. For a yearly date with no year given (like a birthday), use its next occurrence on or after ${captured}.
The note may be a voice transcript with misheard words — label what was clearly meant.${names.length ? `\nPeople the user already tracks (use these exact spellings when one is meant): ${names.slice(0, 80).join(', ')}.` : ''}`;

    const out = await groqChatRetrying(apiKey, [
      { role: 'system', content: system },
      { role: 'user', content: m.content.slice(0, MAX_CONTENT) },
    ], { temperature: 0.2, max_tokens: 300 });

    // Trust nothing the model returns without checking its shape.
    const title = typeof out.title === 'string' ? out.title.trim().slice(0, 120) || null : null;
    const kind = KINDS.includes(out.kind) ? out.kind : 'other';
    const tags = (Array.isArray(out.tags) ? out.tags : [])
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim().toLowerCase().slice(0, 40))
      .slice(0, 4);
    const seen = new Set();
    const people = [];
    for (const raw of (Array.isArray(out.people) ? out.people : [])) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const hit = byName.get(raw.trim().toLowerCase());
      const person = hit ? { id: hit.id, name: hit.name } : { id: null, name: raw.trim().slice(0, 100) };
      const key = person.id || person.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      people.push(person);
    }
    const eventDate = typeof out.event_date === 'string' && DATE_RE.test(out.event_date) ? out.event_date : null;

    await db.query(
      `UPDATE memories SET title = $2, kind = $3, tags = $4, people = $5, event_date = $6, analyzed = TRUE
       WHERE id = $1`,
      [id, title, kind, JSON.stringify(tags), JSON.stringify(people), eventDate]
    );
  } catch (err) {
    // A rate limit is load, not a bug — the self-heal retries it later.
    if (err.status !== 429) reportHandled(err, { where: 'tidyMemory', id });
    else console.warn('[memories] tidy rate-limited, will retry later:', id);
  } finally {
    inFlight.delete(id);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/memories?limit=50  or  ?date=YYYY-MM-DD (one day)
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const params = [limit];
    let where = '';
    if (DATE_RE.test(req.query.date || '')) {
      params.push(req.query.date);
      where = 'WHERE date = $2';
    }
    const { rows } = await db.query(
      `SELECT ${COLS} FROM memories ${where} ORDER BY date DESC, created_at DESC LIMIT $1`, params
    );
    res.json(rows);

    // Self-heal: any memory whose tidy-up never finished (server restarted,
    // AI was rate-limited) gets another go. Older than a minute so we don't
    // race the run that the save itself just started. A few at a time.
    db.query(
      `SELECT id FROM memories WHERE analyzed = FALSE AND created_at < NOW() - INTERVAL '1 minute'
       ORDER BY created_at DESC LIMIT 3`
    ).then(r => r.rows.forEach(({ id }) => tidyMemory(id))).catch(() => {});
  } catch (err) {
    console.error('GET /api/memories error:', err);
    res.status(500).json({ error: 'Failed to load memories', code: 'DB_ERROR' });
  }
});

// POST /api/memories  { id, content, date, entry_mode }
router.post('/', async (req, res) => {
  try {
    const { id, date } = req.body || {};
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!UUID_RE.test(id || '')) return res.status(400).json({ error: 'Invalid id', code: 'BAD_ID' });
    if (!content) return res.status(400).json({ error: 'Memory is empty', code: 'EMPTY' });
    if (content.length > MAX_CONTENT) {
      return res.status(400).json({ error: 'That\'s a bit long for a memory — try a journal entry instead.', code: 'TOO_LONG' });
    }
    const day = DATE_RE.test(date || '') ? date : new Date().toISOString().split('T')[0];
    const mode = req.body.entry_mode === 'voice' ? 'voice' : 'text';

    // ON CONFLICT DO NOTHING: an offline save replayed by the service worker
    // after it already landed is simply ignored, not duplicated.
    await db.query(
      `INSERT INTO memories (id, date, content, entry_mode) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, day, content, mode]
    );
    const { rows } = await db.query(`SELECT ${COLS} FROM memories WHERE id = $1`, [id]);
    res.status(201).json(rows[0]);

    if (!rows[0]?.analyzed) tidyMemory(id); // background, after the response
  } catch (err) {
    console.error('POST /api/memories error:', err);
    res.status(500).json({ error: 'Failed to save memory', code: 'DB_ERROR' });
  }
});

// PUT /api/memories/:id  { content }  — edit the text; labels are redone.
router.put('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id', code: 'BAD_ID' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Memory is empty', code: 'EMPTY' });
    if (content.length > MAX_CONTENT) return res.status(400).json({ error: 'Memory is too long', code: 'TOO_LONG' });
    const { rows } = await db.query(
      `UPDATE memories SET content = $2, analyzed = FALSE, updated_at = NOW() WHERE id = $1 RETURNING ${COLS}`,
      [req.params.id, content]
    );
    if (!rows.length) return res.status(404).json({ error: 'Memory not found', code: 'NOT_FOUND' });
    res.json(rows[0]);
    tidyMemory(req.params.id);
  } catch (err) {
    console.error('PUT /api/memories error:', err);
    res.status(500).json({ error: 'Failed to update memory', code: 'DB_ERROR' });
  }
});

// DELETE /api/memories/:id
router.delete('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id', code: 'BAD_ID' });
    await db.query('DELETE FROM memories WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/memories error:', err);
    res.status(500).json({ error: 'Failed to delete memory', code: 'DB_ERROR' });
  }
});

// POST /api/memories/ask  { question }
// "Ask Nook": find the notes most likely to hold the answer, then have the AI
// answer from ONLY those notes (so it says "I couldn't find that" instead of
// making something up), pointing at the notes it used.
router.post('/ask', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 500) : '';
  if (!question) return res.status(400).json({ error: 'Ask me something first', code: 'EMPTY' });
  try {
    const apiKey = await getGroqKey();
    if (!apiKey) return res.status(400).json({ error: 'Groq API key not configured. Add it in Settings.', code: 'NO_API_KEY' });

    // Turn the question into an OR-search: "where did Tom say the ramen place
    // was" → where | tom | say | ramen | place. Postgres drops the filler words
    // and matches word stems (ramen ≈ ramens), and ranking puts the notes
    // sharing the most words first. Only letters/digits survive, so nothing
    // the user types can break the query syntax.
    const words = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []))].slice(0, 15);
    const tsq = words.join(' | ');

    const memSql = `SELECT id, date, content, title, people FROM memories`;
    const [matchedMem, recentMem, matchedEntries] = await Promise.all([
      tsq ? db.query(
        `${memSql},
           LATERAL to_tsvector('english', content || ' ' || coalesce(title, '') || ' ' || tags::text || ' ' || people::text) v
         WHERE v @@ to_tsquery('english', $1)
         ORDER BY ts_rank(v, to_tsquery('english', $1)) DESC, created_at DESC LIMIT 40`, [tsq]
      ).then(r => r.rows) : [],
      // The latest few always go in too, for "what did I note last week?"
      // style questions that share no words with the note itself.
      db.query(`${memSql} ORDER BY created_at DESC LIMIT 20`).then(r => r.rows),
      tsq ? db.query(
        `SELECT id, date, LEFT(COALESCE(NULLIF(first_person_summary, ''), NULLIF(ai_summary, ''), cleaned_content, ''), 700) AS text
         FROM entries WHERE search_vector @@ to_tsquery('english', $1)
         ORDER BY ts_rank(search_vector, to_tsquery('english', $1)) DESC LIMIT 8`, [tsq]
      ).then(r => r.rows) : [],
    ]);

    // Merge, de-duplicate, and give each note a short handle (M1, E1…) for the
    // AI to cite — far cheaper than making it repeat 36-character ids.
    const dateOf = d => String(d instanceof Date ? d.toISOString() : d).split('T')[0];
    const sources = [];
    const seen = new Set();
    for (const m of [...matchedMem, ...recentMem]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      sources.push({ ref: `M${sources.length + 1}`, type: 'memory', id: m.id, date: dateOf(m.date), text: m.content, title: m.title });
    }
    let e = 0;
    for (const en of matchedEntries) {
      if (!en.text) continue;
      sources.push({ ref: `E${++e}`, type: 'entry', id: en.id, date: dateOf(en.date), text: en.text });
    }

    if (!sources.length) {
      return res.json({ answer: "I couldn't find anything about that yet — nothing saved mentions it.", sources: [] });
    }

    const notes = sources.map(s => `[${s.ref}] (${s.date}, ${s.type === 'memory' ? 'memory' : 'journal'}) ${s.text}`).join('\n');
    const out = await groqChatRetrying(apiKey, [
      { role: 'system', content: `You are Nook, the user's personal memory. Answer their question using ONLY the notes below, which they wrote themselves. Be short, warm and direct, like a friend who remembers for them. Mention when it was noted if that helps. If the notes don't contain the answer, say so plainly — never guess or invent.
Return ONLY JSON: { "answer": "your answer (light markdown ok)", "used": ["refs of the notes you relied on, e.g. M3, E1"] }

Notes:
${notes}` },
      { role: 'user', content: question },
    ], { temperature: 0.2, max_tokens: 500 });

    const used = new Set((Array.isArray(out.used) ? out.used : []).map(String));
    res.json({
      answer: typeof out.answer === 'string' && out.answer.trim() ? out.answer.trim() : "Sorry, I couldn't work that one out.",
      sources: sources.filter(s => used.has(s.ref)).map(({ ref, ...s }) => s),
    });
  } catch (err) {
    if (sendIfRateLimited(res, err, "Nook's AI is busy right now — try asking again in a moment.")) return;
    console.error('POST /api/memories/ask error:', err);
    res.status(500).json({ error: 'Could not answer that right now', code: 'ASK_FAILED' });
  }
});

module.exports = router;
