// Anthropic Messages API client — direct fetch, no SDK.
// Docs: https://docs.claude.com/en/api/messages

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Call Claude.
 * @param {object} opts
 * @param {string} opts.model          e.g. "claude-opus-4-6"
 * @param {string} opts.system         system prompt
 * @param {Array<{role,content}>} opts.messages
 * @param {number} [opts.maxTokens=8192]
 * @param {number} [opts.temperature=0]
 * @returns {Promise<{text:string, stopReason:string, usage:object, raw:object}>}
 */
export async function callClaude({ model, system, messages, maxTokens = 8192, temperature = 0 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 800)}`);
  }
  const json = await res.json();
  const text = (json.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return { text, stopReason: json.stop_reason, usage: json.usage, raw: json };
}
