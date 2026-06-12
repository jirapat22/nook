const express = require('express');
const router = express.Router();
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const db = require('../db/db');

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

// Helper: call Groq chat completion
async function groqChat(apiKey, messages, { temperature = 0.3, max_tokens = 2048 } = {}) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature,
      max_tokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error ${res.status}: ${body}`);
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
  "first_person_summary": "A diary-style narrative of the day in FIRST PERSON ('Today I...', 'I felt...', 'I'm thinking about...'). Cover EVERYTHING meaningful the user said — every person, event, plan, worry, and unresolved thread (e.g. 'the thing with Luke'). Do NOT compress the day into a few lines or drop details to be brief: let the length match how much they shared, so a long entry gets a long summary. Fix grammar and remove filler, but keep all the substance. It should read like the user's own complete diary entry in their voice, not a short report or highlight reel.",
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
- Only fill in a mood score (0-10 integer) when the entry contains DIRECT evidence for it
  (specific feelings, body language, energy words, etc.). Do NOT guess.
- If you would be guessing or just picking a "safe middle" — set that field to null AND
  add its name to uncertain_dimensions[].
- 5 is BANNED for "overall". 5 means "perfectly evenly balanced" which is almost never
  true. If you're tempted to write overall=5, use null instead. Use 4 for "leaning a
  little down" or 6 for "leaning a little up" if there's any directionality at all.
- For sub-dimensions (energy/happiness/etc.), still avoid 5 as a default. Only use 5 if
  the user EXPLICITLY described that dimension as neutral/balanced. When unsure: null.
- Do NOT average the other dimensions for "overall". They are independent reads.
- It's perfectly fine to return mood: { all-nulls + uncertain_dimensions: [...all dims] }
  for an entry that just lists facts without emotional content.
- ASK YOURSELF before each score: "What words in the entry let me say this?" If the
  answer is vague, the answer is null.

Life areas should be from: Health & Fitness, Work & Career, Relationships & Social, Personal Growth, Creativity, Finance, Travel & Adventure, Mental Health, Family, Love Life, Hobbies, Home & Lifestyle.
For people_mentioned, each item: { "name": string, "context": string, "facts_extracted": [], "sentiment": -5 to 5, "emotion_toward": string, "inferred_relationship": one of: "friend" | "family" | "crush" | "partner" | "colleague" | "pet" | "group" | "acquaintance" | "unknown", "uncertain": boolean }
  - inferred_relationship: best guess based on how the user talks about them. "my friend", "mum", "boss", "colleague" are strong signals. Use "pet" for animals the user names (dogs, cats, etc.) and "group" for collective entities ("the team", "the friend group"). Use "unknown" only when there's no clue.
  - BE THOROUGH: include EVERYONE the user refers to, even briefly or only by role ("my boss", "a girl at the gym", "my landlord") — give them the best name/label you can. It's better to surface a person and let the user confirm than to silently miss them.
  - uncertain: set to true ONLY when you genuinely cannot tell whether a name refers to a PERSON or to something else (a place, brand, app, object, or a possibly mis-transcribed word that might be a name). Still include the item, set inferred_relationship to "unknown", and the app will ask the user "Is this a person?". For clear people/pets, set uncertain to false.
  - CRITICAL: If the user explicitly names their pets (e.g. "my cats Yuzu, Shogun, Mocha and Latte"), include EACH named pet as a separate entry in people_mentioned with inferred_relationship="pet". Never skip named pets — they matter just as much as named people.
missing_fields should list important fields that couldn't be determined.
followup_question should be ONE warm, natural follow-up question. Ask one whenever the entry leaves something unfinished, vague, or emotionally open — a person or event named without detail ("the thing with Luke"), a feeling mentioned but not explained, or a situation left hanging. Phrase it like a friend gently checking in. Only use null when the entry is genuinely complete and self-contained with nothing worth following up on.${knownPeopleContext}${personMemoryContext}${existingTagsContext}${recentContext}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversation_history,
      { role: 'user', content: content || context },
    ];

    // Generous token budget: first_person_summary + ai_summary + people can be
    // large, and a truncated JSON fails to parse, leaving the entry with no
    // analysis at all. 8000 covers very long entries; llama-3.3-70b allows more.
    // Retry once on a transient failure (network blip, rate limit, malformed
    // JSON) — a single hiccup used to leave entries with no AI analysis.
    let analysis, lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        analysis = await groqChat(apiKey, messages, { max_tokens: 8000 });
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`analyze groqChat attempt ${attempt + 1} failed:`, err.message);
        if (attempt === 0) await new Promise(r => setTimeout(r, 800));
      }
    }
    if (!analysis) throw lastErr;

    // Safeguard: aggressive null-out of mood values that smell like LLM defaults.
    // Llama gravitates to 5 on a 0-10 scale when uncertain even when told not to.
    // Better to surface uncertainty than show fake middle-ground ratings.
    if (analysis.mood && typeof analysis.mood === 'object') {
      const dimKeys = ['energy','happiness','anxiety','confidence','motivation','social_battery','physical','focus','overall'];
      const numeric = dimKeys
        .map(k => ({ k, v: analysis.mood[k] }))
        .filter(x => typeof x.v === 'number');
      const fives = numeric.filter(x => x.v === 5);
      const distinct = new Set(numeric.map(x => x.v)).size;
      const uncertain = new Set(analysis.mood.uncertain_dimensions || []);

      // Rule 1: mood_overall === 5 is almost always a hedge. Force null.
      // 5/10 means "perfectly neutral, no lean" which is rare for a real entry.
      // If the user is genuinely a 5, they'll set it manually in the slider.
      if (analysis.mood.overall === 5) {
        analysis.mood.overall = null;
        uncertain.add('overall');
      }

      // Rule 2: 3+ dimensions returned exactly 5 (or all identical) → null the 5s
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

      analysis.mood.uncertain_dimensions = [...uncertain];
    }

    res.json(analysis);
  } catch (err) {
    console.error('POST /api/ai/analyze error:', err);
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
    res.status(500).json({ error: 'Could not generate questions', code: 'AI_ERROR' });
  }
});

module.exports = router;
