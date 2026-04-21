// Opens the PR for an accepted autofix. Draft in dry-run mode.
// Labels: sentry-autofix (always) + sentry-autofix-draft (dry-run) +
//         sentry-autofix-low-confidence (confidence=low).
// Hardening (bug-hunt): `git push` retries on transient network failures.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function sh(args, opts) { return execFileSync(args[0], args.slice(1), { stdio: 'inherit', ...opts }); }
function shOut(args, opts) { return execFileSync(args[0], args.slice(1), { encoding: 'utf8', ...opts }).trim(); }

function sleepSync(ms) {
  const b = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(b, 0, 0, ms);
}

// Retry `git push origin <branch>` up to 3 times on transient failures.
function gitPushWithRetry(branch, cwd) {
  const attempts = 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync('git', ['push', '--set-upstream', 'origin', branch], { cwd, encoding: 'utf8' });
    if (r.status === 0) return;
    const combined = (r.stdout || '') + (r.stderr || '');
    lastErr = new Error(`git push failed (status ${r.status}): ${combined.slice(0, 800)}`);
    // Only retry on signals that look transient.
    const isTransient = /rpc failed|unexpected disconnect|SSL|TLS|connection (reset|timed out|closed)|502|503|504|could not resolve host/i.test(combined);
    if (!isTransient || i === attempts - 1) throw lastErr;
    sleepSync(2000 * (i + 1));
  }
  throw lastErr;
}

async function ghApi(owner, repo, path, { method = 'GET', body } = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN not set');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 422) throw new Error(`GH ${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ensureLabel(owner, repo, name, color, desc) {
  const { status } = await ghApi(owner, repo, `/labels/${encodeURIComponent(name)}`);
  if (status === 200) return;
  await ghApi(owner, repo, `/labels`, { method: 'POST', body: { name, color, description: desc } });
}

export async function openAutofixPR({ owner, repo, baseBranch, issue, parsed, attemptId, mode, repoRoot }) {
  const slug = (issue.shortId || issue.id || 'autofix').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const branch = `sentry-autofix/${slug}-${Date.now().toString(36)}`;
  execFileSync('git', ['config', 'user.email', 'autofix@smarter.poker'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name',  'Smarter Poker Autofix'],  { cwd: repoRoot });
  execFileSync('git', ['checkout', '-b', branch], { cwd: repoRoot });
  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  // --no-verify skips local hooks; CI runs the full gate on the PR anyway.
  execFileSync('git', ['commit', '-m', `fix(autofix): ${issue.shortId || issue.id} — ${(issue.title || '').slice(0, 80)}`, '--no-verify'], { cwd: repoRoot });
  gitPushWithRetry(branch, repoRoot);

  await ensureLabel(owner, repo, 'sentry-autofix',            'b60205', 'Opened by Sentry autofix pipeline');
  await ensureLabel(owner, repo, 'sentry-autofix-draft',      'fbca04', 'Dry-run draft PR — human merge required');
  await ensureLabel(owner, repo, 'sentry-autofix-blocked',    'd73a4a', 'Autofix declined — diagnostic only');
  await ensureLabel(owner, repo, 'sentry-autofix-low-confidence', 'e99695', 'Autofix produced a low-confidence patch');

  const labels = ['sentry-autofix'];
  if (mode === 'dry-run')            labels.push('sentry-autofix-draft');
  if (parsed.confidence === 'low')   labels.push('sentry-autofix-low-confidence');
  if (parsed.cannotFix)              labels.push('sentry-autofix-blocked');

  const body = [
    `**Sentry issue:** [${issue.shortId || issue.id}](${issue.permalink || `https://sentry.io/issues/${issue.id}/`})`,
    `**Autofix attempt:** \`${attemptId || '(manual)'}\``,
    `**Mode:** ${mode}  —  **Confidence:** ${parsed.confidence || 'n/a'}`,
    '',
    '### Explanation',
    parsed.explanation || '(no explanation)',
    '',
    '### Test note',
    parsed.testNote || '(none)',
    '',
    '---',
    '_This PR was opened automatically by the Sentry → Claude autofix pipeline._',
    '_Please review carefully before merging._',
  ].join('\n');

  const { body: pr } = await ghApi(owner, repo, `/pulls`, {
    method: 'POST',
    body: {
      title: `fix(autofix): ${issue.shortId || issue.id} — ${(issue.title || '').slice(0, 80)}`,
      head: branch, base: baseBranch,
      body,
      draft: mode === 'dry-run',
      maintainer_can_modify: true,
    },
  });
  if (pr && pr.number) {
    await ghApi(owner, repo, `/issues/${pr.number}/labels`, { method: 'POST', body: { labels } });
  }
  return {
    url: pr?.html_url,
    number: pr?.number,
    branch,
    labels,
  };
}
