'use strict';

// registry.json is JSON, so it cannot carry a real comment, and hand-editing it does not half-work:
// the daemon caches the file at startup and the next CLI-driven write rewrites it from that stale
// memory, so an external edit disappears rather than merely failing to apply. The notice says so.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Registry, REGISTRY_NOTICE } = require('../src/registry');

const tmpDirs = [];

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-notice-'));
  tmpDirs.push(dir);
  return path.join(dir, 'registry.json');
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function readRaw(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const JOB = { id: 'j1', type: 'startup', command: 'node -v', delaySeconds: 0 };

describe('registry.json carries a do-not-edit notice', () => {
  test('a fresh registry gets it on creation', () => {
    const file = tmpFile();
    new Registry(file).load();
    assert.equal(readRaw(file)._README, REGISTRY_NOTICE);
  });

  test('it is the first key, so it is the first thing seen when the file is opened', () => {
    const file = tmpFile();
    new Registry(file).load();
    assert.equal(Object.keys(readRaw(file))[0], '_README');
  });

  test('the wording names the alternatives rather than only forbidding the edit', () => {
    // An instruction with no route out is one a reader talks themselves past.
    assert.match(REGISTRY_NOTICE, /orch add/, 'no CLI route offered');
    assert.match(REGISTRY_NOTICE, /web UI|dashboard/i, 'no UI route offered');
    // The two facts that make hand-editing lossy rather than merely ineffective.
    assert.match(REGISTRY_NOTICE, /restart/i, 'does not say edits are ignored until a restart');
    assert.match(REGISTRY_NOTICE, /overwritten|discard/i, 'does not say the edit gets overwritten');
  });

  test('every mutation keeps it, so a job change cannot drop it', () => {
    const file = tmpFile();
    const reg = new Registry(file);
    reg.add(JOB);
    assert.equal(readRaw(file)._README, REGISTRY_NOTICE, 'lost on add');
    reg.disable('j1');
    assert.equal(readRaw(file)._README, REGISTRY_NOTICE, 'lost on disable');
    reg.edit('j1', { label: 'renamed' });
    assert.equal(readRaw(file)._README, REGISTRY_NOTICE, 'lost on edit');
    reg.remove('j1');
    assert.equal(readRaw(file)._README, REGISTRY_NOTICE, 'lost on remove');
  });

  test('an existing registry without it is repaired on load', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [JOB] }));

    const reg = new Registry(file);
    reg.load();

    const raw = readRaw(file);
    assert.equal(raw._README, REGISTRY_NOTICE, 'a pre-existing registry never gets the notice');
    assert.equal(raw.jobs.length, 1, 'repairing the notice dropped the jobs');
    assert.equal(raw.jobs[0].id, 'j1');
  });

  test('a stale notice is replaced', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ _README: 'old wording', version: 1, jobs: [] }));

    new Registry(file).load();

    assert.equal(readRaw(file)._README, REGISTRY_NOTICE);
  });

  test('the notice does not become a job, or shift the data the daemon reads', () => {
    const file = tmpFile();
    const reg = new Registry(file);
    reg.add(JOB);

    const fresh = new Registry(file);
    const data = fresh.load();
    assert.equal(data.jobs.length, 1);
    assert.equal(data.version, 1);
    assert.equal(fresh.get('j1').command, 'node -v');
    assert.equal(fresh.get('_README'), null, 'the notice key was read as a job');
  });
});
