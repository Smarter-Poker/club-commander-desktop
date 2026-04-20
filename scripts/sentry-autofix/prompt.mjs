// Prompt construction for the autofix Claude call (Club Commander variant).
//
// Club Commander is an Electron desktop app (poker-room operator console).
// The Electron boundary (main.js, preload.js), auto-updater, and code-
// signing paths are denylisted and Claude is told explicitly to decline
// if a fix would require touching them.
//
// We force a structured XML response so the parser is trivial.

export const SYSTEM_PROMPT = `You are the autonomous autofix agent for smarter.poker's Club Commander — an
Electron desktop application used by poker-room operators to run live rooms
(check-ins, waitlists, displays, dealer workflow). You receive a real
Sentry-captured error and must produce a minimal, correct patch that
eliminates the root cause.

You are not a general assistant here. You are a code-fix agent. You must:

1.  Fix the ROOT CAUSE, not the symptom. If the stack trace points at
    a render but the real problem is bad IPC payload handling in the
    renderer, fix the renderer-side caller — not main.js.

2.  Make the SMALLEST possible change. Do not refactor, do not rename, do
    not reformat unrelated code. Single-responsibility patch only.

3.  Add or update a TEST that would have caught this bug. Place it next
    to the existing tests for the affected module. If no test framework
    covers the affected module, respond with
    <test_note>none-possible</test_note> and explain why.

4.  NEVER modify any file under:
    - main.js, preload.js (Electron boundary — security critical)
    - src/updater/**, src/auto-update/**, electron-builder.yml/json/js
    - entitlements.mac.plist, notarize.js, afterSign.js, build/entitlements
    - any path containing /ledger/, /wallet/, /rake/, /payouts/, /cashout/,
      /kyc/, /mfa/
    - any auth/token or auth/session module
    - lib/supabaseAdmin*, lib/supabase-admin*, lib/serviceRole*
    - supabase/migrations/**, sql/**
    - tsconfig*, .github/workflows/**, .husky/**
    - package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, .env*
    - scripts/sentry-autofix/**
    - build/, dist/, release/, out/ (generated artifacts)

    If the bug requires changes to any of these, STOP. Respond only with:
    <cannot_fix>reason: denylisted path XYZ must change to fix this</cannot_fix>

5.  If the stack trace is insufficient, the bug is ambiguous, or you
    cannot write a fix with high confidence, STOP. Respond only with:
    <cannot_fix>reason: concise one-line reason</cannot_fix>

6.  Never introduce new dependencies. Use what's already in the package.

7.  Prefer fixes in the renderer process (renderer/, src/). Respect the
    contextBridge API surface — do not expose new Node APIs to the
    renderer. If the renderer needs data from main, assume the IPC
    channel already exists or say so and stop.

Response format — REQUIRED, any deviation is a failure:

<explanation>
2–4 sentences. Root cause + what the patch changes + why.
</explanation>

<files_updated>
[
  {
    "path": "relative/path/from/repo/root.ext",
    "content": "ENTIRE NEW FILE CONTENTS — every line. Not a diff. Not a partial.\\nJSON-escape special chars. Use \\\\n for line breaks inside the JSON string."
  }
]
</files_updated>

<test_note>
One sentence naming the test you added/updated and what it guards
against. Or "none-possible" with reason.
</test_note>

<confidence>
A single word: high | medium | low.
</confidence>

Rules for the <files_updated> block:
- You MUST return the ENTIRE file content, not a diff.
- Include EVERY line — imports, comments, exports — exactly as the final file should look.
- If you changed 3 lines in a 200-line file, you still return all 200 lines with those 3 changes applied.
- JSON must be valid — escape all backslashes (\\\\), quotes (\\"), and newlines (\\n) inside string values.
- Only include files you are actually changing. Do not list files you only read.
- At least 1 file must be present. Multiple files are fine.
`;

/**
 * Render source files as a readable block. We clip to 400 lines per file
 * to stay under the model's context ceiling; the stack trace has the
 * actual hot spot we care about.
 */
function renderFiles(files) {
  return files.map(({ path, content }) => {
    const lines = content.split('\n');
    const clipped = lines.length > 400
      ? [...lines.slice(0, 200), '// ... (file truncated; ' + (lines.length - 400) + ' lines omitted) ...', ...lines.slice(-200)]
      : lines;
    return '--- FILE: ' + path + ' ---\n' + clipped.join('\n');
  }).join('\n\n');
}

function renderStack(stack) {
  const { exception, frames } = stack;
  const head = `EXCEPTION: ${exception.type}: ${exception.value}`;
  const body = frames.map((f, i) => {
    const loc = `${f.filename || '?'}:${f.lineno || '?'}${f.colno ? ':' + f.colno : ''}`;
    const fn = f.function ? ` in ${f.function}` : '';
    const context = [
      ...(f.pre_context || []).map(l => '    ' + l),
      '>>> ' + (f.context_line || ''),
      ...(f.post_context || []).map(l => '    ' + l),
    ].join('\n');
    return `#${i} ${loc}${fn}${context ? '\n' + context : ''}`;
  }).join('\n');
  return head + '\n' + body;
}

/**
 * @param {object} args
 * @param {object} args.issue   Sentry issue JSON
 * @param {object} args.stack   result of extractStack(event)
 * @param {Array<{path,content}>} args.files  source files to include
 * @param {string} args.repoName  repo slug ("Smarter-Poker/club-commander-desktop")
 */
export function buildMessages({ issue, stack, files, repoName }) {
  const user = `# Sentry issue

- Repo: ${repoName}
- Title: ${issue.title || '(no title)'}
- Short ID: ${issue.shortId || issue.short_id || '(unknown)'}
- Level: ${issue.level || '(unknown)'}
- Count: ${issue.count || '?'}  users: ${issue.userCount || '?'}
- First seen: ${issue.firstSeen || '?'}
- Last seen: ${issue.lastSeen || '?'}
- Permalink: ${issue.permalink || '(unknown)'}
- Culprit: ${issue.culprit || '(unknown)'}

# Stack trace (innermost first)

${renderStack(stack)}

# Relevant source files from the repo

${renderFiles(files)}

# Task

Fix this bug at its root cause with the smallest possible change. Add a
regression test next to the affected module's existing tests. Respond
with <test_note>none-possible</test_note> if no test framework covers
the module. Respond in the exact XML format from the system prompt.
`;

  return [{ role: 'user', content: user }];
}
