// Shared analysis helpers used by the on-load auto-heal, the Settings bulk
// button, and the post-save background analyse — so the mapping lives once.

// Map an /api/ai/analyze result to an entry-update payload. Mood is only
// included when fillMood is true (entry had none) so set moods aren't clobbered.
export function analysisToPayload(a, { fillMood = false } = {}) {
  const payload = {
    ai_summary: a.ai_summary || null,
    first_person_summary: a.first_person_summary || null,
    key_themes: a.key_themes || [],
    action_items: a.action_items || [],
    important_today: a.important_today || null,
    life_areas: a.life_areas || [],
    tags: a.suggested_tags || [],
    activities: Array.isArray(a.activities) ? a.activities : [],
    detected_people: Array.isArray(a.people_mentioned) ? a.people_mentioned : [],
  };
  // Only set when the AI actually detected a mention this round — never null
  // out an existing (manually-set or previously-detected) value just because
  // a re-analysis pass didn't happen to catch it again.
  if (a.sleep_hours != null) payload.sleep_hours = a.sleep_hours;
  if (fillMood && a.mood) {
    const m = a.mood;
    Object.assign(payload, {
      mood_energy: m.energy ?? null, mood_happiness: m.happiness ?? null,
      mood_anxiety: m.anxiety ?? null, mood_confidence: m.confidence ?? null,
      mood_motivation: m.motivation ?? null, mood_social_battery: m.social_battery ?? null,
      mood_physical: m.physical ?? null, mood_focus: m.focus ?? null,
      mood_overall: m.overall ?? null, mood_source: 'ai_detected',
    });
  }
  return payload;
}

// When Groq is down, POST /api/ai/analyze hands the entry to the home Mac's
// local AI and answers 202 { job_id } straight away, because the local AI
// needs ~1-2 minutes, longer than a request may stay open (Cloudflare cuts it
// at 100s). This checks back every few seconds until the analysis is ready.
export async function waitForLocalAnalysis(api, jobId, { isCancelled, maxWaitMs = 6 * 60_000 } = {}) {
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 4000));
    if (isCancelled && isCancelled()) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    const job = await api.get(`/api/ai/analyze/jobs/${jobId}`);
    if (job.status === 'done') return job.result;
    if (job.status === 'error') {
      throw Object.assign(new Error('AI analysis unavailable, but your entry is saved.'), { code: 'AI_ERROR' });
    }
  }
  throw Object.assign(new Error('AI took too long, but your entry can still be saved'), { code: 'AI_TIMEOUT' });
}

// POST /api/ai/analyze and return the analysis, waiting for the local AI if
// the server had to hand it over (see waitForLocalAnalysis).
export async function postAnalyze(api, body) {
  const first = await api.post('/api/ai/analyze', body);
  return first && first.job_id ? waitForLocalAnalysis(api, first.job_id) : first;
}

// Analyse entries saved without AI analysis and write the results back. Paced,
// best-effort (failures are skipped and retried on a later run). `cap` limits
// how many to process this pass (0 = all). Returns { done, failed, skipped, total }.
export async function healMissingEntries(api, { cap = 0, delay = 800, onProgress } = {}) {
  const all = await api.get('/api/entries?limit=365');
  const missing = all.filter(e => !e.first_person_summary && !e.ai_summary);
  const batch = cap ? missing.slice(0, cap) : missing;
  let done = 0, failed = 0, skipped = 0;
  for (let i = 0; i < batch.length; i++) {
    if (onProgress) onProgress(i + 1, batch.length);
    try {
      const full = await api.get(`/api/entries/${batch[i].id}`);
      const content = (full.user_edited_content || full.cleaned_content || full.raw_transcript || '').trim();
      if (!content) { skipped++; continue; }
      const a = await postAnalyze(api, { content });
      await api.put(`/api/entries/${batch[i].id}`, analysisToPayload(a, { fillMood: full.mood_overall == null }));
      done++;
    } catch (err) {
      failed++;
      // NO_API_KEY will fail for every remaining entry too — stop burning the
      // budget on calls that can't possibly succeed (this runs on every app
      // load, so without this a missing/invalid key wastes `cap` calls each time).
      if (err && err.code === 'NO_API_KEY') break;
    }
    await new Promise(r => setTimeout(r, delay));
  }
  return { done, failed, skipped, total: missing.length, processed: batch.length };
}
