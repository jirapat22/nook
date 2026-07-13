const express = require('express');
const router = express.Router();
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const db = require('../db/db');
const { reportHandled } = require('../lib/reports');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Helper: get Groq API key from settings or environment
async function getGroqKey() {
  // Prefer env var (Railway secret)
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here') {
    return process.env.GROQ_API_KEY;
  }
  // Fall back to DB setting
  const row = await db.query("SELECT value FROM settings WHERE key = 'groq_api_key'");
  const val = row.rows[0]?.value;
  if (val && val !== 'null' && val !== '"null"') {
    return val.replace(/^"|"$/g, '');
  }
  return null;
}

// Escape a string so it can be used safely inside a RegExp pattern
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fixed activity vocabulary — used both in the analyze prompt and to validate
// what comes back. Keep in sync with the client's components/activities.js.
const ACTIVITY_KEYS = ['work','gym','social','family','food','shopping','chores','travel','hobby','rest','health','study','date','outdoors'];

// Primary model is higher quality; fallback is far cheaper with much higher
// rate limits, so analysis still completes when the primary is throttled.
const PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Helper: call Groq chat completion
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

// Resilient analysis: try the primary model, a short backoff retry, then a
// leaner request against the fallback model. Confirmed via a real captured
// error (413 from Groq): llama-3.1-8b-instant caps at 6000 tokens/minute on
// this tier — a long voice entry plus the full enrichment context (known
// people, person memory, existing tags, recent entries) plus a 4000-token
// output reservation adds up past that easily. That's a hard per-request
// ceiling, not a transient rate limit — retrying the SAME oversized payload
// against the fallback model fails identically every time, no backoff helps.
// So fallback steps get the lean message set (messagesLean — same core
// instructions, enrichment context dropped, content capped) and a smaller
// max_tokens, trading a bit of personalization/detail for actually completing
// instead of guaranteed-failing.
async function analyzeResilient(apiKey, messagesFull, messagesLean) {
  const plan = [
    { model: PRIMARY_MODEL,  wait: 0,    messages: messagesFull, max_tokens: 4000 },
    { model: PRIMARY_MODEL,  wait: 3500, messages: messagesFull, max_tokens: 4000 },   // brief backoff for a transient/rate blip
    { model: FALLBACK_MODEL, wait: 0,    messages: messagesLean, max_tokens: 2000 },
    { model: FALLBACK_MODEL, wait: 2500, messages: messagesLean, max_tokens: 1500 },
  ];
  let lastErr;
  for (const step of plan) {
    if (step.wait) await sleep(step.wait);
    try {
      return await groqChat(apiKey, step.messages, { max_tokens: step.max_tokens, model: step.model });
    } catch (err) {
      lastErr = err;
      console.warn(`[analyze] ${step.model} failed (${err.status || '?'}): ${err.message}`);
    }
  }
  throw lastErr;
}

