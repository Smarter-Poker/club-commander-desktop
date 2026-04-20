import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPaths, isDenied, isAllowedForAutoMerge } from './policy.mjs';

test('denylists Electron boundary files', () => {
  assert.equal(isDenied('main.js'), true);
  assert.equal(isDenied('preload.js'), true);
  assert.equal(isDenied('renderer/main.js'), true);
  assert.equal(isDenied('renderer/preload.js'), true);
});

test('denylists auto-updater + code-signing', () => {
  assert.equal(isDenied('src/updater/check.js'), true);
  assert.equal(isDenied('src/auto-update/applyUpdate.js'), true);
  assert.equal(isDenied('electron-builder.yml'), true);
  assert.equal(isDenied('notarize.js'), true);
  assert.equal(isDenied('afterSign.js'), true);
});

test('denylists money + auth + migrations', () => {
  assert.equal(isDenied('renderer/pages/ledger/index.jsx'), true);
  assert.equal(isDenied('src/lib/supabaseAdmin.js'), true);
  assert.equal(isDenied('supabase/migrations/20260420_x.sql'), true);
});

test('denylists workflows + own tooling', () => {
  assert.equal(isDenied('.github/workflows/build-release.yml'), true);
  assert.equal(isDenied('scripts/sentry-autofix/run.mjs'), true);
});

test('denylists build outputs', () => {
  assert.equal(isDenied('build/installer-win.exe'), true);
  assert.equal(isDenied('dist/bundle.js'), true);
  assert.equal(isDenied('release/latest.yml'), true);
});

test('does not denylist ordinary renderer component', () => {
  assert.equal(isDenied('renderer/components/Lobby.jsx'), false);
  assert.equal(isDenied('renderer/pages/dashboard.jsx'), false);
});

test('allowlist covers renderer UI paths', () => {
  assert.equal(isAllowedForAutoMerge('renderer/components/SeatButton.jsx'), true);
  assert.equal(isAllowedForAutoMerge('renderer/pages/tables.jsx'), true);
  assert.equal(isAllowedForAutoMerge('renderer/hooks/useSocket.js'), true);
});

test('allowlist excludes IPC + main process', () => {
  assert.equal(isAllowedForAutoMerge('main.js'), false);
  assert.equal(isAllowedForAutoMerge('preload.js'), false);
});

test('assessPaths: all denylisted → ok=false', () => {
  const r = assessPaths(['main.js', 'electron-builder.yml']);
  assert.equal(r.ok, false);
  assert.equal(r.denied.length, 2);
});

test('assessPaths: all allowlisted → ok=true, allowMerge=true', () => {
  const r = assessPaths(['renderer/components/A.jsx', 'renderer/components/B.jsx']);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, true);
});

test('assessPaths: mixed safe but non-allowlisted → ok=true, allowMerge=false', () => {
  const r = assessPaths(['lib/misc.js', 'renderer/components/A.jsx']);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, false);
});

test('assessPaths: empty → ok=true, allowMerge=false', () => {
  const r = assessPaths([]);
  assert.equal(r.ok, true);
  assert.equal(r.allowMerge, false);
});
