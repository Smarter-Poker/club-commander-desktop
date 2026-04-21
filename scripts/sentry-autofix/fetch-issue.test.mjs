// Unit tests for fetch-issue.mjs — focus on the new symbol extractor and
// the reportError-helper filter in probablyInApp. Network-hitting fetchIssue
// and fetchLatestEvent are not tested here; they're exercised in the live
// verify-pipeline flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsFromText, extractStack, probablyInApp } from './fetch-issue.mjs';

// ══════════════════ extractSymbolsFromText ══════════════════

test('parses [ClassName.method] form', () => {
  assert.deepEqual(
    extractSymbolsFromText('[CreditService.getAgentInvoices] [object Object]'),
    ['CreditService']
  );
});

test('parses [ClassName] form', () => {
  assert.deepEqual(
    extractSymbolsFromText('[DynamicWallet] connection timeout'),
    ['DynamicWallet']
  );
});

test('parses multiple class-name hints from message', () => {
  const r = extractSymbolsFromText('[WalletStore] failed to load from [CreditService.list]');
  assert.deepEqual(r, ['WalletStore', 'CreditService']);
});

test('parses "in ClassName" form', () => {
  assert.deepEqual(
    extractSymbolsFromText('Error occurred in MarketplacePage.useEffect'),
    ['MarketplacePage']
  );
});

test('parses "at ClassName" form', () => {
  assert.deepEqual(
    extractSymbolsFromText('thrown at DiamondStore.render'),
    ['DiamondStore']
  );
});

test('bare ClassName.methodName fallback only when no other hints', () => {
  assert.deepEqual(
    extractSymbolsFromText('SomeComponent.handleClick failed'),
    ['SomeComponent']
  );
});

test('filters noise class names (Error, TypeError, etc.)', () => {
  assert.deepEqual(extractSymbolsFromText('TypeError: cannot read x'), []);
  assert.deepEqual(extractSymbolsFromText('[Error] something'), []);
  assert.deepEqual(extractSymbolsFromText('[Object] wrapped [Promise]'), []);
});

test('filters short (< 3 chars) identifiers', () => {
  assert.deepEqual(extractSymbolsFromText('[Ab.foo] [XY] thrown'), []);
});

test('deduplicates repeated symbols', () => {
  const r = extractSymbolsFromText('[Wallet] failed; [Wallet.foo] also failed; in Wallet');
  assert.deepEqual(r, ['Wallet']);
});

test('returns [] for empty/null input', () => {
  assert.deepEqual(extractSymbolsFromText(''), []);
  assert.deepEqual(extractSymbolsFromText(null), []);
  assert.deepEqual(extractSymbolsFromText(undefined), []);
});

test('ignores lowercase identifiers', () => {
  assert.deepEqual(extractSymbolsFromText('[creditService.foo]'), []);
  assert.deepEqual(extractSymbolsFromText('in handleClick'), []);
});

// ══════════════════ probablyInApp ══════════════════

test('probablyInApp rejects node_modules', () => {
  assert.equal(probablyInApp({ filename: 'node_modules/react/index.js' }), false);
});

test('probablyInApp rejects Next.js internals', () => {
  assert.equal(probablyInApp({ filename: '_next/static/chunks/main.js' }), false);
  assert.equal(probablyInApp({ filename: 'next/dist/server/index.js' }), false);
  assert.equal(probablyInApp({ filename: 'app:///_next/static/bundle.js' }), false);
});

test('probablyInApp rejects @sentry helpers', () => {
  assert.equal(probablyInApp({ filename: '@sentry/react/dist/index.js' }), false);
  assert.equal(probablyInApp({ filename: 'sentry-trace.js' }), false);
});

test('probablyInApp rejects errorReporter/reportError helpers', () => {
  // The whole reason for the P0 fix — these are the wrapper, NOT the callsite.
  assert.equal(probablyInApp({ filename: 'src/utils/errorReporter.ts' }), false);
  assert.equal(probablyInApp({ filename: 'lib/error-reporter.js' }), false);
  assert.equal(probablyInApp({ filename: 'src/reportError.ts' }), false);
  assert.equal(probablyInApp({ filename: 'src/report-error.ts' }), false);
  assert.equal(probablyInApp({ filename: 'src/utils/captureException.ts' }), false);
});

test('probablyInApp accepts project files with in_app=true', () => {
  assert.equal(probablyInApp({ filename: 'src/components/Foo.tsx', in_app: true }), true);
});

test('probablyInApp accepts project files with in_app unset when path looks project-local', () => {
  assert.equal(probablyInApp({ filename: 'src/components/Foo.tsx' }), true);
  assert.equal(probablyInApp({ filename: 'pages/hub/index.js' }), true);
  assert.equal(probablyInApp({ filename: 'components/Nav.jsx' }), true);
});

test('probablyInApp respects explicit in_app=false even for project paths', () => {
  assert.equal(probablyInApp({ filename: 'src/components/Foo.tsx', in_app: false }), false);
});

// ══════════════════ extractStack ══════════════════

test('extractStack appends symbol_hints from exception.value', () => {
  const event = {
    entries: [{
      type: 'exception',
      data: {
        values: [{
          type: 'Error',
          value: '[CreditService.getAgentInvoices] [object Object]',
          stacktrace: {
            frames: [
              { filename: 'src/utils/errorReporter.ts', function: 'reportError', lineno: 46, in_app: true },
            ],
          },
        }],
      },
    }],
  };
  const stack = extractStack(event);
  // errorReporter frame is rejected → source_files only has symbol hint.
  assert.ok(stack.source_files.includes('CreditService'));
  assert.deepEqual(stack.symbol_hints, ['CreditService']);
});

test('extractStack also parses issueTitle for symbols', () => {
  const event = {
    entries: [{
      type: 'exception',
      data: { values: [{ type: 'Error', value: '', stacktrace: { frames: [] } }] },
    }],
  };
  const stack = extractStack(event, '[DynamicWallet._Realtime_channel_error] connection lost');
  assert.ok(stack.source_files.includes('DynamicWallet'));
  assert.deepEqual(stack.symbol_hints, ['DynamicWallet']);
});

test('extractStack keeps real frames AND appends symbols (additive)', () => {
  const event = {
    entries: [{
      type: 'exception',
      data: {
        values: [{
          type: 'Error',
          value: '[WalletStore.load] failed',
          stacktrace: {
            frames: [
              { filename: 'src/components/Profile.tsx', function: 'Profile', lineno: 10, in_app: true },
            ],
          },
        }],
      },
    }],
  };
  const stack = extractStack(event);
  assert.ok(stack.source_files.includes('src/components/Profile.tsx'));
  assert.ok(stack.source_files.includes('WalletStore'));
});

test('extractStack falls back to metadata.filename when no in-app frames', () => {
  const event = {
    entries: [{
      type: 'exception',
      data: {
        values: [{
          type: 'Error',
          value: 'x',
          stacktrace: { frames: [{ filename: 'node_modules/foo/x.js' }] },
        }],
      },
    }],
    metadata: { filename: 'src/components/Foo.tsx' },
  };
  const stack = extractStack(event);
  assert.ok(stack.source_files.includes('src/components/Foo.tsx'));
});

test('extractStack returns empty symbol_hints when no match', () => {
  const event = {
    entries: [{
      type: 'exception',
      data: { values: [{ type: 'TypeError', value: 'x is undefined', stacktrace: { frames: [] } }] },
    }],
  };
  const stack = extractStack(event);
  assert.deepEqual(stack.symbol_hints, []);
});
