'use strict';

// The helpers behind the Node watchdog entry point (src/watchdog/runtime.ts) and the default start of `orch start` (watchdog, or the Go launcher with --launcher)
// (src/watchdog/launch.ts, platform-binary.ts findWatchdogEntry). Nothing here starts a daemon.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  configDirFromArgs, defaultConfigDir, resolveDaemonBundle, daemonEnv, daemonStdio, formatLogLine, createLogger, StopController,
} = require('../src/watchdog/runtime');
const { resolveStartMode, launcherFromEnv, watchdogSpawnSpec } = require('../src/watchdog/launch');
const { findWatchdogEntry } = require('../src/platform-binary');

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('configDirFromArgs (same rules as the Go launcher template)', () => {
  test('a positional argument, --config <dir> and --config=<dir>', () => {
    assert.equal(configDirFromArgs(['/a/b']), '/a/b');
    assert.equal(configDirFromArgs(['--config', '/a/b']), '/a/b');
    assert.equal(configDirFromArgs(['--config=/a/b']), '/a/b');
    assert.equal(configDirFromArgs(['--verbose', '/a/b']), '/a/b');
  });

  test('none given is null, so the caller can say it falls back to the default', () => {
    assert.equal(configDirFromArgs([]), null);
    assert.equal(configDirFromArgs(['--verbose']), null);
  });

  test('defaultConfigDir honours XDG_CONFIG_HOME', () => {
    assert.equal(defaultConfigDir({}, '/home/u'), path.join('/home/u', '.config', 'orchestrator'));
    assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: '/x' }, '/home/u'), path.join('/x', 'orchestrator'));
  });
});

describe('resolveDaemonBundle', () => {
  const exists = (...files) => (f) => files.includes(f);

  test('is dist/orchestrator.cjs next to the watchdog bundle', () => {
    const dir = path.join(path.sep, 'pkg', 'dist');
    assert.equal(resolveDaemonBundle({ env: {}, dir, isFile: exists(path.join(dir, 'orchestrator.cjs')) }), path.join(dir, 'orchestrator.cjs'));
  });

  test('a missing bundle says where it looked and how to reinstall', () => {
    const dir = path.join(path.sep, 'pkg', 'dist');
    assert.throws(() => resolveDaemonBundle({ env: {}, dir, isFile: exists() }), (e) => e.message.includes(path.join(dir, 'orchestrator.cjs')) && e.message.includes('npm install -g @wadeck-app/orchestrator-cli'));
  });

  test('LAUNCHER_BUNDLE_OVERRIDE wins when it is a file, and is an error when it is not (never ignored)', () => {
    const dir = path.join(path.sep, 'pkg', 'dist');
    assert.equal(resolveDaemonBundle({ env: { LAUNCHER_BUNDLE_OVERRIDE: '/x/daemon.cjs' }, dir, isFile: exists('/x/daemon.cjs') }), '/x/daemon.cjs');
    assert.throws(
      () => resolveDaemonBundle({ env: { LAUNCHER_BUNDLE_OVERRIDE: '/x/gone.cjs' }, dir, isFile: exists(path.join(dir, 'orchestrator.cjs')) }),
      (e) => e.message.includes('/x/gone.cjs') && e.message.includes('unset it'),
    );
  });

  test('is looked up at each call: a file that appears later is found', () => {
    const dir = path.join(path.sep, 'pkg', 'dist');
    let present = false;
    const opts = { env: {}, dir, isFile: () => present };
    assert.throws(() => resolveDaemonBundle(opts));
    present = true;
    assert.equal(resolveDaemonBundle(opts), path.join(dir, 'orchestrator.cjs'));
  });
});

describe('daemonEnv', () => {
  test('names the config dir, and on Windows the watchdog pid', () => {
    const env = daemonEnv({ A: '1', ORCH_CONFIG_DIR: '/other' }, { configDir: '/cfg', platform: 'win32', watchdogPid: 77 });
    assert.equal(env.ORCH_CONFIG_DIR, '/cfg');
    assert.equal(env.ORCH_WATCHDOG_PID, '77');
    assert.equal(env.A, '1');
  });

  test('elsewhere an inherited ORCH_WATCHDOG_PID is removed: it would name another watchdog', () => {
    for (const platform of ['linux', 'darwin']) {
      const env = daemonEnv({ ORCH_WATCHDOG_PID: '5' }, { configDir: '/cfg', platform, watchdogPid: 77 });
      assert.equal('ORCH_WATCHDOG_PID' in env, false);
    }
  });

  test('does not modify the environment it is given', () => {
    const base = { A: '1' };
    daemonEnv(base, { configDir: '/cfg', platform: 'win32', watchdogPid: 1 });
    assert.deepEqual(base, { A: '1' });
  });
});

