'use strict';

// The `declared` strategy (##orch-progress <0-100> <message>) puts the job's last message in detail.message. `orch status` shows
// it after the percent and the end time, as an excerpt that fits the terminal: the message is written by the job, so it is
// cleaned of control characters, cut on a character boundary with an ellipsis, and dropped when there is no room for a useful
// part of it. The percent, the end time and the confidence mark are never the ones that give way.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runCli, describeProgress } = require('../src/cli');

const ETA = '2026-10-20T14:32:00.000Z';

function estimate(over = {}, message) {
  return {
    strategyId: 'declared', progress: 0.42, etaAt: ETA, confidence: 'high', confidenceScore: 0.9,
    reason: 'job reports 42 %', serverNow: '2026-10-20T14:00:00.000Z',
    ...(message === undefined ? {} : { detail: { message } }),
    ...over,
  };
}
const line = (est, columns = 80, id = 'jira') => describeProgress({ [id]: est }, columns)[0];
const base = (est, id = 'jira') => describeProgress({ [id]: est }, 1000)[0];

describe('describeProgress with a message', () => {
  test('the message follows the percent and the end time, quoted', () => {
    const l = line(estimate({}, 'reading the input'));
    assert.ok(l.startsWith(base(estimate({}))), l);
    assert.ok(l.endsWith(' "reading the input"'), l);
  });

  test('a message that does not fit is cut with an ellipsis and the line stays within the terminal', () => {
    const long = 'x'.repeat(200);
    for (const columns of [30, 40, 60, 80, 120]) {
      const l = line(estimate({}, long), columns);
      assert.ok(l.length <= columns, `${columns}: ${l.length} ${l}`);
      assert.ok(l.endsWith('..."'), l);
    }
  });

  test('the excerpt uses all the room it has', () => {
    const l = line(estimate({}, 'y'.repeat(200)), 60);
    assert.equal(l.length, 60, l);
  });

  test('without room for a useful part of the message, it is left out and the line is the one without a message', () => {
    const plain = base(estimate({}));
    assert.equal(line(estimate({}, 'a message'), plain.length + 6), plain);
    assert.equal(line(estimate({}, 'a message'), plain.length), plain);
  });

  test('the confidence mark stays before the message, and is never cut for it', () => {
    const low = estimate({ confidence: 'low' }, 'copying files');
    const l = line(low, 100);
    assert.match(l, /\(low confidence\) "copying files"$/);
    const tight = line(low, base(estimate({ confidence: 'low' })).length + 3);
    assert.match(tight, /\(low confidence\)$/);
  });

  test('control characters and line breaks become single spaces; nothing can move the cursor or recolor the terminal', () => {
    const l = line(estimate({}, 'step\u001b[31m 3\r\n\tdone\u0007\u009b'), 120);
    assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/);
    assert.match(l, /"step \[31m 3 done"$/);
  });

  test('a cut never splits a character made of two code units', () => {
    const emoji = '🙂'.repeat(60);
    for (let columns = 40; columns < 70; columns++) {
      const l = line(estimate({}, emoji), columns);
      assert.doesNotMatch(l, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `${columns}: ${JSON.stringify(l)}`);
      assert.ok(l.length <= columns, `${columns}: ${l.length}`);
    }
  });

  test('an empty, blank or non-text message adds nothing', () => {
    const plain = base(estimate({}));
    for (const message of ['', '   \n\t ', 42, null, { a: 1 }]) {
      assert.equal(line(estimate({ detail: { message } }), 100), plain, JSON.stringify(message));
    }
    assert.equal(line(estimate({}), 100), plain, 'no detail at all');
  });

  test('an estimate that is overdue (no end time) shows the message too, when there is room', () => {
    const overdue = estimate({ etaAt: null, progress: 0.99, reason: 'longer than usual' }, 'still copying');
    assert.match(line(overdue, 100), /99% longer than usual "still copying"$/);
  });

  test('a job with no estimate keeps its sentence: there is nothing to attach the message to', () => {
    const none = estimate({ progress: null, etaAt: null, confidence: 'none', reason: 'needs 3 usable runs, has 1' }, 'a message');
    assert.equal(line(none, 200), '  jira: no estimate - needs 3 usable runs, has 1');
  });

  test('every line of several jobs fits, whatever the message', () => {
    const lines = describeProgress({
      a: estimate({}, 'm'.repeat(90)), bb: estimate({ confidence: 'low' }, 'short'), c: estimate({}, '🙂'.repeat(50)),
    }, 50);
    for (const l of lines) { assert.ok(l.length <= 50, `${l.length} ${l}`); }
  });
});

describe('orch status on a terminal', () => {
  const origColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  afterEach(() => {
    process.exitCode = 0;
    if (origColumns) { Object.defineProperty(process.stdout, 'columns', origColumns); } else { delete process.stdout.columns; }
  });

  async function status(columns) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-status-msg-'));
    fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
    const out = [];
    const origLog = console.log;
    const origTty = process.stdout.isTTY;
    console.log = (...a) => { out.push(a.join(' ')); };
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    const answers = {
      version: { pid: 1, port: 47900, uptime: 5 },
      'get-progress': { jira: estimate({}, 'm'.repeat(300)) },
    };
    try {
      await runCli(['status'], { send: async (c) => answers[c] ?? {}, startDaemon: () => {}, configDir: dir });
    } finally {
      console.log = origLog;
      Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    return out;
  }

  test('the excerpt is sized to the width of the terminal', async () => {
    for (const columns of [50, 90]) {
      const jira = (await status(columns)).find((l) => l.includes('jira:'));
      assert.ok(jira, 'the progress line is printed');
      assert.equal(jira.length, columns, jira);
    }
  });

  test('a terminal that does not say its width gets 80 columns', async () => {
    const jira = (await status(undefined)).find((l) => l.includes('jira:'));
    assert.equal(jira.length, 80, jira);
  });
});
