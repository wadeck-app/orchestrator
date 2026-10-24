'use strict';

// The committed fixtures (test/progress/fixtures) are the output of helpers/make-fixtures.js; they must not drift.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { writeFixtures, fixtureSpecs } = require('./helpers/make-fixtures');
const { tempDir, cleanupTemp } = require('./helpers/fixture-builder');

after(cleanupTemp);

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        // Content, not the checkout's line endings (CRLF on the CI's Windows runner).
        out[path.relative(dir, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
      }
    }
  };
  walk(dir);
  return out;
}

test('the committed fixtures are what make-fixtures.js writes', () => {
  const committed = path.join(__dirname, 'fixtures');
  const fresh = tempDir();
  writeFixtures(fresh);
  for (const name of Object.keys(fixtureSpecs())) {
    if (!fs.existsSync(path.join(committed, name))) {
      throw new Error(`fixture ${name} is missing from ${committed}; regenerate: node test/progress/helpers/make-fixtures.js test/progress/fixtures`);
    }
    assert.deepEqual(tree(path.join(committed, name)), tree(path.join(fresh, name)),
      `fixture ${name} differs from the generator; regenerate: node test/progress/helpers/make-fixtures.js test/progress/fixtures`);
  }
});

test('the fixtures hold synthetic text only: no path of this machine, no user name', () => {
  const committed = path.join(__dirname, 'fixtures');
  const all = JSON.stringify(tree(committed));
  assert.doesNotMatch(all, /Wadeck|Workspace_|C:\\\\Users/i);
});

// The CI's Windows runner checks files out with CRLF line endings, so the committed fixtures read back with '\r\n' while
// the generator writes '\n' (run 40124169093: 'fixture minutes-stable differs from the generator'). What must not drift
// is the content, not the checkout's line endings.
test('a checkout with CRLF line endings compares equal to the generator output', () => {
  const committed = path.join(__dirname, 'fixtures');
  const name = Object.keys(fixtureSpecs())[0];
  const crlf = tempDir();
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        copy(path.join(from, entry.name), path.join(to, entry.name));
      } else {
        fs.writeFileSync(path.join(to, entry.name), fs.readFileSync(path.join(from, entry.name), 'utf8').replace(/\r?\n/g, '\r\n'));
      }
    }
  };
  copy(path.join(committed, name), path.join(crlf, name));
  assert.deepEqual(tree(path.join(crlf, name)), tree(path.join(committed, name)));
});
