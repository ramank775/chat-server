const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REASON } = require('../libs/v3-envelope');

// Every `REASON.X` the server emits must exist, or the ack's `reason`
// serialises as an empty string (this happened with DOWNSTREAM_TIMEOUT).
const SKIP = new Set(['node_modules', 'test']);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !SKIP.has(entry.name))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return jsFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
}

test('every REASON.* referenced in source is defined', () => {
  const root = path.join(__dirname, '..');
  const missing = ['services', 'libs']
    .flatMap((d) => jsFiles(path.join(root, d)))
    .flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/REASON\.([A-Z_]+)/g)]
      .map(([, key]) => ({ key, file: path.relative(root, file) })))
    .filter(({ key }) => !(key in REASON))
    .map(({ key, file }) => `${key} (${file})`);
  assert.deepStrictEqual(missing, []);
});
