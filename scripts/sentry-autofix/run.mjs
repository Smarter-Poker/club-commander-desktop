// Entry point for the GH Action step. Orchestrates the full loop:
//
//   1. Load Sentry issue + latest event.
//   2. Extract stack + in_app source files + symbol hints from title/message.
//   3. Read those files from the checked-out repo (resolve.mjs handles
//      the SUBDIRS × EXTS grid + recursive basename fallback for
//      reportError-captured errors where the true callsite isn't in the
//      stack).
//   4. Call Claude with the structured prompt.
//   5. Parse response; either <cannot_fix> or apply <files_updated>.
//   6. Check paths against denylist. If any hit, open blocked PR.
//   7. Open PR with labels, link Sentry issue.
//   8. Update Supabase autofix_attempts row.
//
// All failures propagate — the workflow's post-step also marks the
// attempt errored if this node exits non-zero, and the fatal catch
// below writes an `errored` status so the ledger never gets stuck.

import fs from 'node:fs';
import path from 'node:path';
import { fetchIssue, fetchLatestEvent, extractStack } from './fetch-issue.mjs';
import { resolveFiles } from './resolve.mjs';
import { callClaude } from './claude.mjs';
import { buildMessages, SYSTEM_PROMPT } from './prompt.mjs';
import { parseClaudeResponse, applyPatch } from './patch.mjs';
import { assessPaths, DENYLIST } from './policy.mjs';
import { openAutofixPR } from './pr.mjs';
import { createClient } from '@supabase/supabase-js';

// Commander is an Electron app: main process under electron/, renderer
// under renderer/src/, shared server code under server/src/. Keep SUBDIRS
// small enough that pass-1 is fast, then let findByBasenameRecursive
// (pass-2 in resolveFiles) handle anything deeper.
const SUBDIRS = [
  '',
  'src',
  'renderer',
  'renderer/src',
  'renderer/src/components',
  'renderer/src/pages',
  'renderer/src/hooks',
  'renderer/src/utils',
  'renderer/src/lib',
  'renderer/src/store',
  'electron',
  'server/src',
  'app',
];

function log(o) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...o })); }

function sb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function updateAttempt(attemptId, fields) {
  if (!attemptId) return;
  const s = sb(); if (!s) return;
  const { error } = await s.from('autofix_attempts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', attemptId);
  if (error) log({ level: 'warn', msg: 'updateAttempt failed', err: error.message });
}

function repoRoot() {
  const here = process.cwd();
  const up = path.resolve(here, '..', '..');
  if (fs.existsSync(path.join(up, '.git'))) return up;
  return process.env.GITHUB_WORKSPACE || here;
}

