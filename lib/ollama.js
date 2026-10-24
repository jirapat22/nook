// Local AI backup: Ollama running natively on the home Mac (see the
// mac-server README, "Local AI"). Groq stays the main AI because it is ~50x
// faster; this only steps in when Groq fails (rate limit, outage, or a model
// being retired like on 2026-08-16, which took every AI feature down).
//
// Off unless OLLAMA_URL is set, so running Nook anywhere else (Railway, a
// laptop) behaves exactly as before.

const { groqChatRetrying } = require('./groq');

const OLLAMA_URL = process.env.OLLAMA_URL || '';            // e.g. http://host.docker.internal:11434
const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';

// Measured on the M1 mini: a full entry analysis takes ~100s (≈2k prompt
// tokens in, ≈1.1k out at ~13 tokens/s). 5 minutes leaves room for a long
// voice entry, or for waiting behind another request (Ollama runs one at a time).
const LOCAL_TIMEOUT_MS = 5 * 60_000;

function localAiEnabled() {
  return Boolean(OLLAMA_URL);
}

// One chat completion against the local model, returning parsed JSON (same
// contract as groqChat, so callers can swap one for the other).
async function ollamaChat(messages, { temperature = 0.3, max_tokens = 2048 } = {}) {
  if (!OLLAMA_URL) throw new Error('Local AI not configured (OLLAMA_URL unset)');
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_MODEL,
      messages,
      stream: false,
      format: 'json',   // forces valid JSON output, like Groq's json_object mode
      think: false,     // qwen3.5 can "think" first; that would double the wait for no gain here
      options: {
        temperature,
        num_predict: max_tokens,
        // Ollama's default 4k context would silently cut off the analyze
        // prompt (~2k tokens) plus a long entry and the enrichment context.
        num_ctx: 8192,
      },
    }),
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // done_reason 'length' = ran out of num_predict mid-JSON, same as Groq's truncation.
  if (data.done_reason === 'length') {
    const err = new Error(`Local AI response truncated at ${max_tokens} tokens`);
    err.truncated = true;
    throw err;
  }
  try {
    return JSON.parse(data.message?.content || '');
  } catch {
    throw new Error('Local AI returned malformed JSON');
  }
}

// For background work with no one waiting on it: Groq first, local AI if Groq
// is unavailable. With no Groq key at all, local AI does the job alone.
async function chatWithLocalFallback(apiKey, messages, opts = {}) {
  if (apiKey) {
    try {
      return await groqChatRetrying(apiKey, messages, opts);
    } catch (err) {
      if (!localAiEnabled()) throw err;
      console.warn(`[local-ai] Groq failed (${err.status || '?'}), using local AI: ${err.message}`);
    }
  }
  return ollamaChat(messages, opts);
}

module.exports = { LOCAL_MODEL, localAiEnabled, ollamaChat, chatWithLocalFallback };
