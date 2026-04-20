// PR orchestration via the GitHub REST API.
//
// Uses GH_TOKEN from env. Creates a branch from current HEAD, commits
// the staged changes, pushes, and opens a PR with Sentry-linked body
// + label(s).

import { execFileSync } from 'node:child_process';

function gh(path, init = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'smarter-poker-sentry-autofix/1.0',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

export async function ensureLabel({ owner, repo, name, color, description }) {
  const res = await gh(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
  if (res.status === 200) return;
  if (res.status === 404) {
    const r2 = await gh(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name, color, description }),
    });
    if (!r2.ok) {
      const t = await r2.text();
      console.warn(`label create "${name}" failed: ${r2.status} ${t.slice(0, 200)}`);
    }
  }
}

export async function openAutofixPR({
  owner, repo, baseBranch, issue, parsed, attemptId, mode, repoRoot,
}) {
  const short = issue.shortId || issue.short_id || `ISS-${issue.id}`;
  const slug = short.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const branch = `sentry-autofix/${slug}-${Date.now().toString(36)}`;

  // Configure git identity.
  git(['config', 'user.email', 'autofix@smarter.poker'], { cwd: repoRoot });
  git(['config', 'user.name', 'Smarter Poker Autofix'], { cwd: repoRoot });

  git(['checkout', '-b', branch], { cwd: repoRoot });
  git(['add', '-A'], { cwd: repoRoot });

  const commitTitle = `autofix(sentry): ${issue.title || short}`.slice(0, 72);
  const commitBody = [
    `Sentry: ${issue.permalink || `https://${process.env.SENTRY_ORG_SLUG || 'smarter-poker'}.sentry.io/issues/${issue.id}/`}`,
    `Short ID: ${short}`,
    `Attempt ID: ${attemptId || '(manual)'}`,
    '',
    'Root-cause explanation:',
    parsed.explanation,
    '',
    `Test: ${parsed.testNote}`,
    `Confidence: ${parsed.confidence}`,
    `Mode: ${mode}`,
  ].join('\n');

  git(['commit', '-m', commitTitle, '-m', commitBody, '--no-verify'], { cwd: repoRoot });
  git(['push', 'origin', branch], { cwd: repoRoot });

  const labels = ['sentry-autofix'];
  if (mode === 'dry-run') labels.push('sentry-autofix-draft');
  if (parsed.cannotFix) labels.push('sentry-autofix-blocked');
  if (parsed.confidence === 'low') labels.push('sentry-autofix-low-confidence');

  await Promise.all([
    ensureLabel({ owner, repo, name: 'sentry-autofix', color: '1f883d', description: 'PR opened by the Sentry autofix loop' }),
    ensureLabel({ owner, repo, name: 'sentry-autofix-draft', color: 'f0ad4e', description: 'Dry-run mode — human must review' }),
    ensureLabel({ owner, repo, name: 'sentry-autofix-blocked', color: 'd73a4a', description: 'Autofix blocked by denylist or cannot-fix' }),
    ensureLabel({ owner, repo, name: 'sentry-autofix-low-confidence', color: 'fbca04', description: 'Claude marked confidence=low' }),
  ]);

  const prBody = [
    `Automated fix for Sentry issue [${short}](${issue.permalink || ''}).`,
    '',
    '## Root cause',
    parsed.explanation,
    '',
    '## Test',
    parsed.testNote,
    '',
    '## Confidence',
    parsed.confidence,
    '',
    `## Attempt`,
    `\`${attemptId || '(manual run)'}\`  •  mode: \`${mode}\``,
    '',
    '---',
    '_Opened by Smarter Poker Autofix. Gated by `infra/monitoring` and `build-safety-gate` CI. Do not merge without a green build._',
  ].join('\n');

  const prRes = await gh(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: commitTitle,
      head: branch,
      base: baseBranch,
      body: prBody,
      draft: mode === 'dry-run',
      maintainer_can_modify: true,
    }),
  });
  if (!prRes.ok) {
    const t = await prRes.text();
    throw new Error(`pulls create failed: ${prRes.status} ${t.slice(0, 500)}`);
  }
  const pr = await prRes.json();

  // Apply labels (best-effort; don't fail the fix just because the label step failed).
  const labRes = await gh(`/repos/${owner}/${repo}/issues/${pr.number}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
  if (!labRes.ok) {
    console.warn(`label apply failed: ${labRes.status}`);
  }

  return { url: pr.html_url, number: pr.number, branch, labels };
}
