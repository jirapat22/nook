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
    try {
      const peopleResult = await db.query('SELECT name, relationship_type, aliases FROM people ORDER BY name');
      if (peopleResult.rows.length) {
        const list = peopleResult.rows.map(p => {
          const aliases = Array.isArray(p.aliases) && p.aliases.length ? p.aliases : [];
          const akaStr  = aliases.length ? ` (also known as: ${aliases.join(', ')})` : '';
          const relStr  = p.relationship_type ? ` [${p.relationship_type}]` : '';
          return `• ${p.name}${akaStr}${relStr}`;
        }).join('\n');
        knownPeopleContext = `\n\nPeople already tracked in this journal:\n${list}\nIMPORTANT: If the entry mentions any of these people by any name or alias, always use their PRIMARY name (the bullet-point name) in people_mentioned[].name.`;
      }
    } catch { /* non-fatal — analysis still works */ }

    const systemPrompt = `You are Nook, a warm and insightful personal journal assistant.
Analyze the user's journal entry and return a JSON object with EXACTLY this structure:
{
  "cleaned_content": "Cleaned, readable version of the entry (remove filler words, fix grammar, keep their voice and tone)",
  "ai_summary": "2-3 sentence summary",
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

For mood scores use 0-10 integer or null if genuinely unclear. Life areas should be from: Health & Fitness, Work & Career, Relationships & Social, Personal Growth, Creativity, Finance, Travel & Adventure, Mental Health, Family, Love Life, Hobbies, Home & Lifestyle.
For people_mentioned, each item: { "name": string, "context": string, "facts_extracted": [], "sentiment": -5 to 5, "emotion_toward": string }
missing_fields should list important fields that couldn't be determined.
followup_question should be ONE warm, natural follow-up question (or null if nothing important is missing).${knownPeopleContext}`;

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
