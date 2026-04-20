// Parse Claude's XML-structured response and apply the patch.
//
// On success: returns { applied:true, changedFiles:[…], explanation, testNote, confidence }.
// On cannot_fix: returns { applied:false, cannotFix:true, reason }.
// On bad output: throws — the runner will mark attempt as errored.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function extract(tag, text) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

export function parseClaudeResponse(text) {
  const cantFix = extract('cannot_fix', text);
  if (cantFix) return { applied: false, cannotFix: true, reason: cantFix };

  const explanation = extract('explanation', text);
  const patch = extract('patch', text);
  const testNote = extract('test_note', text) || 'none-possible';
  const confidence = (extract('confidence', text) || 'low').toLowerCase();

  if (!explanation) throw new Error('Claude response missing <explanation>');
  if (!patch) throw new Error('Claude response missing <patch>');

  return { applied: false, cannotFix: false, explanation, patch, testNote, confidence };
}

/**
 * Apply the unified diff in repoRoot. Returns list of changed paths (as git
 * reports them). Leaves changes as unstaged edits; caller decides when to
 * `git add` + commit.
 */
export function applyPatch(repoRoot, diff) {
  const tmp = path.join(os.tmpdir(), `autofix-${Date.now()}.patch`);
  fs.writeFileSync(tmp, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
  try {
    // --3way allows tolerant apply when hunks fuzz, -p1 matches "a/…" prefixes.
    execFileSync('git', ['apply', '--whitespace=nowarn', '-p1', tmp], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    // Retry once with --3way.
    try {
      execFileSync('git', ['apply', '--3way', '--whitespace=nowarn', '-p1', tmp], {
        cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err2) {
      const stderr2 = err2.stderr?.toString() || err2.message;
      throw new Error(`git apply failed:\n--- first try ---\n${stderr}\n--- 3way retry ---\n${stderr2}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  const raw = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}
