'use strict';

// What the daemon does with an error nobody caught.
//
// Policy: an uncaught exception or rejection is fatal (the daemon exits 1 after writing why), because carrying on in an
// unknown state is worse than a restart. ONE class is never fatal: the peer of a pipe or socket went away (EPIPE,
// ECONNRESET, ERR_STREAM_DESTROYED...). That is the other side's failure, the operation that hit it has already failed on
// its own, and nothing about the daemon's state is unknown. On 2026-10-25 the tray's pipe closed, the resulting EPIPE
// was uncaught, and the daemon exited and stayed down for 47 minutes.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  isPeerGoneError, isChildSpawnFailure, makeFatalHandler, guardStdio, readCrashMarker, clearCrashMarker, CRASH_MARKER_FILE,
} = require('../src/crash-guard');

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-crash-guard-'));
  dirs.push(dir);
  return dir;
}

function errno(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

function makeDeps(configDir) {
  const lines = [];
  const exits = [];
  let closed = 0;
  return {
    lines, exits,
    closedCount: () => closed,
    deps: {
      configDir, version: '1.2.3',
      log: (line) => lines.push(line),
      closeLog: () => { closed++; },
      exit: (code) => { exits.push(code); },
    },
  };
}

describe('isPeerGoneError', () => {
  for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ECONNABORTED']) {
    test(`${code} is a peer that went away`, () => {
      assert.equal(isPeerGoneError(errno(code)), true);
    });
  }
  for (const value of [errno('ENOENT'), errno('EACCES'), new Error('boom'), new TypeError('x'), 'EPIPE', null, undefined, { code: 'EPIPE' }]) {
    test(`${JSON.stringify(value instanceof Error ? value.code ?? value.message : value)} is not`, () => {
      assert.equal(isPeerGoneError(value), false);
    });
  }
});

describe('isChildSpawnFailure', () => {
  const spawnError = (code) => Object.assign(new Error(`spawn x ${code}`), { code, syscall: 'spawn x' });
  for (const code of ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EACCES', 'EPERM', 'ENOENT']) {
    test(`a failed spawn (${code}) is the child's failure, not the daemon's`, () => {
      assert.equal(isChildSpawnFailure(spawnError(code)), true);
    });
  }
  test('the same code from another syscall is not (a file the daemon needs is missing)', () => {
    assert.equal(isChildSpawnFailure(Object.assign(new Error('open'), { code: 'ENOENT', syscall: 'open' })), false);
    assert.equal(isChildSpawnFailure(Object.assign(new Error('x'), { code: 'ENOENT' })), false);
  });
  test('a spawn error with an unexpected code is not either', () => {
    assert.equal(isChildSpawnFailure(spawnError('EINVAL')), false);
  });
});