describe('daemonStdio', () => {
  test('is the watchdog\'s own when its three handles are usable, the null device when one is not', () => {
    assert.equal(daemonStdio(() => ({})), 'inherit');
    assert.equal(daemonStdio((fd) => { if (fd === 1) { throw new Error('EBADF'); } return {}; }), 'ignore');
  });
});

describe('log (same file, same line format as the Go launcher)', () => {
  const at = new Date(2026, 10, 22, 9, 5, 7);

  test('a line is [HH:MM:SS] [LEVEL padded to 5] [launcher] message', () => {
    assert.equal(formatLogLine(at, 'INFO', 'hello'), '[09:05:07] [ INFO] [launcher] hello\n');
    assert.equal(formatLogLine(at, 'WARN', 'w'), '[09:05:07] [ WARN] [launcher] w\n');
    assert.equal(formatLogLine(at, 'ERROR', 'e'), '[09:05:07] [ERROR] [launcher] e\n');
  });

  const io = (overrides = {}) => {
    const written = { files: {}, stderr: '' };
    return {
      written,
      io: {
        now: () => at,
        mkdirp: () => {},
        append: (file, text) => { written.files[file] = (written.files[file] ?? '') + text; },
        stderr: (text) => { written.stderr += text; },
        tmpdir: () => path.join(path.sep, 'tmp'),
        ...overrides,
      },
    };
  };

  test('goes to <configDir>/logs/YYYY-MM-DD-launcher.log and to stderr', () => {
    const { io: fake, written } = io();
    createLogger(path.join(path.sep, 'cfg'), fake).warn('careful');
    assert.deepEqual(Object.keys(written.files), [path.join(path.sep, 'cfg', 'logs', '2026-11-22-launcher.log')]);
    assert.equal(written.stderr, '[09:05:07] [ WARN] [launcher] careful\n');
  });

  test('falls back to a file in the temp dir, with the reason, when the log file cannot be written', () => {
    const { io: fake, written } = io({ append: (file, text) => { if (file.includes('launcher.log') && !file.includes('fallback')) { throw new Error('EACCES'); } written.files[file] = text; } });
    createLogger(path.join(path.sep, 'cfg'), fake).error('boom');
    const fallback = written.files[path.join(path.sep, 'tmp', 'orchestrator-launcher-fallback.log')];
    assert.ok(fallback.includes('openLogFile failed') && fallback.includes('EACCES') && fallback.includes('boom'), fallback);
    assert.ok(written.stderr.includes('boom'));
  });

  test('without a config dir the line goes to the fallback file', () => {
    const { io: fake, written } = io();
    createLogger(null, fake).info('x');
    assert.deepEqual(Object.keys(written.files), [path.join(path.sep, 'tmp', 'orchestrator-launcher-fallback.log')]);
  });

  test('the real io writes the daily file under a directory it creates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wd-log-'));
    dirs.push(dir);
    const configDir = path.join(dir, 'cfg');
    createLogger(configDir, { ...require('../src/watchdog/runtime').realLogIo, stderr: () => {} }).info('real line');
    const [file] = fs.readdirSync(path.join(configDir, 'logs'));
    assert.match(file, /^\d{4}-\d{2}-\d{2}-launcher\.log$/);
    assert.match(fs.readFileSync(path.join(configDir, 'logs', file), 'utf8'), /\[ INFO\] \[launcher\] real line\n$/);
  });
});

describe('StopController', () => {
  const log = () => {
    const lines = [];
    return { lines, log: { info: () => {}, warn: (m) => lines.push(m), error: () => {} } };
  };

  test('POSIX forwards the signal it received to the daemon and remembers the stop', () => {
    const { log: l, lines } = log();
    const stop = new StopController('linux', l);
    const sent = [];
    stop.attach({ pid: 5, kill: (sig) => { sent.push(sig); return true; } });
    stop.onSignal('SIGTERM');
    assert.deepEqual(sent, ['SIGTERM']);
    assert.equal(stop.stopRequested, true);
    assert.deepEqual(lines, []);
  });

  test('Windows cannot forward: the daemon is not touched, the stop is remembered, the warning names orch stop', () => {
    const { log: l, lines } = log();
    const stop = new StopController('win32', l);
    stop.attach({ pid: 5, kill: () => { throw new Error('must not be called'); } });
    stop.onSignal('SIGINT');
    assert.equal(stop.stopRequested, true);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('orch stop') && lines[0].includes('SIGINT'), lines[0]);
  });

  test('a forward that fails is warned with the cause', () => {
    const { log: l, lines } = log();
    const stop = new StopController('linux', l);
    stop.attach({ pid: 5, kill: () => { throw new Error('EPERM'); } });
    stop.onSignal('SIGTERM');
    assert.match(lines[0], /could not forward the SIGTERM signal.*EPERM/);
    stop.attach({ pid: 5, kill: () => false });
    stop.onSignal('SIGTERM');
    assert.match(lines[1], /already gone/);
  });

  test('a signal with no daemon running only records the stop', () => {
    const { log: l, lines } = log();
    const stop = new StopController('linux', l);
    stop.onSignal('SIGINT');
    assert.equal(stop.stopRequested, true);
    assert.deepEqual(lines, []);
  });

  test('sleep returns false when the delay elapses, and no timer is left behind', async () => {
    const stop = new StopController('linux', log().log);
    const start = Date.now();
    assert.equal(await stop.sleep(30), false);
    assert.ok(Date.now() - start >= 25);
  });

  test('sleep returns true as soon as a stop is requested, and at once when it already was', async () => {
    const stop = new StopController('linux', log().log);
    const sleeping = stop.sleep(60_000);
    stop.onSignal('SIGTERM');
    assert.equal(await sleeping, true);
    assert.equal(await stop.sleep(60_000), true);
  });
});

