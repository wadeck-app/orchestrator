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
        out[path.relative(dir, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
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
