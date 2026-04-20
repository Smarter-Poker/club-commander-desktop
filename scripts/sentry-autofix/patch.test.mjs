import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeResponse } from './patch.mjs';

const FILES_SAMPLE = JSON.stringify([
  { path: 'components/Foo.jsx', content: "const x = 2;\nexport default x;\n" },
]);

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
<files_updated>
${FILES_SAMPLE}
</files_updated>
<test_note>added test/foo.test.js</test_note>
<confidence>high</confidence>
`;
  const r = parseClaudeResponse(body);
  assert.equal(r.cannotFix, false);
  assert.match(r.explanation, /fixed it/);
  assert.ok(Array.isArray(r.filesUpdated));
  assert.equal(r.filesUpdated.length, 1);
  assert.equal(r.filesUpdated[0].path, 'components/Foo.jsx');
  assert.match(r.filesUpdated[0].content, /export default x/);
  assert.equal(r.testNote, 'added test/foo.test.js');
  assert.equal(r.confidence, 'high');
});

test('parseClaudeResponse throws on missing files_updated', () => {
  assert.throws(() => parseClaudeResponse('<explanation>x</explanation>'), /missing <files_updated>/);
});

test('parseClaudeResponse throws on missing explanation', () => {
  assert.throws(() => parseClaudeResponse(`<files_updated>${FILES_SAMPLE}</files_updated>`), /missing <explanation>/);
});

test('parseClaudeResponse throws on invalid JSON in files_updated', () => {
  assert.throws(
    () => parseClaudeResponse('<explanation>x</explanation><files_updated>not json</files_updated>'),
    /not valid JSON/,
  );
});

test('parseClaudeResponse throws on empty files_updated array', () => {
  assert.throws(
    () => parseClaudeResponse('<explanation>x</explanation><files_updated>[]</files_updated>'),
    /is empty/,
  );
});

test('parseClaudeResponse throws on entry missing path', () => {
  const bad = JSON.stringify([{ content: 'x' }]);
  assert.throws(
    () => parseClaudeResponse(`<explanation>x</explanation><files_updated>${bad}</files_updated>`),
    /missing 'path'/,
  );
});
