// Anthropic API client for the autofix runner.
//
// Hardening (Phase 5.2.0 bug-hunt):
//   * 90s AbortController timeout (previously: no timeout — a hung connection
//     could silently consume the whole GH Actions 15-min budget).
//   * Retry with jittered exponential backoff on 429 + 5xx. 3 tries.
//     4xx != 429 propagates immediately (bug in request, no point retrying).

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;
const TIMEOUT_MS = 90_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jitteredBackoff(attempt) {
  const exp = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * (exp / 2));
  return exp + jitter;
}

async function postOnce({ model, system, messages, maxTokens, temperature, signal }) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, system, messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

export async function callClaude({ model, system, messages, maxTokens = 8192, temperature = 0 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error(`claude-timeout-${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    try {
      const { status, text } = await postOnce({ model, system, messages, maxTokens, temperature, signal: ctrl.signal });
      clearTimeout(t);
      if (status === 200) {
        const body = JSON.parse(text);
        const content = (body.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        return {
          text: content,
          stopReason: body.stop_reason,
          usage: body.usage,
          raw: body,
        };
      }
      // 429 or 5xx → retry. Everything else: fail fast.
      if (status === 429 || status >= 500) {
        lastErr = new Error(`Anthropic API ${status}: ${text.slice(0, 500)}`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(jitteredBackoff(attempt));
          continue;
        }
      }
      throw new Error(`Anthropic API ${status}: ${text.slice(0, 800)}`);
    } catch (err) {
      clearTimeout(t);
      // AbortError / network drop → retry if we have tries left.
      const isTransient = err?.name === 'AbortError' || /timeout|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(String(err));
      if (isTransient && attempt < MAX_RETRIES - 1) {
        lastErr = err;
        await sleep(jitteredBackoff(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Anthropic API: exhausted retries');
}
