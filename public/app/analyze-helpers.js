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

// Analyse entries saved without AI analysis and write the results back. Paced,
// best-effort (failures are skipped and retried on a later run). `cap` limits
// how many to process this pass (0 = all). Returns { done, failed, total }.
export async function healMissingEntries(api, { cap = 0, delay = 800, onProgress } = {}) {
  const all = await api.get('/api/entries?limit=365');
  const missing = all.filter(e => !e.first_person_summary && !e.ai_summary);
  const batch = cap ? missing.slice(0, cap) : missing;
  let done = 0, failed = 0;
  for (let i = 0; i < batch.length; i++) {
    if (onProgress) onProgress(i + 1, batch.length);
    try {
      const full = await api.get(`/api/entries/${batch[i].id}`);
      const content = (full.user_edited_content || full.cleaned_content || full.raw_transcript || '').trim();
      if (!content) continue;
      const a = await api.post('/api/ai/analyze', { content });
      await api.put(`/api/entries/${batch[i].id}`, analysisToPayload(a, { fillMood: full.mood_overall == null }));
      done++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, delay));
  }
  return { done, failed, total: missing.length, processed: batch.length };
}
