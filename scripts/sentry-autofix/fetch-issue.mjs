// Sentry REST API — fetch an issue and its latest event (stack trace).
//
// Resolver note: many CA errors come from reportError(err, 'ClassName.method')
// → Sentry records them with exception.value = "[ClassName.method] [object Object]"
// and frames pointing at src/utils/errorReporter.ts (the helper), not the real
// callsite. extractSymbolsFromText() pulls ClassName from the value/title so the
// run.mjs resolver's recursive basename fallback can still locate the real file.

const SENTRY_API = process.env.SENTRY_REGION_API || 'https://sentry.io/api/0';

async function sentryGet(path) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
  const res = await fetch(`${SENTRY_API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'smarter-poker-sentry-autofix/1.2' },
  });
  if (!res.ok) throw new Error(`Sentry GET ${path} → ${res.status}`);
  return res.json();
}

export async function fetchIssue(issueId) { return sentryGet(`/issues/${issueId}/`); }
export async function fetchLatestEvent(issueId) { return sentryGet(`/issues/${issueId}/events/latest/`); }

// Heuristic: Sentry's `in_app` is often null on minified Next.js client
// bundles. When unset, accept frames whose filename looks project-local
// and reject anything that looks like vendor / framework / runtime code,
// OR the reportError helper wrapper (which is almost always the top frame
// for reportError-instrumented errors and has no fix information).
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
  // reportError() / errorReporter / captureException wrappers — these are the
  // helpers themselves; the real callsite is up the stack via the context string.
  if (/\/(errorreporter|error-reporter|reporterror|report-error|captureexception)\.(ts|js|tsx|jsx|mjs|cjs)$/i.test(fn)) return false;
  if (f.in_app === true)  return true;
  if (f.in_app === false) return false;
  return /^(\.\.?\/|\/|src\/|pages\/|app\/|components\/|lib\/|hooks\/|utils\/|renderer\/|server\/)/.test(fn);
}

// Parse ClassName/ServiceName/HookName hints out of a Sentry message.
// Matches:
//   "[CreditService.getAgentInvoices] [object Object]"   → ["CreditService"]
//   "Error: [DynamicWallet._Realtime_channel_error]"     → ["DynamicWallet"]
//   "in MarketplacePage.useEffect"                        → ["MarketplacePage"]
// Returns unique identifiers, skips common noise ("Error", "TypeError", etc.).
const NOISE = new Set([
  'Error','TypeError','RangeError','SyntaxError','ReferenceError','URIError','EvalError',
  'Object','Function','Array','String','Number','Boolean','Promise','Map','Set',
  'HTTPError','NetworkError','AbortError','TimeoutError',
]);
export function extractSymbolsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  const add = (s) => {
    if (!s || s.length < 3 || NOISE.has(s)) return;
    if (!/^[A-Z][A-Za-z0-9_]+$/.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  // [ClassName.method] or [ClassName]
  for (const m of text.matchAll(/\[([A-Z][A-Za-z0-9_]+)(?:\.[A-Za-z_][A-Za-z0-9_]*)?[^\]]*\]/g)) add(m[1]);
  // "in ClassName" / "at ClassName"
  for (const m of text.matchAll(/\b(?:in|at)\s+([A-Z][A-Za-z0-9_]+)(?=\s|\.|\(|:|$)/g)) add(m[1]);
  // "ClassName.methodName" bare (last resort; only if nothing else found)
  if (out.length === 0) {
    for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]+)\.[a-z_][A-Za-z0-9_]*\b/g)) add(m[1]);
  }
  return out;
}

export function extractStack(event, issueTitle) {
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

  // Symbol-based hints — ALWAYS additive. Even when we have source_files from
  // frames, the class/service name extracted from the value often points at
  // the real file (the frame might be a wrapper). The resolver's recursive
  // basename-find handles these as bare identifiers.
  const symTexts = [
    first?.value || '',
    event?.metadata?.value || '',
    event?.metadata?.type || '',
    event?.culprit || '',
    issueTitle || event?.title || '',
  ];
  const symbolHints = [...new Set(symTexts.flatMap(extractSymbolsFromText))];
  for (const sym of symbolHints) {
    if (!source_files.includes(sym)) source_files.push(sym);
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
    symbol_hints: symbolHints,
  };
}
