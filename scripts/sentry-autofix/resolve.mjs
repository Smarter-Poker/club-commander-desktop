// File resolver: map Sentry-emitted filenames (often normalized, sometimes
// bare class hints from fetch-issue.mjs's symbol extractor) to real repo paths.
//
// Strategy:
//   1. Strip common framework prefixes (webpack-internal://, app:///, leading slashes).
//   2. Try SUBDIRS × EXTS — exact placement for the cleaned filename.
//   3. If no hit, recursively walk the repo for files whose basename matches.
//      This handles (a) symbol hints like "CreditService" and (b) files nested
//      deeper than any SUBDIRS entry (e.g. src/components/wallet/DynamicWallet.tsx).
//
// Exported for unit testing.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WANTED_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  'test-results', '__tests__', '__mocks__', 'e2e', '.cache', '.vercel',
  '.turbo', 'storybook-static', 'public',
]);

export function cleanFilename(f) {
  if (!f) return '';
  return String(f)
    .replace(/^webpack-internal:\/\/\//, '')
    .replace(/^webpack:\/\//, '')
    .replace(/^\(app-pages\)\//, '')
    .replace(/^app:\/\/\//, '')
    .replace(/^\/+/, '')
    .replace(/^(\.\.?\/)+/, '')
    .split('?')[0];
}

// Recursively find files whose basename (without extension) matches `needle`.
// Stops after `maxHits` and limits depth to guard runaway walks.
export function findByBasenameRecursive(root, needle, { maxHits = 3, maxDepth = 10, maxSize = 500_000 } = {}) {
  if (!root || !needle) return [];
  // Strip path prefix + extension from whatever we were handed.
  const base = String(needle).split('/').pop().split('?')[0];
  const noExt = base.replace(/\.[A-Za-z0-9]+$/, '');
  if (!noExt || noExt.length < 3) return []; // too-short → avoid noise matches
  // Only attempt if needle looks like a valid identifier or kebab-case filename.
  if (!/^[A-Za-z][A-Za-z0-9_\-]*$/.test(noExt)) return [];
  const hits = [];
  function walk(dir, depth) {
    if (hits.length >= maxHits || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= maxHits) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!DEFAULT_WANTED_EXTS.includes(ext)) continue;
        const fileBase = e.name.slice(0, -ext.length);
        if (fileBase === noExt) {
          const full = path.join(dir, e.name);
          try {
            const stat = fs.statSync(full);
            if (stat.size <= maxSize) hits.push(full);
          } catch {}
        }
      }
    }
  }
  walk(root, 0);
  return hits;
}

// Build candidate paths for a cleaned filename, trying SUBDIRS × EXTS.
// Returns array of absolute paths — caller picks the first that statSync.isFile.
export function buildCandidates(root, cleanName, subdirs, wantedExts = DEFAULT_WANTED_EXTS, indexExts = DEFAULT_WANTED_EXTS) {
  const hasExt = /\.[A-Za-z0-9]+$/.test(cleanName);
  const baseNoExt = hasExt ? cleanName.replace(/\.[A-Za-z0-9]+$/, '') : cleanName;
  const list = [];
  for (const sub of subdirs) {
    for (const ext of ['', ...wantedExts]) {
      if (ext === '' && !hasExt) continue;
      list.push(path.join(root, sub, ext === '' ? cleanName : baseNoExt + ext));
    }
    for (const ext of indexExts) {
      list.push(path.join(root, sub, baseNoExt, 'index' + ext));
    }
  }
  return list;
}

/**
 * Resolve an array of Sentry-emitted filename strings to {path, content} entries.
 *   @param {string} root              repo root (absolute)
 *   @param {string[]} filenames       raw filenames from Sentry stack + symbol_hints
 *   @param {string[]} subdirs         repo-specific SUBDIRS list
 *   @param {object}  [opts]
 *   @param {number}  [opts.maxSize]   per-file size ceiling (default 500KB)
 *   @param {number}  [opts.maxFiles]  cap on returned files (caller may also slice)
 *   @returns {Array<{path: string, content: string}>}  relative paths, full content
 */
export function resolveFiles(root, filenames, subdirs, opts = {}) {
  const maxSize = opts.maxSize ?? 500_000;
  const maxFiles = opts.maxFiles ?? 8;
  const out = [];
  const seen = new Set();
  const seenAbs = new Set();
  for (const raw of filenames || []) {
    if (out.length >= maxFiles) break;
    if (!raw) continue;
    const clean = cleanFilename(raw);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    // Pass 1 — exact SUBDIRS × EXTS.
    let picked = null;
    const candidates = buildCandidates(root, clean, subdirs);
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.size <= maxSize) { picked = p; break; }
      } catch {}
    }
    // Pass 2 — recursive basename fallback. Covers symbol-only hints
    // and files nested deeper than any SUBDIRS entry.
    if (!picked) {
      const hits = findByBasenameRecursive(root, clean, { maxSize });
      if (hits[0]) picked = hits[0];
    }
    if (picked && !seenAbs.has(picked)) {
      seenAbs.add(picked);
      out.push({ path: path.relative(root, picked), content: fs.readFileSync(picked, 'utf8') });
    }
  }
  return out;
}
