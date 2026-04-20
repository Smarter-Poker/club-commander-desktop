// Parse Claude's XML-structured response and apply the patch.
//
// Contract v2 (2026-04-20): Claude returns WHOLE file contents inside
// <files_updated>[{path, content}, …]</files_updated>. We write each file
// atomically. This removes the whole class of "corrupt patch at line N"
// failures we hit with unified-diff output.
//
// On success: returns { applied:true, changedFiles:[…], explanation, testNote, confidence }.
// On cannot_fix: returns { applied:false, cannotFix:true, reason }.
// On bad output: throws — the runner will mark attempt as errored.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function extract(tag, text) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

export function parseClaudeResponse(text) {
  const cantFix = extract('cannot_fix', text);
  if (cantFix) return { applied: false, cannotFix: true, reason: cantFix };

  const explanation = extract('explanation', text);
  const filesBlock = extract('files_updated', text);
  const testNote = extract('test_note', text) || 'none-possible';
  const confidence = (extract('confidence', text) || 'low').toLowerCase();

  if (!explanation) throw new Error('Claude response missing <explanation>');
  if (!filesBlock) throw new Error('Claude response missing <files_updated>');

  let filesUpdated;
  try {
    filesUpdated = JSON.parse(filesBlock);
  } catch (err) {
    throw new Error(`<files_updated> is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(filesUpdated)) {
    throw new Error('<files_updated> must be a JSON array');
  }
  if (filesUpdated.length === 0) {
    throw new Error('<files_updated> is empty — Claude produced no changes');
  }
  for (const f of filesUpdated) {
    if (typeof f?.path !== 'string' || !f.path) {
      throw new Error(`<files_updated> entry missing 'path' string: ${JSON.stringify(f).slice(0, 200)}`);
    }
    if (typeof f?.content !== 'string') {
      throw new Error(`<files_updated> entry for ${f.path} missing 'content' string`);
    }
  }

  return {
    applied: false, cannotFix: false,
    explanation, filesUpdated, testNote, confidence,
    // Back-compat: also expose a synthetic 'patch' field for any caller that peeks.
    patch: '(structured file-replace, see filesUpdated)',
  };
}

/**
 * Write each file in filesUpdated under repoRoot. Refuses paths that escape
 * repoRoot or use absolute paths. Returns the list of written paths (relative).
 */
export function applyPatch(repoRoot, filesUpdatedOrDiff) {
  // Back-compat: old signature passed a diff string. New callers pass the array.
  let filesUpdated;
  if (Array.isArray(filesUpdatedOrDiff)) {
    filesUpdated = filesUpdatedOrDiff;
  } else if (typeof filesUpdatedOrDiff === 'string') {
    throw new Error('applyPatch now expects filesUpdated array, not a diff string. Update caller.');
  } else {
    throw new Error('applyPatch: invalid argument');
  }

  const absRoot = path.resolve(repoRoot);
  const written = [];

  for (const f of filesUpdated) {
    // Normalize and validate the path — must resolve inside repoRoot.
    const clean = f.path.replace(/^\.?\/+/, '').replace(/\\/g, '/');
    if (clean.startsWith('..') || clean.includes('\0') || path.isAbsolute(clean)) {
      throw new Error(`applyPatch refuses unsafe path: ${f.path}`);
    }
    const abs = path.resolve(absRoot, clean);
    if (!abs.startsWith(absRoot + path.sep) && abs !== absRoot) {
      throw new Error(`applyPatch: path escapes repo root: ${f.path}`);
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Preserve trailing-newline behavior: if original file exists and ends with \n,
    // ensure the new content does too. If Claude omits it, add.
    let content = f.content;
    if (fs.existsSync(abs)) {
      const orig = fs.readFileSync(abs, 'utf8');
      if (orig.endsWith('\n') && !content.endsWith('\n')) content += '\n';
    } else if (!content.endsWith('\n')) {
      content += '\n';
    }
    fs.writeFileSync(abs, content, 'utf8');
    written.push(clean);
  }

  // Verify git sees the expected set of changes (sanity check + source of truth
  // for the PR body). It's OK if the set is a subset — e.g., Claude wrote a file
  // identical to what's already there.
  const raw = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: absRoot, encoding: 'utf8',
  });
  const gitChanged = raw.split('\n').map(s => s.trim()).filter(Boolean);
  // Union so callers see both what Claude asked for AND what git noticed.
  const union = Array.from(new Set([...written, ...gitChanged]));
  return union;
}