describe('orch start: the watchdog is the default, the Go launcher an explicit fallback', () => {
  const mode = (over = {}) => resolveStartMode({ launcherFlag: false, watchdogFlag: false, env: {}, ...over });

  test('nothing asked: the watchdog, no note', () => {
    assert.deepEqual(mode(), { launcher: false, notes: [] });
    assert.deepEqual(mode({ env: { ORCH_LAUNCHER: '' } }), { launcher: false, notes: [] });
  });

  test('--launcher or ORCH_LAUNCHER=go picks the Go launcher; nothing else does', () => {
    assert.equal(mode({ launcherFlag: true }).launcher, true);
    assert.equal(mode({ env: { ORCH_LAUNCHER: 'go' } }).launcher, true);
    assert.equal(launcherFromEnv({}), false);
  });

  test('any other value of ORCH_LAUNCHER fails loudly instead of choosing a launcher by guess', () => {
    for (const bad of ['1', 'true', 'GO', 'node', 'watchdog']) {
      assert.throws(() => mode({ env: { ORCH_LAUNCHER: bad } }), (e) => e.message.includes('ORCH_LAUNCHER') && e.message.includes(bad) && e.message.includes('=go'));
    }
  });

  test('--watchdog and ORCH_WATCHDOG (first release) are ignored with a one-line note each', () => {
    const flag = mode({ watchdogFlag: true });
    assert.equal(flag.launcher, false);
    assert.equal(flag.notes.length, 1);
    assert.match(flag.notes[0], /--watchdog is deprecated and ignored.*--launcher/);
    for (const value of ['1', '0', 'yes']) {
      const env = mode({ env: { ORCH_WATCHDOG: value } });
      assert.equal(env.launcher, false);
      assert.equal(env.notes.length, 1);
      assert.match(env.notes[0], /ORCH_WATCHDOG is deprecated and ignored.*ORCH_LAUNCHER=go/);
    }
    assert.equal(mode({ env: { ORCH_WATCHDOG: '' } }).notes.length, 0);
  });

  test('asking for the watchdog and the launcher together is an error that names both', () => {
    assert.throws(() => mode({ watchdogFlag: true, launcherFlag: true }), /--watchdog and --launcher contradict/);
    assert.throws(() => mode({ watchdogFlag: true, env: { ORCH_LAUNCHER: 'go' } }), /--watchdog and ORCH_LAUNCHER=go contradict/);
    assert.throws(() => mode({ launcherFlag: true, env: { ORCH_WATCHDOG: '1' } }), /ORCH_WATCHDOG=1 and --launcher contradict/);
    // ORCH_WATCHDOG=0 never asked for a watchdog: with --launcher it is only a note.
    assert.deepEqual(mode({ launcherFlag: true, env: { ORCH_WATCHDOG: '0' } }).launcher, true);
  });

  test('the spawn is detached, hidden, with no stdio, on this node and the config dir; inherited overrides are stripped', () => {
    const spec = watchdogSpawnSpec({
      execPath: '/node', watchdogPath: '/dist/orchestrator-watchdog.cjs', configDir: '/cfg',
      env: { PATH: 'p', LAUNCHER_BUNDLE_OVERRIDE: '/old/orchestrator.cjs', ORCH_WATCHDOG_PID: '12', ORCH_CONFIG_DIR: '/other' },
    });
    assert.equal(spec.command, '/node');
    assert.deepEqual(spec.args, ['/dist/orchestrator-watchdog.cjs', '/cfg']);
    assert.equal(spec.options.detached, true);
    assert.equal(spec.options.windowsHide, true);
    assert.equal(spec.options.stdio, 'ignore');
    assert.deepEqual(spec.options.env, { PATH: 'p', ORCH_CONFIG_DIR: '/cfg' });
  });

  test('findWatchdogEntry is the bundle next to the module, or null: never a guess', () => {
    const found = findWatchdogEntry();
    assert.ok(found === null || path.basename(found) === 'orchestrator-watchdog.cjs');
    if (found !== null) {
      assert.ok(fs.existsSync(found));
    }
  });
});
