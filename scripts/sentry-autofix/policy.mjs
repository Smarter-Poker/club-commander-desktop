// Code-modification policy for the Club Commander autofix runner.
//
// Club Commander is the smarter.poker live-room management Electron app
// (poker-room operator console). Critical surfaces:
//   - main.js              — Electron main process, IPC, auto-updater
//   - preload.js           — contextBridge surface (security boundary)
//   - electron-builder.yml — code-signing, publisher, release channels
//   - build/               — generated installers; do not hand-edit
//   - auto-update paths    — silent updater, never auto-fix
//
// DENYLIST = Claude may NEVER touch. ALLOWLIST (for Phase 5.2.2 auto-merge).
// Phase 5.2.1 is dry-run only → every fix lands as a draft PR.

const DENYLIST = [
  // Electron boundary — process isolation + IPC bridge. Security critical.
  'main.js',
  'preload.js',
  'renderer/main.js',
  'renderer/preload.js',

  // Auto-updater + release channel config. Bad update = remote bricking.
  'src/updater',
  'src/auto-update',
  'electron-builder.yml',
  'electron-builder.json',
  'electron-builder.js',

  // Code signing / notarization.
  'entitlements.mac.plist',
  'build/entitlements',
  'notarize.js',
  'afterSign.js',

  // Money / balance surface — never auto-fix.
  '/ledger/',
  '/wallet/',
  '/rake/',
  '/payouts/',
  '/cashout/',
  '/kyc/',
  '/mfa/',

  // Auth surfaces.
  'auth/token',
  'auth/session',
  'lib/supabaseAdmin',
  'lib/supabase-admin',
  'lib/serviceRole',

  // Database migrations (irreversible).
  'supabase/migrations/',
  'sql/',

  // Infra configs.
  '.github/workflows/',
  '.husky/',
  'tsconfig',

  // Dependency manifests.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',

  // Env + secrets.
  '.env',
  '.env.local',
  '.env.production',

  // Autofix pipeline self-modification (loop risk).
  'scripts/sentry-autofix/',

  // Build outputs (generated).
  'build/',
  'dist/',
  'release/',
  'out/',
];

const ALLOWLIST = [
  // UI renderer — safest layer.
  'renderer/components/',
  'renderer/pages/',
  'renderer/hooks/',
  'renderer/stores/',
  'renderer/utils/',
  'renderer/styles/',
  'renderer/assets/',

  // Non-security src subtrees.
  'src/components/',
  'src/pages/',
  'src/hooks/',
  'src/utils/',
  'src/constants/',
  'src/types/',
  'src/views/',

  // Tests.
  'tests/',
  'e2e/',
  '__tests__/',
];

export function isDenied(path) {
  return DENYLIST.some(p => path.includes(p));
}

export function isAllowedForAutoMerge(path) {
  return ALLOWLIST.some(p => path.includes(p));
}

/**
 * @param {string[]} paths  file paths Claude's patch touches
 * @returns {{ok:boolean, denied:string[], allowMerge:boolean}}
 */
export function assessPaths(paths) {
  const denied = paths.filter(isDenied);
  if (denied.length) return { ok: false, denied, allowMerge: false };
  const allowMerge = paths.length > 0 && paths.every(isAllowedForAutoMerge);
  return { ok: true, denied: [], allowMerge };
}

export { DENYLIST, ALLOWLIST };