describe('makeFatalHandler', () => {
  test('a failed spawn nobody listened to (a library that starts a child without an error listener) is not fatal', () => {
    const { deps, lines, exits } = makeDeps(tmpDir());
    makeFatalHandler('uncaughtException', deps)(Object.assign(new Error('spawn node EAGAIN'), { code: 'EAGAIN', syscall: 'spawn node' }));
    assert.deepEqual(exits, []);
    assert.ok(lines.some((l) => /not fatal/.test(l) && /EAGAIN/.test(l)), lines.join(' | '));
  });

  for (const kind of ['uncaughtException', 'unhandledRejection']) {
    test(`${kind}: a peer that went away is logged and the daemon keeps running`, () => {
      const dir = tmpDir();
      const { deps, lines, exits, closedCount } = makeDeps(dir);
      makeFatalHandler(kind, deps)(errno('EPIPE', 'write EPIPE'));
      assert.deepEqual(exits, [], 'the daemon exited for a closed pipe');
      assert.equal(closedCount(), 0, 'the log must stay open: the daemon goes on');
      assert.equal(fs.existsSync(path.join(dir, CRASH_MARKER_FILE)), false, 'a non-crash left a crash marker');
      assert.ok(lines.some((l) => /not fatal/.test(l) && /EPIPE/.test(l)), lines.join(' | '));
    });

    test(`${kind}: any other error is fatal: logged with its stack, marked, log closed, exit 1`, () => {
      const dir = tmpDir();
      const { deps, lines, exits, closedCount } = makeDeps(dir);
      const err = new Error('the real bug');
      makeFatalHandler(kind, deps)(err);
      assert.deepEqual(exits, [1]);
      assert.equal(closedCount(), 1);
      assert.ok(lines.some((l) => l.startsWith(`daemon crash (${kind})`) && l.includes('the real bug')), lines.join(' | '));
      assert.ok(lines.some((l) => l.includes('crash-guard.test.js')), 'the stack is in the log');
      const marker = readCrashMarker(dir);
      assert.equal(marker.kind, kind);
      assert.equal(marker.error, 'the real bug');
      assert.equal(marker.version, '1.2.3');
      assert.equal(marker.pid, process.pid);
      assert.ok(!Number.isNaN(Date.parse(marker.time)));
    });
  }

  test('a rejection with a non-Error reason is fatal and readable', () => {
    const dir = tmpDir();
    const { deps, exits, lines } = makeDeps(dir);
    makeFatalHandler('unhandledRejection', deps)('just a string');
    assert.deepEqual(exits, [1]);
    assert.ok(lines.some((l) => l.includes('just a string')));
  });

  test('the log line is written before the exit', () => {
    const order = [];
    const dir = tmpDir();
    makeFatalHandler('uncaughtException', {
      configDir: dir, version: 'v',
      log: () => order.push('log'), closeLog: () => order.push('close'), exit: () => order.push('exit'),
    })(new Error('x'));
    assert.deepEqual(order.slice(0, 1), ['log']);
    assert.deepEqual(order.slice(-2), ['close', 'exit']);
  });

  test('a marker that cannot be written does not stop the exit, and is said', () => {
    const { deps, exits, lines } = makeDeps(path.join(tmpDir(), 'does', 'not', 'exist'));
    makeFatalHandler('uncaughtException', deps)(new Error('x'));
    assert.deepEqual(exits, [1]);
    assert.ok(lines.some((l) => /crash marker/.test(l)), lines.join(' | '));
  });
});

describe('crash marker', () => {
  test('readCrashMarker is null when there is none', () => {
    assert.equal(readCrashMarker(tmpDir()), null);
  });

  test('a marker that is not valid JSON is reported, not silently ignored', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, CRASH_MARKER_FILE), '{not json');
    assert.throws(() => readCrashMarker(dir), new RegExp(`${CRASH_MARKER_FILE}`));
  });

  test('clearCrashMarker removes it and tolerates its absence', () => {
    const dir = tmpDir();
    const { deps } = makeDeps(dir);
    makeFatalHandler('uncaughtException', deps)(new Error('x'));
    clearCrashMarker(dir);
    assert.equal(readCrashMarker(dir), null);
    assert.doesNotThrow(() => clearCrashMarker(dir));
  });
});

describe('guardStdio', () => {
  test('no error on a guarded stream throws, whatever its code', () => {
    const stream = new EventEmitter();
    const lines = [];
    guardStdio([{ name: 'stdout', stream }], (l) => lines.push(l));
    for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'EIO', 'EBADF', 'ENOTCONN']) {
      assert.doesNotThrow(() => stream.emit('error', errno(code)), code);
    }
  });

  test('each distinct error is logged once per stream', () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const lines = [];
    guardStdio([{ name: 'stdout', stream: out }, { name: 'stderr', stream: err }], (l) => lines.push(l));
    out.emit('error', errno('EPIPE'));
    out.emit('error', errno('EPIPE'));
    out.emit('error', errno('EIO'));
    err.emit('error', errno('EPIPE'));
    assert.equal(lines.length, 3, lines.join(' | '));
    assert.ok(lines.every((l) => /stdout|stderr/.test(l)));
  });
});
