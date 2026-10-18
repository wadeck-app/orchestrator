'use strict';

// ci/scripts/signal-trace.cjs is CI evidence for the ubuntu runs where the whole `node --test` run is interrupted
// ("Interrupted while running", every file cancelled) and nothing says who signalled it. It must record the
// suspicious kills and the signal the runner receives, and change nothing else.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRELOAD = path.join(__dirname, '..', 'ci', 'scripts', 'signal-trace.cjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-signal-trace-'));
}

function runNode(args, { log, cwd }) {
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}` };
  delete env.SIGNAL_TRACE_LOG;
  if (log) {
    env.SIGNAL_TRACE_LOG = log;
  }
  return spawnSync(process.execPath, args, { env, cwd, encoding: 'utf8', timeout: 30_000 });
}

describe('signal-trace preload', () => {
  test('refuses to load without a log file, and says which variable to set', () => {
    const dir = scratch();
    const res = runNode(['-e', '0'], { cwd: dir });

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /SIGNAL_TRACE_LOG is not set/);
  });

  test('records a kill aimed at a process group, and the kill still behaves as it would have', () => {
    const dir = scratch();
    const log = path.join(dir, 'trace.log');
    const res = runNode(['-e', "try { process.kill(-999999, 'SIGTERM'); } catch (e) { console.log(e.code); }"], { log, cwd: dir });

    assert.equal(res.stdout.trim(), 'ESRCH', res.stderr);
    const written = fs.readFileSync(log, 'utf8');
    assert.match(written, /kill pid=-999999 sig=SIGTERM/);
    assert.match(written, /at /, 'the stack of the caller must be there');
  });

  test('says nothing about signal 0, which is a liveness check even when aimed at pid 0', () => {
    const dir = scratch();
    const log = path.join(dir, 'trace.log');
    // Signal 0 only checks existence: safe to send, and the preload must say nothing about it.
    const res = runNode(['-e', "process.kill(0, 0); console.log('alive')"], { log, cwd: dir });

    assert.equal(res.stdout.trim(), 'alive', res.stderr);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'signal 0 is a liveness check, not a kill');
  });

  test('says nothing about an ordinary kill of one of its own children', () => {
    const dir = scratch();
    const log = path.join(dir, 'trace.log');
    const script = [
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);",
      "c.once('exit', () => console.log('child ended'));",
      "setTimeout(() => process.kill(c.pid, 'SIGTERM'), 300);",
    ].join('');
    const res = runNode(['-e', script], { log, cwd: dir });

    assert.match(res.stdout, /child ended/, res.stderr);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '');
  });

  // Windows ends a process signalled with SIGTERM without running its handlers, so there is nothing to record there.
  test('the test runner that is signalled by one of its files writes who it was, with the process table', { skip: process.platform === 'win32' ? 'POSIX signals only: Windows runs no handler on SIGTERM' : false }, () => {
    const dir = scratch();
    const log = path.join(dir, 'trace.log');
    fs.writeFileSync(path.join(dir, 'killer.test.js'), [
      "const { test } = require('node:test');",
      "test('kills its runner', async () => {",
      "  process.kill(process.ppid, 'SIGTERM');",
      '  await new Promise((resolve) => setTimeout(resolve, 5000));',
      '});',
    ].join('\n'));
    runNode(['--test', 'killer.test.js'], { log, cwd: dir });

    const written = fs.readFileSync(log, 'utf8');
    assert.match(written, /kill pid=\d+ sig=SIGTERM \(its parent\)/, 'the file that sent it');
    assert.match(written, /received SIGTERM; process table:/, 'the runner that got it');
    assert.match(written, /PID\s+PPID/i, 'the process table follows');
  });
});
