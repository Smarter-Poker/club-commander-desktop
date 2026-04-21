// Unit tests for resolve.mjs — the resolver that turns Sentry filenames and
// symbol hints into real files in the repo.
//
// Uses a scratch directory under os.tmpdir() to build synthetic repo layouts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanFilename, findByBasenameRecursive, buildCandidates, resolveFiles } from './resolve.mjs';

function mkScratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-test-'));
}

function write(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

// ══════════════════ cleanFilename ══════════════════

test('cleanFilename strips webpack-internal prefix', () => {
  assert.equal(cleanFilename('webpack-internal:///(app-pages)/pages/hub/index.js'), 'pages/hub/index.js');
});

test('cleanFilename strips app:/// prefix', () => {
  assert.equal(cleanFilename('app:///src/components/Foo.tsx'), 'src/components/Foo.tsx');
});

test('cleanFilename strips leading slashes', () => {
  assert.equal(cleanFilename('//pages/api/health.js'), 'pages/api/health.js');
});

test('cleanFilename strips leading dot-slash', () => {
  assert.equal(cleanFilename('../src/Foo.ts'), 'src/Foo.ts');
});

test('cleanFilename strips query string', () => {
  assert.equal(cleanFilename('src/Foo.ts?v=1'), 'src/Foo.ts');
});

test('cleanFilename handles empty + null', () => {
  assert.equal(cleanFilename(''), '');
  assert.equal(cleanFilename(null), '');
  assert.equal(cleanFilename(undefined), '');
});

// ══════════════════ findByBasenameRecursive ══════════════════

test('finds a file by bare identifier name', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/components/wallet/DynamicWallet.tsx'), 'export default function X() {}');
    const hits = findByBasenameRecursive(scratch, 'DynamicWallet');
    assert.equal(hits.length, 1);
    assert.ok(hits[0].endsWith('DynamicWallet.tsx'));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('skips node_modules, .git, dist, build, .next', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'node_modules/pkg/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, '.git/objects/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, 'dist/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, '.next/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, 'src/DynamicWallet.tsx'), 'x');
    const hits = findByBasenameRecursive(scratch, 'DynamicWallet');
    assert.equal(hits.length, 1);
    assert.ok(hits[0].endsWith('src/DynamicWallet.tsx'));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('skips hidden directories', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, '.cache/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, '.vercel/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, 'src/DynamicWallet.tsx'), 'x');
    const hits = findByBasenameRecursive(scratch, 'DynamicWallet');
    assert.equal(hits.length, 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('respects maxHits cap', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'a/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, 'b/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, 'c/DynamicWallet.tsx'), 'x');
    write(path.join(scratch, 'd/DynamicWallet.tsx'), 'x');
    const hits = findByBasenameRecursive(scratch, 'DynamicWallet', { maxHits: 2 });
    assert.equal(hits.length, 2);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('matches only exact basename (no fuzzy/substring)', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/WalletStore.ts'), 'x');
    write(path.join(scratch, 'src/Wallet.ts'), 'x');
    const hits = findByBasenameRecursive(scratch, 'Wallet');
    assert.equal(hits.length, 1);
    assert.ok(hits[0].endsWith('/Wallet.ts'));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('rejects short identifiers to avoid noise', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/Ab.ts'), 'x');
    const hits = findByBasenameRecursive(scratch, 'Ab');
    assert.deepEqual(hits, []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('rejects non-identifier-looking needles', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/foo.ts'), 'x');
    const hits = findByBasenameRecursive(scratch, 'foo bar baz');
    assert.deepEqual(hits, []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('respects maxSize limit', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/HugeComponent.tsx'), 'x'.repeat(1_000_000));
    const hits = findByBasenameRecursive(scratch, 'HugeComponent', { maxSize: 500_000 });
    assert.deepEqual(hits, []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('strips extension from needle before matching', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/Button.tsx'), 'x');
    const hits = findByBasenameRecursive(scratch, 'Button.ts');  // caller had wrong ext
    assert.equal(hits.length, 1);
    assert.ok(hits[0].endsWith('Button.tsx'));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// ══════════════════ buildCandidates ══════════════════

test('buildCandidates produces SUBDIRS × EXTS grid for a bare name', () => {
  const cands = buildCandidates('/repo', 'Foo', ['', 'src']);
  const rels = cands.map(c => c.replace('/repo/', ''));
  assert.ok(rels.includes('/repo/Foo.ts'.replace('/repo/', '')) || rels.includes('Foo.ts'));
  assert.ok(rels.includes('src/Foo.ts'));
  assert.ok(rels.includes('src/Foo.tsx'));
  // and index form
  assert.ok(rels.includes('src/Foo/index.ts'));
});

test('buildCandidates preserves extension when given', () => {
  const cands = buildCandidates('/repo', 'Foo.tsx', ['src']);
  // With extension, it tries the exact name (ext='') first
  assert.ok(cands.includes('/repo/src/Foo.tsx'));
});

// ══════════════════ resolveFiles ══════════════════

test('resolveFiles finds a file via SUBDIRS × EXTS', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/components/Foo.tsx'), 'export default 1;');
    const files = resolveFiles(scratch, ['Foo'], ['', 'src', 'src/components']);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'src/components/Foo.tsx');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles falls back to recursive basename when SUBDIRS miss', () => {
  const scratch = mkScratch();
  try {
    // Deep path not reachable via short SUBDIRS list.
    write(path.join(scratch, 'src/features/wallet/deep/DynamicWallet.tsx'), 'export default 1;');
    const files = resolveFiles(scratch, ['DynamicWallet'], ['', 'src']);
    assert.equal(files.length, 1);
    assert.ok(files[0].path.endsWith('DynamicWallet.tsx'));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles deduplicates identical needles', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/Foo.tsx'), 'x');
    const files = resolveFiles(scratch, ['Foo', 'Foo', 'Foo.tsx'], ['', 'src']);
    assert.equal(files.length, 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles deduplicates even when 2 needles resolve to same absolute file', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/Foo.tsx'), 'x');
    const files = resolveFiles(scratch, ['src/Foo.tsx', 'Foo'], ['', 'src']);
    assert.equal(files.length, 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles respects maxFiles cap', () => {
  const scratch = mkScratch();
  try {
    for (let i = 0; i < 10; i++) write(path.join(scratch, `src/File${i}.ts`), 'x');
    const names = Array.from({ length: 10 }, (_, i) => `File${i}`);
    const files = resolveFiles(scratch, names, ['', 'src'], { maxFiles: 3 });
    assert.equal(files.length, 3);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles skips files above maxSize', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/Big.ts'), 'x'.repeat(1_000_000));
    const files = resolveFiles(scratch, ['Big'], ['src'], { maxSize: 500_000 });
    assert.equal(files.length, 0);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles returns [] for unresolvable names', () => {
  const scratch = mkScratch();
  try {
    const files = resolveFiles(scratch, ['DoesNotExistAtAll'], ['src']);
    assert.deepEqual(files, []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles reads file content for returned hits', () => {
  const scratch = mkScratch();
  try {
    write(path.join(scratch, 'src/Foo.ts'), 'export const x = 42;\n');
    const files = resolveFiles(scratch, ['Foo'], ['', 'src']);
    assert.equal(files[0].content, 'export const x = 42;\n');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('resolveFiles handles empty/nullish input gracefully', () => {
  assert.deepEqual(resolveFiles('/tmp', [], ['src']), []);
  assert.deepEqual(resolveFiles('/tmp', [''], ['src']), []);
  assert.deepEqual(resolveFiles('/tmp', [null, undefined], ['src']), []);
});