// POST /api/ai/transcribe — audio blob → text
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const apiKey = await getGroqKey();
    if (!apiKey) {
      return res.status(400).json({
        error: 'Groq API key not configured. Add it in Settings.',
        code: 'NO_API_KEY',
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided', code: 'MISSING_FILE' });
    }

    // Pick the right extension so Whisper knows the format
    const mime = req.file.mimetype || '';
    let fileExt = 'webm';
    if (mime.includes('mp4') || mime.includes('m4a')) fileExt = 'm4a';
    else if (mime.includes('ogg')) fileExt = 'ogg';

    // Bias Whisper toward correctly spelling the names of people the user tracks,
    // so it stops inventing phonetic spellings (e.g. "Vinnie" for a real name).
    // Whisper treats the prompt as a vocabulary/spelling hint (~224-token budget),
    // so cap the list.
    let namePrompt = '';
    try {
      const people = await db.query('SELECT name, aliases FROM people ORDER BY updated_at DESC LIMIT 60');
      const names = [];
      for (const p of people.rows) {
        if (p.name) names.push(p.name);
        if (Array.isArray(p.aliases)) names.push(...p.aliases);
      }
      const unique = [...new Set(names.filter(Boolean))].slice(0, 60);
      if (unique.length) namePrompt = `People who may be mentioned: ${unique.join(', ')}.`;
    } catch { /* non-fatal — transcription still works without the hint */ }

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: `audio.${fileExt}`,
      contentType: mime || 'audio/webm',
    });
    // Transcription language. 'auto' lets Whisper detect (better for Thai or
    // mixed speech); a specific code forces that language. Default 'en'.
    let lang = 'en';
    try {
      const row = await db.query("SELECT value FROM settings WHERE key = 'transcribe_language'");
      const v = row.rows[0]?.value;
      if (typeof v === 'string') lang = v.replace(/^"|"$/g, '') || 'en';
    } catch { /* non-fatal — default to English */ }

    form.append('model', 'whisper-large-v3');
    if (lang && lang !== 'auto') form.append('language', lang);
    form.append('response_format', 'json');
    if (namePrompt) form.append('prompt', namePrompt);

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!groqRes.ok) {
      const body = await groqRes.text();
      console.error('Groq transcription error:', body);
      return res.status(502).json({
        error: 'Transcription failed. Your entry is saved without AI analysis.',
        code: 'TRANSCRIPTION_FAILED',
      });
    }

    const data = await groqRes.json();
    res.json({ transcript: data.text });
  } catch (err) {
    console.error('POST /api/ai/transcribe error:', err);
    // Capture the REAL error (Groq status/message) here — the generic
    // response body below is what the finish-hook middleware in server.js
    // would otherwise save as the report's message, which told us nothing
    // useful across dozens of recurring "AI analysis unavailable" reports.
    res.locals._reported = true;
    reportHandled(err, { method: req.method, path: req.originalUrl, groqStatus: err.status });
    res.status(500).json({
      error: 'Transcription service unavailable. Your entry is saved.',
      code: 'SERVER_ERROR',
    });
  }
});

