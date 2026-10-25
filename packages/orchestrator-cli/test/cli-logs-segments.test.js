'use strict';

// `orch logs --job <id>`: today's runs of a job, with the runs that were rotated into segments (<id>-<stamp>.log, .log.2...):
// the segments come out in numeric order, and --follow goes on when the writer moves to the next segment.
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');
const { followClock } = require('./helpers/follow-clock');

const TODAY = '2026-10-24';
const JOB = 'web';

let dir;
beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(`${TODAY}T12:00:00.000Z`) });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-seg-'));
});
afterEach(() => {
  mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seg(time, n, content) {
  const f = path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${TODAY}T${time}.log${n > 1 ? `.${n}` : ''}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

function start(argv, clock) {
  const stdout = [];
  const origOut = process.stdout.write;
  const origExit = process.exit;
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') {
      return origOut.call(process.stdout, chunk, ...rest);
    }
    stdout.push(chunk);
    return true;
  };
  process.exit = (code) => { throw Object.assign(new Error('exit'), { exitCode: code }); };
  const done = runCli(argv, { send: async () => ({}), startDaemon: () => {}, configDir: dir, logs: { pollMs: 250, time: clock?.time } })
    .catch((e) => { if (e.message !== 'exit') { throw e; } })
    .finally(() => { process.stdout.write = origOut; process.exit = origExit; })
    .then(() => stdout.join(''));
  return { done, text: () => stdout.join('') };
}

const line = (n, text) => `[${TODAY} 03:00:${String(n).padStart(2, '0')}] ${text}`;

describe('orch logs --job: snapshot', () => {
  test('the segments of a run are read in numeric order (.log.10 after .log.9), before the next run', async () => {
    const parts = [];
    for (let n = 1; n <= 11; n++) {
      parts.push(line(n, `part ${n}`));
      seg('03-00-00', n, `${parts[n - 1]}\n`);
    }
    seg('04-00-00', 1, `${line(30, 'next run')}\n`);
    const { done } = start(['logs', '--job', JOB, '--json'], followClock());
    const out = (await done).trimEnd().split('\n').map((l) => JSON.parse(l).message);
    assert.deepEqual(out, [...Array.from({ length: 11 }, (_, i) => `part ${i + 1}`), 'next run']);
  });

  test('--tail counts across segments', async () => {
    seg('03-00-00', 1, `${line(1, 'a')}\n${line(2, 'b')}\n`);
    seg('03-00-00', 2, `${line(3, 'c')}\n`);
    const { done } = start(['logs', '--job', JOB, '--tail', '2', '--json'], followClock());
    assert.deepEqual((await done).trimEnd().split('\n').map((l) => JSON.parse(l).message), ['b', 'c']);
  });

  test('a file that only looks like a segment is not one', async () => {
    seg('03-00-00', 1, `${line(1, 'real')}\n`);
    fs.writeFileSync(path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${TODAY}T03-00-00.log.bak`), `${line(2, 'backup')}\n`);
    fs.writeFileSync(path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${TODAY}T03-00-00.log.1`), `${line(3, 'one')}\n`);
    const { done } = start(['logs', '--job', JOB, '--json'], followClock());
    assert.deepEqual((await done).trimEnd().split('\n').map((l) => JSON.parse(l).message), ['real']);
  });
});

describe('orch logs --job --follow', () => {
  test('goes on in the next segment of the run, and in the next run', async () => {
    const first = seg('03-00-00', 1, `${line(1, 'a')}\n`);
    const clock = followClock();
    const { done, text } = start(['logs', '--job', JOB, '--follow'], clock);
    const p = done;
    await clock.tick(250, p, () => fs.appendFileSync(first, `${line(2, 'b')}\n`));
    await clock.tick(250, p, () => seg('03-00-00', 2, `${line(3, 'c')}\n`));
    await clock.tick(250, p, () => seg('03-00-00', 3, `${line(4, 'd')}\n`));
    await clock.tick(250, p, () => seg('04-00-00', 1, `${line(6, 'next run')}\n`));
    await clock.tick(250, p);
    // Not a terminal: one JSON object per line.
    assert.deepEqual(text().trimEnd().split('\n').map((l) => JSON.parse(l).message), ['a', 'b', 'c', 'd', 'next run']);
    process.emit('SIGINT');
    await p;
  });
});
