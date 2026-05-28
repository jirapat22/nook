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
  return JSON.parse(data.choices[0].message.content);
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

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: `audio.${fileExt}`,
      contentType: mime || 'audio/webm',
    });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'en');
    form.append('response_format', 'json');

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
      const hits = new Set();
      for (const p of allPeople) {
        const names = [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])];
        // Word-boundary match so "ben" doesn't match "bench"
        if (names.some(n => new RegExp(`\\b${escapeRegex(n.toLowerCase())}\\b`).test(entryText))) {
          hits.add(p.id);
        }
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
  "first_person_summary": "A diary-style narrative of the day in FIRST PERSON ('Today I...', 'I felt...', 'I'm thinking about...'). 3-6 sentences. Read like the user wrote it themselves, not like a report.",
  "cleaned_content": "A cleaned-up version of what they ACTUALLY SAID, in FIRST PERSON ('I' voice), removing filler words and fixing grammar. NEVER write 'The user is...' or 'The user feels...' — always 'I am...', 'I feel...'.",
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
- first_person_summary AND cleaned_content must be in the user's voice ("I"), as if they wrote it themselves.
- NEVER write "The user is feeling..." or "The user mentions..." in these fields. Only ai_summary can be third-person.

For mood scores use 0-10 integer or null if genuinely unclear. Life areas should be from: Health & Fitness, Work & Career, Relationships & Social, Personal Growth, Creativity, Finance, Travel & Adventure, Mental Health, Family, Love Life, Hobbies, Home & Lifestyle.
For people_mentioned, each item: { "name": string, "context": string, "facts_extracted": [], "sentiment": -5 to 5, "emotion_toward": string, "inferred_relationship": one of: "friend" | "family" | "crush" | "partner" | "colleague" | "mentor" | "acquaintance" | "unknown" }
  - inferred_relationship: best guess based on how the user talks about them. Words like "my friend", "mum", "boss", "colleague" are strong signals. Use "unknown" only when there's no clue.
missing_fields should list important fields that couldn't be determined.
followup_question should be ONE warm, natural follow-up question (or null if nothing important is missing).${knownPeopleContext}${personMemoryContext}${existingTagsContext}${recentContext}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversation_history,
      { role: 'user', content: content || context },
    ];

    const analysis = await groqChat(apiKey, messages);
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