// POST /api/ai/analyze — full entry analysis
router.post('/analyze', async (req, res) => {
  try {
    const apiKey = await getGroqKey();
    if (!apiKey) {
      return res.status(400).json({
        error: 'Groq API key not configured. Add it in Settings.',
        code: 'NO_API_KEY',
      });
    }

    const { content, context, conversation_history = [] } = req.body;
    if (!content && !context) {
      return res.status(400).json({ error: 'content is required', code: 'VALIDATION_ERROR' });
    }

    // Fetch known people so AI can recognise aliases and resolve ambiguous names
    let knownPeopleContext = '';
    let allPeople = [];
    try {
      const peopleResult = await db.query('SELECT id, name, relationship_type, aliases FROM people ORDER BY name');
      allPeople = peopleResult.rows;
      if (allPeople.length) {
        const list = allPeople.map(p => {
          const aliases = Array.isArray(p.aliases) && p.aliases.length ? p.aliases : [];
          const akaStr  = aliases.length ? ` (also known as: ${aliases.join(', ')})` : '';
          const relStr  = p.relationship_type ? ` [${p.relationship_type}]` : '';
          return `• ${p.name}${akaStr}${relStr}`;
        }).join('\n');
        knownPeopleContext = `\n\nPeople already tracked in this journal:\n${list}\nIMPORTANT: If the entry mentions any of these people by any name or alias, always use their PRIMARY name (the bullet-point name) in people_mentioned[].name.`;
      }
    } catch { /* non-fatal — analysis still works */ }

    // Person-specific memory: pre-scan the entry text for known people, then
    // pull recent mentions of each so the AI knows context like "Sarah seemed
    // distant last week" and can connect it to today's entry.
    let personMemoryContext = '';
    try {
      const entryText = (content || context || '').toLowerCase();
      // \b only recognises ASCII word chars, so it never anchors around Thai or
      // other non-Latin names — fall back to a plain substring check for those.
      const matchesName = (name) => {
        const n = (name || '').toLowerCase();
        if (!n) return false;
        return /^[\x00-\x7f]*$/.test(n)
          ? new RegExp(`\\b${escapeRegex(n)}\\b`).test(entryText)
          : entryText.includes(n);
      };
      const hits = new Set();
      for (const p of allPeople) {
        const names = [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])];
        if (names.some(matchesName)) hits.add(p.id);
      }
      if (hits.size > 0 && hits.size <= 5) {
        const memorySections = [];
        for (const pid of hits) {
          const person = allPeople.find(p => p.id === pid);
          const memories = await db.query(`
            SELECT pm.context, pm.emotion_toward, pm.sentiment_score, e.date, e.ai_summary
            FROM person_mentions pm
            JOIN entries e ON e.id = pm.entry_id
            WHERE pm.person_id = $1
            ORDER BY e.date DESC, pm.mentioned_at DESC
            LIMIT 4
          `, [pid]);
          if (memories.rows.length) {
            const lines = memories.rows.map(m => {
              const d = String(m.date).split('T')[0];
              const emo = m.emotion_toward ? ` [${m.emotion_toward}]` : '';
              return `  - ${d}${emo}: ${m.context || m.ai_summary || ''}`;
            }).join('\n');
            memorySections.push(`${person.name}:\n${lines}`);
          }
        }
        if (memorySections.length) {
          personMemoryContext = `\n\nRecent context about people you mentioned today (use this to make connections, e.g. "you said Sarah was distant last week — did that come up today?"):\n${memorySections.join('\n\n')}`;
        }
      }
    } catch { /* non-fatal */ }

    // Fetch existing themes and tags so AI reuses them instead of creating duplicates.
    // Without this, "work stress" and "stress at work" become separate tags forever.
    let existingTagsContext = '';
    try {
      const tagsResult = await db.query(`
        SELECT 'theme' as kind, t.value, COUNT(*)::int as cnt
        FROM entries e, jsonb_array_elements_text(e.key_themes) t(value)
        WHERE e.date >= CURRENT_DATE - INTERVAL '90 days'
        GROUP BY t.value
        UNION ALL
        SELECT 'tag' as kind, t.value, COUNT(*)::int as cnt
        FROM entries e, jsonb_array_elements_text(e.tags) t(value)
        WHERE e.date >= CURRENT_DATE - INTERVAL '90 days'
        GROUP BY t.value
        ORDER BY cnt DESC LIMIT 40
      `);
      if (tagsResult.rows.length) {
        const themes = tagsResult.rows.filter(r => r.kind === 'theme').map(r => r.value);
        const tags   = tagsResult.rows.filter(r => r.kind === 'tag').map(r => r.value);
        const blocks = [];
        if (themes.length) blocks.push(`Existing themes: ${themes.join(', ')}`);
        if (tags.length)   blocks.push(`Existing tags: ${tags.join(', ')}`);
        existingTagsContext = `\n\n${blocks.join('\n')}\nIMPORTANT: If a theme or tag in the entry matches or is similar to one above (e.g. "work-stress" vs "work stress" vs "stress at work"), REUSE the exact existing wording. Only invent new themes/tags for genuinely new topics.`;
      }
    } catch { /* non-fatal */ }

    // Fetch last 7 days of entries for pattern detection
    let recentContext = '';
    try {
      const recentResult = await db.query(`
        SELECT date, ai_summary, key_themes, mood_overall
        FROM entries
        WHERE date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY date DESC, created_at DESC
        LIMIT 10
      `);
      if (recentResult.rows.length) {
        const lines = recentResult.rows.map(e => {
          const d = String(e.date).split('T')[0];
          const themes = Array.isArray(e.key_themes) && e.key_themes.length ? ` [${e.key_themes.join(', ')}]` : '';
          const mood = e.mood_overall != null ? ` (mood ${e.mood_overall}/10)` : '';
          return `${d}: ${e.ai_summary || '(no summary)'}${themes}${mood}`;
        }).join('\n');
        recentContext = `\n\nRecent entries (last 7 days, for spotting patterns):\n${lines}\nIf this new entry continues a pattern from above (recurring theme, same mood dip, same person/situation coming up again), set followup_question to gently name the pattern — like a friend who noticed.`;
      }
    } catch { /* non-fatal */ }

    const systemPrompt = `You are Nook, a warm and insightful personal journal assistant.
Analyze the user's journal entry and return a JSON object with EXACTLY this structure:
{
  "first_person_summary": "A diary-style narrative of the day in FIRST PERSON ('Today I...', 'I felt...', 'I'm thinking about...'). Cover EVERYTHING meaningful the user said — every person, event, plan, worry, and unresolved thread (e.g. 'the thing with Luke'). Do NOT compress the day into a few lines or drop details to be brief: let the length match how much they shared, so a long entry gets a long summary. Fix grammar and remove filler, but keep all the substance. It should read like the user's own complete diary entry in their voice, not a short report or highlight reel. Light markdown for structure, used sparingly: if the entry covers several distinct events or topics (e.g. work, then gym, then a call with a friend), separate them into short paragraphs (blank line between) or a '- ' bullet per event so it's scannable at a glance — don't force structure on a single continuous thought. **Bold** only a genuinely standout fact or number (a time, a duration, an amount) here and there, not every sentence.",
  "ai_summary": "2-3 sentence outside-view summary (third-person OK here — this is the brief overview shown in lists).",
  "key_themes": ["theme1", "theme2"],
  "action_items": ["thing to do 1"],
  "important_today": "The single most important thing from this entry",
  "mood": {
    "energy": null,
    "happiness": null,
    "anxiety": null,
    "confidence": null,
    "motivation": null,
    "social_battery": null,
    "physical": null,
    "focus": null,
    "overall": null,
    "uncertain_dimensions": []
  },
  "life_areas": [],
  "suggested_tags": [],
  "activities": [],
  "sleep_hours": null,
  "has_love_life_content": false,
  "love_life_content": null,
  "love_life_emotion_intensity": null,
  "people_mentioned": [],
  "missing_fields": [],
  "followup_question": null
}

CRITICAL VOICE RULES:
- first_person_summary must be in the user's voice ("I"), as if they wrote it themselves.
- NEVER write "The user is feeling..." or "The user mentions..." there. Only ai_summary can be third-person.

MOOD RULES (read carefully — this matters):
- "overall" must ALWAYS be your best-guess 0-10 read of how the day felt. It is shown to
  the user as a one-tap suggestion they confirm or adjust, so a sensible guess beats null.
  Use the full range and lean with the evidence; use 5 only for a genuinely flat day.
  NEVER set overall to null and NEVER put "overall" in uncertain_dimensions.
- The SUB-dimensions (energy, happiness, anxiety, confidence, motivation, social_battery,
  physical, focus) are optional detail. Only give one a 0-10 score when the entry has
  DIRECT evidence for it. If you'd be guessing, set that sub-dimension to null AND add its
  name to uncertain_dimensions[]. It's fine for all sub-dimensions to be null.
- Avoid 5 as a lazy default for sub-dimensions — use it only if the user explicitly
  described that dimension as neutral.
- "overall" is a holistic read — do NOT just average the sub-dimensions.

Life areas should be from: Health & Fitness, Work & Career, Relationships & Social, Personal Growth, Creativity, Finance, Travel & Adventure, Mental Health, Family, Love Life, Hobbies, Home & Lifestyle.
"activities" is a glanceable list of WHAT THE USER ACTUALLY DID that day, chosen ONLY from this exact set (use the lowercase keys): ${ACTIVITY_KEYS.join(', ')}. Include only the ones clearly present in the entry (0-6), most prominent first. Guidance: gym = any exercise/workout/sport; social = hanging out with friends/people; food = cooking, eating out, a notable meal; chores = cleaning, errands, laundry, home tasks; hobby = games, reading, music, making things; rest = relaxing, napping, doing nothing; health = appointments, self-care, being unwell; study = learning/studying; date = romantic/love-life time; outdoors = nature, walks, being outside. Do NOT invent keys outside this set.
"sleep_hours" — ONLY set this when the entry directly states or clearly implies how long they slept (e.g. "only got 5 hours of sleep", "slept great, a full 8 hours", "went to bed at 2am and up at 7" -> 5). A number, decimals allowed (e.g. 6.5). Leave null if sleep isn't mentioned — do NOT guess or infer from mood/tiredness alone.
For people_mentioned, each item: { "name": string, "context": string, "facts_extracted": [], "sentiment": -5 to 5, "emotion_toward": string, "inferred_relationship": one of: "friend" | "family" | "crush" | "partner" | "colleague" | "pet" | "group" | "acquaintance" | "unknown", "uncertain": boolean }
  - inferred_relationship: best guess based on how the user talks about them. "my friend", "mum", "boss", "colleague" are strong signals. Use "pet" for animals the user names (dogs, cats, etc.) and "group" for collective entities ("the team", "the friend group"). Use "unknown" only when there's no clue.
  - BE THOROUGH: include EVERYONE the user refers to, even briefly or only by role ("my boss", "a girl at the gym", "my landlord") — give them the best name/label you can. It's better to surface a person and let the user confirm than to silently miss them.
  - uncertain: set to true ONLY when you genuinely cannot tell whether a name refers to a PERSON or to something else (a place, brand, app, object, or a possibly mis-transcribed word that might be a name). Still include the item, set inferred_relationship to "unknown", and the app will ask the user "Is this a person?". For clear people/pets, set uncertain to false.
  - CRITICAL: If the user explicitly names their pets (e.g. "my cats Yuzu, Shogun, Mocha and Latte"), include EACH named pet as a separate entry in people_mentioned with inferred_relationship="pet". Never skip named pets — they matter just as much as named people.
missing_fields should list important fields that couldn't be determined.
followup_question should be ONE warm, natural follow-up question. Ask one whenever the entry leaves something unfinished, vague, or emotionally open — a person or event named without detail ("the thing with Luke"), a feeling mentioned but not explained, or a situation left hanging. Phrase it like a friend gently checking in. Only use null when the entry is genuinely complete and self-contained with nothing worth following up on.`;

    const enrichment = `${knownPeopleContext}${personMemoryContext}${existingTagsContext}${recentContext}`;
    const systemPromptFull = systemPrompt + enrichment;

    // Lean path for the fallback model — see analyzeResilient's comment.
    // Enrichment (known people, memory, tags, recent entries) is dropped
    // entirely rather than trimmed, since keeping it partial risks the AI
    // treating it as complete (e.g. missing someone from a truncated known-
    // people list). Content is hard-capped as a last resort for the rare
    // very-long entry; ~4 chars/token is a safe-enough estimate here since
    // going over costs a guaranteed 413, going under just costs a bit of
    // unused budget.
    const rawContent = content || context;
    const FALLBACK_CONTENT_CHAR_CAP = 6000;
    const leanContent = rawContent.length > FALLBACK_CONTENT_CHAR_CAP
      ? rawContent.slice(0, FALLBACK_CONTENT_CHAR_CAP) + '\n\n[entry truncated for length in this fallback pass]'
      : rawContent;

    const messagesFull = [
      { role: 'system', content: systemPromptFull },
      ...conversation_history,
      { role: 'user', content: rawContent },
    ];
    const messagesLean = [
      { role: 'system', content: systemPrompt },
      ...conversation_history,
      { role: 'user', content: leanContent },
    ];

    const analysis = await analyzeResilient(apiKey, messagesFull, messagesLean);

    // Safeguard for SUB-dimensions only: Llama gravitates to 5 when uncertain, so
    // null out smells-like-default sub-dimension values and mark them uncertain.
    // "overall" is intentionally exempt — it's always a best guess the user confirms.
    // Normalize first: the fallback model (smaller, tighter token budget) can omit
    // the whole "mood" key rather than emit it with nulls. Without this, the block
    // below never runs and the "overall is never null" guarantee silently breaks.
    if (!analysis.mood || typeof analysis.mood !== 'object') analysis.mood = {};
    {
      const subKeys = ['energy','happiness','anxiety','confidence','motivation','social_battery','physical','focus'];
      const numeric = subKeys
        .map(k => ({ k, v: analysis.mood[k] }))
        .filter(x => typeof x.v === 'number');
      const fives = numeric.filter(x => x.v === 5);
      const distinct = new Set(numeric.map(x => x.v)).size;
      const uncertain = new Set((analysis.mood.uncertain_dimensions || []).filter(d => d !== 'overall'));

      // 3+ sub-dimensions returned exactly 5 (or all identical) → treat as defaulted.
      const looksDefaulted =
        (numeric.length >= 3 && fives.length >= 3) ||
        (numeric.length >= 4 && distinct === 1);
      if (looksDefaulted) {
        for (const { k, v } of numeric) {
          if (v === 5 || distinct === 1) {
            analysis.mood[k] = null;
            uncertain.add(k);
          }
        }
      }

      // overall is never null — fall back to a neutral 5 the user can adjust.
      if (typeof analysis.mood.overall !== 'number') analysis.mood.overall = 5;

      analysis.mood.uncertain_dimensions = [...uncertain];
    }

    // Keep only valid, de-duplicated activity keys (the AI is told to use this set).
    if (Array.isArray(analysis.activities)) {
      const seen = new Set();
      analysis.activities = analysis.activities
        .map(a => String(a || '').toLowerCase().trim())
        .filter(a => ACTIVITY_KEYS.includes(a) && !seen.has(a) && seen.add(a))
        .slice(0, 6);
    } else {
      analysis.activities = [];
    }

    // sleep_hours: only trust a plausible number, discard anything else the
    // model might hallucinate (a string, a huge number, negative, etc).
    const sh = analysis.sleep_hours;
    analysis.sleep_hours = (typeof sh === 'number' && isFinite(sh) && sh >= 0 && sh <= 24)
      ? Math.round(sh * 2) / 2  // nearest half-hour — matches the manual stepper
      : null;

    // Same class of guard as activities/sleep_hours above, for the remaining
    // free-text array fields: a malformed LLM response (e.g. a string instead
    // of an array) would otherwise flow straight to the client and, once
    // saved, break every jsonb_array_elements_text aggregate query for that
    // entry (routes/tags.js, routes/insights.js) — not just this request.
    analysis.key_themes = Array.isArray(analysis.key_themes) ? analysis.key_themes.filter(t => typeof t === 'string') : [];
    analysis.life_areas = Array.isArray(analysis.life_areas) ? analysis.life_areas.filter(t => typeof t === 'string') : [];
    analysis.suggested_tags = Array.isArray(analysis.suggested_tags) ? analysis.suggested_tags.filter(t => typeof t === 'string') : [];
    analysis.people_mentioned = Array.isArray(analysis.people_mentioned)
      ? analysis.people_mentioned.filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
      : [];

    res.json(analysis);
  } catch (err) {
    console.error('POST /api/ai/analyze error:', err);
    // Same reasoning as /transcribe above — capture the real Groq
    // status/message (rate limit, invalid key, malformed JSON, etc.) instead
    // of letting the generic client-facing message become the report body.
    res.locals._reported = true;
    reportHandled(err, { method: req.method, path: req.originalUrl, groqStatus: err.status });
    res.status(500).json({
      error: 'AI analysis unavailable — your entry is saved. We\'ll try again later.',
      code: 'AI_ERROR',
    });
  }
});

