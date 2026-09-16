const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const retiredProvider = ['sen', 'try'].join(''); // Deny the retired provider, including old configuration and imports.
const root = path.resolve(__dirname, '..');
const forbidden = new RegExp(String.raw`@${retiredProvider}\/|${retiredProvider}(?:-cdn)?\.(?:io|com)|${retiredProvider}\.(?:init|captureException|captureMessage)|${retiredProvider}_(?:DSN|AUTH_TOKEN)|${retiredProvider}_key`, 'i');
for (const retired of [`.github/workflows/${retiredProvider}-autofix.yml`, `scripts/${retiredProvider}-autofix`]) {
  assert.equal(fs.existsSync(path.join(root, retired)), false, retired + ' must remain retired');
}
function files(dir) {
  return fs.readdirSync(path.join(root, dir), {withFileTypes:true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : /\.(?:[cm]?js|html|json|ya?ml)$/.test(file) ? [file] : [];
  });
}
for (const file of ['package.json','package-lock.json','main.js','preload.js',...files('renderer'),...files('.github/workflows')]) {
  assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'), forbidden, file);
}
console.log('Retired telemetry guard passed: desktop source, dependency declarations, and workflows.');
