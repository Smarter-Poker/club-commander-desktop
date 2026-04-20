// Entry point for the GH Action step. Orchestrates the full loop:
//
//   1. Load Sentry issue + latest event.
//   2. Extract stack + in_app source files.
//   3. Read those files from the checked-out repo.
//   4. Call Claude with the structured prompt.
//   5. Parse response; either <cannot_fix> or apply <patch>.
//   6. Check paths against denylist. If any hit, open blocked PR.
//   7. Open PR with labels, link Sentry issue.
//   8. Update Supabase autofix_attempts row.
//
// All failures propagate — the workflow's post-step marks the attempt
// errored if this node exits non-zero.

import fs from 'node:fs';
import path from 'node:path';
import { fetchIssue, fetchLatestEvent, extractStack } from './fetch-issue.mjs';
import { callClaude } from './claude.mjs';
import { buildMessages, SYSTEM_PROMPT } from './prompt.mjs';
import { parseClaudeResponse, applyPatch } from './patch.mjs';
import { assessPaths, DENYLIST } from './policy.mjs';
import { openAutofixPR } from './pr.mjs';
import { createClient } from '@supabase/supabase-js';

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
  // The checkout action lands us at GITHUB_WORKSPACE; the runner script
  // itself lives at scripts/sentry-autofix/ — cwd might be either.
  const here = process.cwd();
  const up = path.resolve(here, '..', '..');
  if (fs.existsSync(path.join(up, '.git'))) return up;
  return process.env.GITHUB_WORKSPACE || here;
}

function resolveFiles(root, filenames) {
  const out = [];
  const SUBDIRS = ["", "src", "renderer", "renderer/src", "server/src", "electron", "app"];
  const EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  const INDEX_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
  const seen = new Set();
  for (const f of filenames) {
    if (!f) continue;
    // Strip framework / webpack prefixes Sentry emits.
    let clean = f
      .replace(/^webpack-internal:\/\/\//, '')
      .replace(/^webpack:\/\//, '')
      .replace(/^\(app-pages\)\//, '')
      .replace(/^app:\/\/\//, '')
      .replace(/^\/+/, '')
      .replace(/^(\.\.?\/)+/, '')
      .split('?')[0];
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const hasExt = /\.[a-z0-9]+$/i.test(clean);
    const base = hasExt ? clean.replace(/\.[a-z0-9]+$/i, '') : clean;
    const candidates = [];
    for (const sub of SUBDIRS) {
      for (const ext of EXTS) {
        if (ext === '' && !hasExt) continue;
        candidates.push(path.join(root, sub, ext === '' ? clean : base + ext));
      }
      // `./foo` → `./foo/index.ts` etc.
      for (const ext of INDEX_EXTS) {
        candidates.push(path.join(root, sub, base, 'index' + ext));
      }
    }
    let picked = null;
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.size < 200_000) { picked = p; break; }
      } catch {}
    }
    if (picked) {
      out.push({ path: path.relative(root, picked), content: fs.readFileSync(picked, 'utf8') });
    }
  }
  return out;
}

async function main() {
  const issueId = process.env.SENTRY_ISSUE_ID;
  const attemptId = process.env.AUTOFIX_ATTEMPT_ID || '';
  const mode = process.env.AUTOFIX_MODE || 'dry-run';
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
  const root = repoRoot();
  const repoEnv = process.env.GITHUB_REPOSITORY || 'Smarter-Poker/Smarter-Poker-Club-Arena';
  const [owner, repo] = repoEnv.split('/');
  const baseBranch = process.env.GITHUB_REF_NAME || 'main';

  if (!issueId) { log({ level: 'error', msg: 'SENTRY_ISSUE_ID not set' }); process.exit(2); }

  log({ level: 'info', msg: 'autofix start', issueId, attemptId, mode, model, root, repo: repoEnv });

  await updateAttempt(attemptId, { status: 'running', run_id: process.env.GITHUB_RUN_ID || null });

  const issue = await fetchIssue(issueId);
  const event = await fetchLatestEvent(issueId);
  const stack = extractStack(event);
  log({ level: 'info', msg: 'issue fetched', short_id: issue.shortId, culprit: issue.culprit, frames: stack.frames.length, files: stack.source_files });

  // Pre-gate: does the stack point at any denylisted file?
  const prePaths = stack.source_files.map(f => f.replace(/^\.?\//, ''));
  const preAssess = assessPaths(prePaths);
  if (!preAssess.ok) {
    log({ level: 'info', msg: 'issue originates in denylist — opening diagnostic PR', denied: preAssess.denied });
  }

  const files = resolveFiles(root, stack.source_files).slice(0, 8);
  if (files.length === 0) {
    log({ level: 'warn', msg: 'no in-app source files resolved — Claude cannot propose a diff' });
    await updateAttempt(attemptId, { status: 'rejected', error_message: 'no in-app source files to show Claude' });
    process.exit(0);
  }

  const messages = buildMessages({
    issue, stack, files,
    repoName: repoEnv,
  });
  log({ level: 'info', msg: 'calling Claude', model, files: files.map(f => f.path) });

  const t0 = Date.now();
  const reply = await callClaude({ model, system: SYSTEM_PROMPT, messages, maxTokens: 8192, temperature: 0 });
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

  // Apply patch.
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
    // Don't push; just record.
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

main().catch(err => {
  log({ level: 'error', msg: 'fatal', err: String(err?.stack || err).slice(0, 1500) });
  process.exit(1);
});
