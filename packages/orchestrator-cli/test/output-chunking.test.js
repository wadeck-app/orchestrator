'use strict';

// A program's output arrives in chunks cut anywhere: inside an escape sequence, inside a multibyte character.
// Neither the run log (Scheduler) nor the lines of `orch exec` (ExecManager) may ever hold a raw ESC or the
// leftover of a cut sequence. The children are scripted (the exact chunk boundaries are the point of the test, a
// real pipe does not promise them) and the Scheduler/ExecManager are driven by FakeTime.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { ExecManager } = require('../src/exec-manager');
const { FakeTime } = require('../src/time-service');
const { RunLogger } = require('../src/logger');

const ESC = '\u001b';
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); } });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chunking-')); dirs.push(d); return d; };

/** A child whose stdout/stderr the test writes to; `ready` resolves once the owner listens to both. */
function scriptedChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { process.nextTick(() => child.emit('close', 143)); };
  child.ready = new Promise((resolve) => {
    child.stderr.on('newListener', (ev) => { if (ev === 'data') { resolve(); } });
  });
  return child;
}

const bytes = (s) => Buffer.from(s, 'utf8');

/** Runs one scheduler run whose child is driven by `script(child)`; returns the run log text. */
async function schedulerLog(script, { job = {}, scheduler = {} } = {}) {
  const dir = tmp();
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  const j = { id: 'chunky', type: 'startup', delaySeconds: 0, command: 'node x.js', enabled: true, triggerMode: 'wait', liveness: null, ...job };
  registry.add(j);
  const child = scriptedChild();
  // Seeded with the real clock: RunLogger prunes log files by real age.
  const sched = new Scheduler(registry, state, { spawn: () => child, liveness: async () => false, configDir: dir, time: new FakeTime(Date.now()), ...scheduler });
  const fired = sched._fire(j);
  await child.ready;
  script(child);
  child.emit('close', 0);
  await fired;
  const logDir = path.join(dir, 'logs', 'jobs', j.id);
  return fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8');
}

/** The job's own lines of a run log: what follows the timestamp, minus the daemon's [job:...] markers. */
const outputLines = (log) => log.split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')).filter((l) => !l.startsWith('[job:'));

async function execLines(script) {
  const dir = tmp();
  const child = scriptedChild();
  const manager = new ExecManager(dir, { publish() {} }, { time: new FakeTime(Date.now()), spawn: () => child });
  const { runId } = manager.fireExec('node x.js', {});
  script(child);
  child.emit('close', 0);
  return manager.get(runId).logs;
}

for (const [name, lines] of [['the scheduler run log', (script) => schedulerLog(script).then(outputLines)], ['orch exec', execLines]]) {
  describe(`${name}: output cut in pieces`, () => {
    test('an escape sequence cut inside its parameters never leaves a fragment', async () => {
      const got = await lines((c) => { c.stdout.emit('data', bytes(`${ESC}[3`)); c.stdout.emit('data', bytes('1mred')); c.stdout.emit('data', bytes(`${ESC}[0m\n`)); });

      assert.deepEqual(got, ['red']);
    });

    test('an escape sequence cut right after ESC, and an OSC cut in its title', async () => {
      const got = await lines((c) => {
        c.stdout.emit('data', bytes(`one ${ESC}`));
        c.stdout.emit('data', bytes('[32mgreen\n'));
        c.stdout.emit('data', bytes(`${ESC}]0;ti`));
        c.stdout.emit('data', bytes('tle\u0007two\n'));
      });

      assert.deepEqual(got, ['one green', 'two']);
    });

    test('stderr gets the same care', async () => {
      const got = await lines((c) => { c.stderr.emit('data', bytes(`${ESC}[3`)); c.stderr.emit('data', bytes('1mwarn\n')); });

      assert.equal(got.length, 1);
      assert.match(got[0], /warn$/);
      assert.equal(got[0].includes(ESC), false);
      assert.equal(/\[31m|1mwarn/.test(got[0]), false, got[0]);
    });

    test('a multibyte character cut between two chunks is decoded whole, never as U+FFFD', async () => {
      const smile = bytes('é🎉');
      const got = await lines((c) => { c.stdout.emit('data', smile.subarray(0, 3)); c.stdout.emit('data', Buffer.concat([smile.subarray(3), bytes('\n')])); });

      assert.equal(got.join(''), 'é🎉');
    });

    test('a sequence still open when the process ends is dropped, not logged raw', async () => {
      const got = await lines((c) => { c.stdout.emit('data', bytes(`last words${ESC}[3`)); });

      assert.deepEqual(got.map((l) => l.replace(/\u001b/g, '<ESC>')), ['last words']);
    });

    test('text without a newline at the end of the output is not lost', async () => {
      const got = await lines((c) => { c.stdout.emit('data', bytes('first\nno newline at the end')); });

      assert.deepEqual(got, ['first', 'no newline at the end']);
    });
  });
}

describe('RunLogger.writeOutput', () => {
  function written(fn) {
    const dir = tmp();
    const logger = new RunLogger(dir, 'j', '2026-10-24T10:00:00.000Z');
    fn(logger);
    logger.close();
    return fs.readFileSync(logger.filePath, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, ''));
  }

  test('a CRLF line loses its CR', () => {
    assert.deepEqual(written((l) => l.writeOutput('windows line\r')), ['windows line']);
  });

  test('a progress line keeps the carriage returns inside it (only the trailing whitespace goes)', () => {
    assert.deepEqual(written((l) => l.writeOutput('10%\r20%\r100%\r')), ['10%\r20%\r100%']);
  });

  test('a line that is only whitespace or escape codes writes nothing', () => {
    assert.deepEqual(written((l) => { l.writeOutput('   '); l.writeOutput('\t\r'); l.writeOutput(`${ESC}[2K${ESC}[1G`); l.writeOutput(''); }), []);
  });

  test('indentation is kept, trailing spaces go; the prefix is added after the strip', () => {
    assert.deepEqual(written((l) => { l.writeOutput(`    ${ESC}[31mindented${ESC}[0m   `); l.writeOutput('oops', '[stderr] '); }), ['    indented', '[stderr] oops']);
  });
});