// POST /api/ai/followup — generate next follow-up question
router.post('/followup', async (req, res) => {
  try {
    const apiKey = await getGroqKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'Groq API key not configured', code: 'NO_API_KEY' });
    }

    const { entry_so_far, conversation_history = [], round = 1 } = req.body;

    if (round > 3) {
      return res.json({ question: null, done: true });
    }

    const systemPrompt = `You are Nook, a warm journal companion. Based on what the user has shared so far and any missing information, generate ONE warm, natural follow-up question to help fill in gaps or deepen understanding. Keep it conversational, not clinical. Return JSON: { "question": "...", "done": false } or { "question": null, "done": true } if nothing important is missing.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversation_history,
      { role: 'user', content: `Entry so far: ${JSON.stringify(entry_so_far)}\nRound: ${round}` },
    ];

    const result = await groqChat(apiKey, messages, { max_tokens: 256 });
    res.json(result);
  } catch (err) {
    console.error('POST /api/ai/followup error:', err);
    res.json({ question: null, done: true });
  }
});

// POST /api/ai/reflect — generate warm reflection questions for a past entry
router.post('/reflect', async (req, res) => {
  try {
    const { entry_id } = req.body;
    if (!entry_id) return res.status(400).json({ error: 'entry_id required' });

    const apiKey = await getGroqKey();
    if (!apiKey) return res.status(400).json({ error: 'No AI key configured', code: 'NO_KEY' });

    const entryResult = await db.query('SELECT * FROM entries WHERE id = $1', [entry_id]);
    if (!entryResult.rows.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = entryResult.rows[0];

    // Recent entries for pattern context
    const recentResult = await db.query(`
      SELECT date, ai_summary, key_themes, mood_overall
      FROM entries WHERE id != $1
      ORDER BY date DESC LIMIT 15
    `, [entry_id]);

    const recentContext = recentResult.rows.length
      ? recentResult.rows.map(e =>
          `${String(e.date).split('T')[0]}: ${e.ai_summary || '(no summary)'} [themes: ${(e.key_themes || []).join(', ')}]`
        ).join('\n')
      : 'No other entries yet.';

    const entryDate = String(entry.date).split('T')[0];
    const content = entry.cleaned_content || entry.raw_transcript || '';

    const result = await groqChat(apiKey, [
      {
        role: 'system',
        content: `You are a warm, caring close friend who has been reading this person's journal for a while. You ask follow-up questions that feel natural and genuine — like a friend who actually listened and remembered.

