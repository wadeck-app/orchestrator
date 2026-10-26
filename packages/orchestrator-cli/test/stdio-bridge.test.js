'use strict';

// Under the launcher the daemon has no console: its stdout and stderr are the NUL device (launcher.go, openNulStdio), or a
// terminal nobody keeps. So every console.error / process.stderr.write of the daemon -- 24 call sites, among them "this cron
// job will NEVER fire" -- was lost, and `orch logs` never showed a line of them. bridgeStdio copies what the daemon writes on
// its two streams into its log, whoever wrote it, and leaves the stream itself untouched.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { bridgeStdio } = require('../src/stdio-bridge');

/** A stand-in for process.stdout: records what reaches the real stream, and what the real stream returns. */
function fakeStream(returns = true) {
  const written = [];
  const stream = {
    write(chunk, ...rest) {
      written.push(chunk);
      const cb = rest.find((r) => typeof r === 'function');
      if (cb) { cb(); }
      return returns;
    },
  };
  return { stream, written };
}

function setup(returns) {
  const out = fakeStream(returns);
  const err = fakeStream(returns);
  const lines = [];
  const bridge = bridgeStdio([{ name: 'stdout', stream: out.stream }, { name: 'stderr', stream: err.stream }], (l) => lines.push(l));
  return { out, err, lines, bridge };
}

describe('bridgeStdio', () => {
  test('a line written on a stream reaches the sink, tagged with the stream, and the stream still gets it', () => {
    const { err, lines } = setup();
    err.stream.write('[scheduler] job "j" will NEVER fire\n');
    assert.deepEqual(lines, ['[stderr] [scheduler] job "j" will NEVER fire']);
    assert.deepEqual(err.written, ['[scheduler] job "j" will NEVER fire\n']);
  });

  test('stdout is tagged as stdout', () => {
    const { out, lines } = setup();
    out.stream.write('daemon ready\n');
    assert.deepEqual(lines, ['[stdout] daemon ready']);
  });

  test('the return value and the callback of the real write are kept', () => {
    const { err, bridge } = setup(false);
    let called = 0;
    assert.equal(err.stream.write('x\n', 'utf8', () => { called++; }), false);
    assert.equal(called, 1);
    bridge.restore();
  });

  test('a line is emitted once it is complete, however the writes are cut', () => {
    const { err, lines, bridge } = setup();
    err.stream.write('half a ');
    assert.deepEqual(lines, []);
    err.stream.write('line\nand two\nmore');
    assert.deepEqual(lines, ['[stderr] half a line', '[stderr] and two']);
    bridge.flush();
    assert.deepEqual(lines, ['[stderr] half a line', '[stderr] and two', '[stderr] more']);
  });

  test('a Buffer is decoded as UTF-8, a CRLF ends a line, empty lines and colour codes are dropped', () => {
    const { err, lines } = setup();
    err.stream.write(Buffer.from('café\r\n\n\u001b[31mred\u001b[0m\n'));
    assert.deepEqual(lines, ['[stderr] café', '[stderr] red']);
  });

  test('each stream keeps its own partial line', () => {
    const { out, err, lines } = setup();
    out.stream.write('out-');
    err.stream.write('err-');
    out.stream.write('1\n');
    err.stream.write('2\n');
    assert.deepEqual(lines, ['[stdout] out-1', '[stderr] err-2']);
  });

  test('a sink that throws never breaks the output', () => {
    const err = fakeStream();
    bridgeStdio([{ name: 'stderr', stream: err.stream }], () => { throw new Error('disk full'); });
    assert.doesNotThrow(() => err.stream.write('still printed\n'));
    assert.deepEqual(err.written, ['still printed\n']);
  });

  // DailyLogger reports its own write failure on stderr; without a guard that line would go back into the sink, fail
  // again, and write again for ever.
  test('a write made by the sink itself is not fed back into it', () => {
    const err = fakeStream();
    const lines = [];
    bridgeStdio([{ name: 'stderr', stream: err.stream }], (l) => { lines.push(l); err.stream.write('[DailyLogger] Write failed\n'); });
    err.stream.write('first\n');
    assert.deepEqual(lines, ['[stderr] first']);
    assert.deepEqual(err.written, ['first\n', '[DailyLogger] Write failed\n']);
  });

  test('a stream that never writes a newline does not grow without bound', () => {
    const { err, lines } = setup();
    err.stream.write('x'.repeat(70_000));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[stderr\] x+$/);
  });

  test('restore puts the original write back', () => {
    const err = fakeStream();
    const original = err.stream.write;
    const lines = [];
    const bridge = bridgeStdio([{ name: 'stderr', stream: err.stream }], (l) => lines.push(l));
    assert.notEqual(err.stream.write, original);
    bridge.restore();
    assert.equal(err.stream.write, original);
    err.stream.write('after\n');
    assert.deepEqual(lines, []);
  });

  test('the sink can be replaced once the real log exists', () => {
    const err = fakeStream();
    const early = [];
    const late = [];
    const bridge = bridgeStdio([{ name: 'stderr', stream: err.stream }], (l) => early.push(l));
    err.stream.write('before\n');
    bridge.setSink((l) => late.push(l));
    err.stream.write('after\n');
    assert.deepEqual(early, ['[stderr] before']);
    assert.deepEqual(late, ['[stderr] after']);
  });
});
