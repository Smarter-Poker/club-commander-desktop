// Sentry REST API — fetch an issue and its latest event (stack trace).
// Docs: https://docs.sentry.io/api/events/

const SENTRY_API = process.env.SENTRY_REGION_API || 'https://sentry.io/api/0';

async function sentryGet(path) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
  const res = await fetch(`${SENTRY_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'smarter-poker-sentry-autofix/1.0',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sentry GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function fetchIssue(issueId) {
  return sentryGet(`/issues/${issueId}/`);
}

export async function fetchLatestEvent(issueId) {
  return sentryGet(`/issues/${issueId}/events/latest/`);
}

/**
 * Extract a normalised stack trace + source file list from a Sentry event.
 * @param {object} event Sentry event JSON
 * @returns {{frames:Array<{filename,function,lineno,colno,in_app,context_line,pre_context,post_context}>, exception:{type,value}, source_files:string[]}}
 */
export function extractStack(event) {
  const exception = event?.entries?.find(e => e.type === 'exception')?.data;
  const thread = event?.entries?.find(e => e.type === 'threads')?.data;
  const values = exception?.values || thread?.values || [];
  const first = values[0];
  const stacktrace = first?.stacktrace || first?.rawStacktrace;
  const frames = (stacktrace?.frames || [])
    .slice(-25) // innermost 25
    .reverse(); // innermost first
  const source_files = [...new Set(
    frames.filter(f => f.in_app).map(f => f.filename).filter(Boolean)
  )];
  return {
    exception: { type: first?.type || '', value: first?.value || '' },
    frames: frames.map(f => ({
      filename: f.filename,
      function: f.function,
      lineno: f.lineno,
      colno: f.colno,
      in_app: f.in_app,
      context_line: f.context_line,
      pre_context: f.pre_context,
      post_context: f.post_context,
    })),
    source_files,
  };
}
