'use strict';

// Run by no-deprecations.test.js with --throw-deprecation: starts a command through the Scheduler's own default spawn
// (nothing injected) and waits for the child to end.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Registry } = require('../../src/registry');
const { State } = require('../../src/state');
const { Scheduler } = require('../../src/scheduler');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-defspawn-'));
const registry = new Registry(path.join(dir, 'registry.json'));
const state = new State(path.join(dir, 'state.json'));
registry.load();
const sched = new Scheduler(registry, state, {
  configDir: dir, liveness: async () => false, sampleUsage: async () => null,
  eventPublisher: { publish() {} },
});
const child = sched._spawn(process.argv[2], undefined, undefined, 'j');
child.once('error', (err) => { process.stderr.write(`spawn failed: ${err.message}\n`); process.exit(2); });
child.once('close', (code) => { process.exit(code === 0 ? 0 : 3); });
