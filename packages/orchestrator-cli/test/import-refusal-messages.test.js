'use strict';

// POST /api/jobs/import (orch-core) relays the daemon's sentence for each refused job. These are the sentences the
// real registry gives for a bad `progress` and a bad `resourceLimits`: each names the field, the problem and the way out.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Registry } = require('../src/registry');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-import-msg-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const BASE = { type: 'startup', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget' };

function refusal(job) {
  const registry = new Registry(path.join(dir, `${job.id}.json`));
  registry.load();
  try {
    registry.add({ ...BASE, ...job });
  } catch (err) {
    return err.message;
  }
  assert.fail(`job ${job.id} was accepted`);
}

describe('the sentence a refused import carries', () => {
  test('a bad progress names the strategies that exist and the way back to the default', () => {
    const message = refusal({ id: 'bad-progress', progress: 'nope' });
    assert.match(message, /nope/);
    assert.match(message, /ensemble/, 'lists what is accepted');
    assert.match(message, /orch edit bad-progress --unset progress/);
  });

  test('a bad progress option names the option', () => {
    const message = refusal({ id: 'bad-options', progress: { strategy: 'ratio', options: { pattern: '(' } } });
    assert.match(message, /ratio/);
  });

  test('a bad resourceLimits names the field and its range', () => {
    const message = refusal({ id: 'bad-limits', resourceLimits: { cpuPct: 500 } });
    assert.match(message, /cpuPct/);
  });
});
