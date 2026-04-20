// Sentry REST API — fetch an issue and its latest event (stack trace).

const SENTRY_API = process.env.SENTRY_REGION_API || 'https://sentry.io/api/0';

async function sentryGet(path) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
  const res = await fetch(`${SENTRY_API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'smarter-poker-sentry-autofix/1.1' },
  });
  if (!res.ok) throw new Error(`Sentry GET ${path} → ${res.status}`);
  return res.json();
}

export async function fetchIssue(issueId) { return sentryGet(`/issues/${issueId}/`); }
export async function fetchLatestEvent(issueId) { return sentryGet(`/issues/${issueId}/events/latest/`); }

// Heuristic: Sentry's `in_app` is often null on minified Next.js client
// bundles. When unset, accept frames whose filename looks project-local
// and reject anything that looks like vendor / framework / runtime code.
export function probablyInApp(f) {
  const fn = f.filename || '';
  if (!fn) return false;
  const low = fn.toLowerCase();
  if (low.includes('node_modules/')) return false;
  if (low.includes('/_next/static/')) return false;
  if (low.includes('next/dist/')) return false;
  if (low.includes('webpack-internal')) return false;
  if (low.includes('@sentry/')) return false;
  if (low.includes('sentry-')) return false;
  if (low.startsWith('app:///_next/')) return false;
  if (f.in_app === true)  return true;
  if (f.in_app === false) return false;
  return /^(\.\.?\/|\/|src\/|pages\/|app\/|components\/|lib\/|hooks\/|utils\/|renderer\/|server\/)/.test(fn);
}

export function extractStack(event) {
  const exception = event?.entries?.find(e => e.type === 'exception')?.data;
  const thread    = event?.entries?.find(e => e.type === 'threads')?.data;
  const values = exception?.values || thread?.values || [];
  const first = values[0];
  const stacktrace = first?.stacktrace || first?.rawStacktrace;
  const frames = (stacktrace?.frames || []).slice(-25).reverse();

  let source_files = [...new Set(
    frames.filter(probablyInApp).map(f => f.filename).filter(Boolean)
  )];

  // Fallbacks — use Sentry's declared metadata.filename and the culprit URL.
  if (source_files.length === 0) {
    const metaFile = event?.metadata?.filename;
    if (metaFile && !metaFile.includes('node_modules/')) source_files.push(metaFile);
  }
  if (source_files.length === 0) {
    const culprit = event?.culprit;
    if (culprit && culprit.startsWith('/')) {
      source_files.push('pages' + culprit);
    }
  }

  return {
    exception: { type: first?.type || '', value: first?.value || '' },
    frames: frames.map(f => ({
      filename: f.filename, function: f.function,
      lineno: f.lineno, colno: f.colno, in_app: f.in_app,
      context_line: f.context_line,
      pre_context: f.pre_context, post_context: f.post_context,
    })),
    source_files,
  };
}
