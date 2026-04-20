import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeResponse } from './patch.mjs';

const PATCH_SAMPLE = `diff --git a/components/Foo.jsx b/components/Foo.jsx
index abc..def 100644
--- a/components/Foo.jsx
+++ b/components/Foo.jsx
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
 export default x;`;

test('parseClaudeResponse returns cannot_fix when <cannot_fix> present', () => {
  const r = parseClaudeResponse('<cannot_fix>denylisted path</cannot_fix>');
  assert.equal(r.cannotFix, true);
  assert.match(r.reason, /denylisted/);
});

test('parseClaudeResponse returns parsed fields', () => {
  const body = `
<explanation>
fixed it
</explanation>
<patch>
${PATCH_SAMPLE}
</patch>
<test_note>added test/foo.test.js</test_note>
<confidence>high</confidence>
`;
  const r = parseClaudeResponse(body);
  assert.equal(r.cannotFix, false);
  assert.match(r.explanation, /fixed it/);
  assert.ok(r.patch.includes('diff --git'));
  assert.equal(r.testNote, 'added test/foo.test.js');
  assert.equal(r.confidence, 'high');
});

test('parseClaudeResponse throws on missing patch', () => {
  assert.throws(() => parseClaudeResponse('<explanation>x</explanation>'), /missing <patch>/);
});

test('parseClaudeResponse throws on missing explanation', () => {
  assert.throws(() => parseClaudeResponse('<patch>diff --git a/x b/x\n--- a/x\n+++ b/x\n</patch>'), /missing <explanation>/);
});