async function main() {
  const issueId = process.env.SENTRY_ISSUE_ID;
  const attemptId = process.env.AUTOFIX_ATTEMPT_ID || '';
  const mode = process.env.AUTOFIX_MODE || 'dry-run';
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const root = repoRoot();
  const repoEnv = process.env.GITHUB_REPOSITORY || 'Smarter-Poker/club-commander-desktop';
  const [owner, repo] = repoEnv.split('/');
  const baseBranch = process.env.GITHUB_REF_NAME || 'main';

  if (!issueId) { log({ level: 'error', msg: 'SENTRY_ISSUE_ID not set' }); process.exit(2); }

  log({ level: 'info', msg: 'autofix start', issueId, attemptId, mode, model, root, repo: repoEnv });

  await updateAttempt(attemptId, { status: 'running', run_id: process.env.GITHUB_RUN_ID || null });

  const issue = await fetchIssue(issueId);
  const event = await fetchLatestEvent(issueId);
  // Pass issue.title so extractStack can pull symbol hints from the
  // message even when every in-app frame is the errorReporter wrapper.
  const stack = extractStack(event, issue.title);
  log({
    level: 'info',
    msg: 'issue fetched',
    short_id: issue.shortId,
    culprit: issue.culprit,
    frames: stack.frames.length,
    files: stack.source_files,
    symbol_hints: stack.symbol_hints,
  });

  // Pre-gate: does the stack point at any denylisted file?
  const prePaths = stack.source_files.map(f => f.replace(/^\.?\//, ''));
  const preAssess = assessPaths(prePaths);
  if (!preAssess.ok) {
    log({ level: 'info', msg: 'issue originates in denylist — opening diagnostic PR', denied: preAssess.denied });
  }

  const files = resolveFiles(root, stack.source_files, SUBDIRS).slice(0, 3);
  if (files.length === 0) {
    log({
      level: 'warn',
      msg: 'no in-app source files resolved — Claude cannot propose a diff',
      source_files: stack.source_files,
      symbol_hints: stack.symbol_hints,
    });
    await updateAttempt(attemptId, { status: 'rejected', error_message: 'no in-app source files to show Claude' });
    process.exit(0);
  }

  const messages = buildMessages({
    issue, stack, files,
    repoName: repoEnv,
  });
  log({ level: 'info', msg: 'calling Claude', model, files: files.map(f => f.path) });

  const t0 = Date.now();
  const reply = await callClaude({ model, system: SYSTEM_PROMPT, messages, maxTokens: 3072, temperature: 0 });
  log({ level: 'info', msg: 'Claude responded', elapsed_ms: Date.now() - t0, stop: reply.stopReason, tokens_in: reply.usage?.input_tokens, tokens_out: reply.usage?.output_tokens });

  let parsed;
  try { parsed = parseClaudeResponse(reply.text); }
  catch (err) {
    log({ level: 'error', msg: 'parse failed', err: String(err), text_head: reply.text.slice(0, 500) });
    await updateAttempt(attemptId, { status: 'errored', error_message: `parse: ${err.message}`.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    process.exit(3);
  }

  if (parsed.cannotFix) {
    log({ level: 'info', msg: 'Claude declined', reason: parsed.reason });
    await updateAttempt(attemptId, { status: 'rejected', error_message: parsed.reason.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    return;
  }

  // Apply patch (structured files_updated — v2 contract).
  let changed;
  try { changed = applyPatch(root, parsed.filesUpdated); }
  catch (err) {
    log({ level: 'error', msg: 'apply failed', err: String(err).slice(0, 500) });
    await updateAttempt(attemptId, { status: 'errored', error_message: `apply: ${err.message}`.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    process.exit(4);
  }
  log({ level: 'info', msg: 'patch applied', files: changed });

  // Post-apply denylist check — belt + suspenders.
  const postAssess = assessPaths(changed);
  if (!postAssess.ok) {
    log({ level: 'warn', msg: 'post-apply denylist hit — aborting', denied: postAssess.denied });
    await updateAttempt(attemptId, { status: 'rejected', error_message: `denylisted paths: ${postAssess.denied.join(',')}`.slice(0, 500), claude_tokens_in: reply.usage?.input_tokens, claude_tokens_out: reply.usage?.output_tokens });
    process.exit(0);
  }

  // Open PR (draft in dry-run).
  const pr = await openAutofixPR({
    owner, repo, baseBranch, issue,
    parsed, attemptId, mode, repoRoot: root,
  });
  log({ level: 'info', msg: 'PR opened', url: pr.url, number: pr.number, labels: pr.labels });

  await updateAttempt(attemptId, {
    status: 'pr_opened',
    fix_branch: pr.branch,
    fix_pr_url: pr.url,
    fix_pr_number: pr.number,
    claude_tokens_in: reply.usage?.input_tokens || null,
    claude_tokens_out: reply.usage?.output_tokens || null,
    claude_confidence: parsed.confidence,
    changed_files: changed,
  });
}

main().catch(async err => {
  const msg = String(err?.stack || err).slice(0, 1500);
  log({ level: 'error', msg: 'fatal', err: msg });
  try {
    const attemptId = process.env.AUTOFIX_ATTEMPT_ID || '';
    if (attemptId) {
      await updateAttempt(attemptId, {
        status: 'errored',
        error_message: `fatal: ${msg.slice(0, 400)}`,
      });
    }
  } catch (_e) { /* can't do more — workflow failure step will also write errored */ }
  process.exit(1);
});