Pick 2 questions from these angles (choose the ones that fit the entry best):
1. The "why" — dig into what's underneath something they mentioned but didn't explain ("you said it was fine, but...")
2. What happens next — follow up on open threads, unresolved decisions, or people they're unsure about
3. The unsaid — gently notice what they seem to be avoiding or not saying about how THEY feel (not just what happened)
4. Small wins / gratitude — name a good moment they mentioned and ask them to sit with it
5. Pattern check — if the same theme (work stress, someone, a feeling) keeps appearing in recent entries, name it directly but kindly. This is the one place you can be a little more direct if it's clearly a recurring thing.

Tone: warm and casual, mostly soft. But if you spot a clear pattern across multiple entries, you can be gently direct — like a good friend who finally says "okay but you've mentioned this every week, what's really going on?"

Return JSON: { "questions": ["q1", "q2"] } — 2 questions max, 1-2 sentences each.`,
      },
      {
        role: 'user',
        content: `Entry from ${entryDate}${entry.time_of_day ? ' (' + entry.time_of_day + ')' : ''}:\n\n${content}\n\n---\nRecent context (for spotting patterns):\n${recentContext}`,
      },
    ], { temperature: 0.8, max_tokens: 300 });

    res.json({ questions: Array.isArray(result.questions) ? result.questions : [] });
  } catch (err) {
    console.error('POST /api/ai/reflect error:', err);
    res.locals._reported = true;
    reportHandled(err, { method: req.method, path: req.originalUrl, groqStatus: err.status });
    res.status(500).json({ error: 'Could not generate questions', code: 'AI_ERROR' });
  }
});

module.exports = router;
