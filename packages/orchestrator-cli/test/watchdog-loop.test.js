'use strict';

// The supervision loop of the Node watchdog (src/watchdog/watchdog.ts), port of crashrestart_test.go and the sentinel tests of
// launcher_test.go. The daemon, the clock and the sleep are injected: no process is started and no test waits. The files
// (sentinel, crash marker, pid file) are real, in a throwaway directory.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { superviseDaemon } = require('../src/watchdog/watchdog');
const { DEFAULT_CRASH_POLICY } = require('../src/watchdog/policy');
const { realFs, createPidFile } = require('../src/watchdog/runtime');

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const mkdir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wd-loop-'));
  dirs.push(dir);
  return dir;
};

const CLOCK_START = Date.UTC(2026, 9, 25);
const crash = (code) => ({ code });
const clean = () => ({ code: 0 });
const signalled = (code) => ({ code, signalled: true });

/**
 * A scripted daemon. `exits` is consumed in order; a start beyond the plan is recorded in `overrun` (and ends with 0, so the
 * loop terminates): every test asserts `overrun === false`, which is how "restarts without bound" is caught.
 */
function harness(exits, opts = {}) {
  const configDir = opts.configDir ?? mkdir();
  const h = {
    configDir,
    clock: CLOCK_START,
    runTime: opts.runTime ?? 60_000,
    runs: 0,
    overrun: false,
    sleeps: [],
    bundlesStarted: [],
    logs: { info: [], warn: [], error: [] },
    pidFileWrites: 0,
    pidFileRemoves: 0,
    // Called inside the nth run (0-based): where the daemon would write its own files.
    duringRun: opts.duringRun,
    // The nth sleep (1-based) is cut short by a stop signal; 0 = never.
    interruptSleep: opts.interruptSleep ?? 0,
  };
  const bundles = opts.bundles ?? (() => path.join(configDir, 'orchestrator.cjs'));
  const deps = {
    fs: opts.fs ?? realFs,
    log: {
      info: (m) => h.logs.info.push(m),
      warn: (m) => h.logs.warn.push(m),
      error: (m) => h.logs.error.push(m),
    },
    now: () => h.clock,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      h.clock += ms;
      return h.interruptSleep !== 0 && h.sleeps.length === h.interruptSleep;
    },
    resolveBundle: () => bundles(h.runs),
    startDaemon: opts.startDaemon ?? (async (bundle) => {
      h.bundlesStarted.push(bundle);
      const run = h.runs++;
      const plan = exits[run];
      if (plan === undefined) {
        h.overrun = true;
      }
      h.clock += h.runTime;
      h.duringRun?.(run, h.clock);
      const exit = plan ?? clean();
      return { pid: 4242 + run, exited: Promise.resolve({ code: exit.code }), wasSignalled: () => exit.signalled === true };
    }),
    pidFile: opts.pidFile ?? { write: () => { h.pidFileWrites++; }, remove: () => { h.pidFileRemoves++; } },
    nodePath: process.execPath,
    pid: 999,
  };
  h.run = async (policy = DEFAULT_CRASH_POLICY) => {
    h.code = await superviseDaemon({ configDir, policy, startCommand: 'orch start' }, deps);
    assert.equal(h.overrun, false, `the loop started the daemon a ${h.runs}th time, only ${exits.length} runs were planned: it restarts without bound`);
    return h.code;
  };
  h.all = () => [...h.logs.info, ...h.logs.warn, ...h.logs.error].join('\n');
  return h;
}

const markerPath = (h) => path.join(h.configDir, 'crashed.json');
const readMarker = (h) => fs.readFileSync(markerPath(h), 'utf8');
const writeMarker = (h, body) => fs.writeFileSync(markerPath(h), body);
const DAEMON_MARKER = '{"time":"2026-10-25T00:00:30Z","kind":"uncaughtException","error":"the real cause","version":"1","pid":1}';
const sentinel = (h) => path.join(h.configDir, 'config.restart');

describe('a daemon that stops', () => {
  test('exit 0 without sentinel ends the watchdog with 0, no restart, no delay', async () => {
    const h = harness([clean()]);
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 1);
    assert.deepEqual(h.sleeps, []);
    assert.match(h.all(), /Exiting cleanly/);
  });

  test('exit 0 with config.restart starts the daemon again without delay, deletes the sentinel, and is not a crash', async () => {
    const h = harness([clean(), clean()], { duringRun: (run) => { if (run === 0) { fs.writeFileSync(sentinel(h), '1'); } } });
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 2);
    assert.deepEqual(h.sleeps, []);
    assert.equal(fs.existsSync(sentinel(h)), false, 'the sentinel must be consumed or the next stop would restart again');
    assert.doesNotMatch(h.all(), /crashed/);
    assert.match(h.all(), /restart sentinel detected/);
    assert.equal(fs.existsSync(markerPath(h)), false);
  });

  test('a restart sentinel is consumed once: the second clean exit ends the watchdog', async () => {
    const h = harness([clean(), clean(), clean()], { duringRun: (run) => { if (run === 0) { fs.writeFileSync(sentinel(h), '1'); } } });
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 2, 'a sentinel that is not deleted restarts the daemon for ever');
  });

  test('a sentinel that cannot be removed is not a restart, and the warning says what to do', async () => {
    const failingRemove = { ...realFs, remove: () => { throw new Error('EBUSY: resource busy'); } };
    const h = harness([clean()], { fs: failingRemove, duringRun: () => { fs.writeFileSync(sentinel(h), '1'); } });
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 1);
    const warn = h.logs.warn.join('\n');
    assert.ok(warn.includes('could not remove') && warn.includes(sentinel(h)) && warn.includes('orch start'), warn);
  });

  test('a sentinel that cannot be read is warned, not a restart', async () => {
    const failingExists = { ...realFs, exists: () => { throw new Error('EACCES: permission denied'); } };
    const h = harness([clean()], { fs: failingExists });
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 1);
    assert.match(h.logs.warn.join('\n'), /Could not read restart sentinel .*EACCES/);
  });

  test('a clean stop leaves no crash marker', async () => {
    const h = harness([clean()]);
    await h.run();
    assert.equal(fs.existsSync(markerPath(h)), false);
  });

  test('a stop signal together with a restart request: the stop wins, the sentinel is consumed', async () => {
    const h = harness([signalled(0)], { duringRun: () => { fs.writeFileSync(sentinel(h), '1'); } });
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 1);
    assert.equal(fs.existsSync(sentinel(h)), false);
  });
});

describe('a daemon that crashes', () => {
  test('is restarted after 2s, 10s, 30s, and a clean exit then ends the watchdog with 0', async () => {
    const h = harness([crash(1), crash(1), crash(1), clean()]);
    assert.equal(await h.run(), 0);
    assert.deepEqual(h.sleeps, [2000, 10000, 30000]);
    assert.equal(h.runs, 4);
  });

  test('the fourth crash inside the window is not restarted: ERROR with the log dir and the command, exit with its code', async () => {
    const h = harness([crash(1), crash(1), crash(1), crash(7)], { runTime: 10_000 });
    assert.equal(await h.run(), 7);
    assert.equal(h.runs, 4);
    assert.equal(h.sleeps.length, 3);
    const errors = h.logs.error.join('\n');
    for (const want of ['daemon crashed 4 times in 10 minutes, not restarting', path.join(h.configDir, 'logs'), 'then run orch start']) {
      assert.ok(errors.includes(want), `missing ${want} in the ERROR lines:\n${errors}`);
    }
  });

  test('every crash and every restart is a log line with the exit code', async () => {
    const h = harness([crash(1), crash(3), clean()]);
    await h.run();
    for (const want of [
      'daemon crashed: node exited with code 1',
      'daemon crashed: node exited with code 3',
      'restarting in 2s (crash 1 of 3 allowed in 10 minutes)',
      'restarting in 10s (crash 2 of 3 allowed in 10 minutes)',
    ]) {
      assert.ok(h.all().includes(want), `missing ${want} in:\n${h.all()}`);
    }
    assert.ok(h.logs.error.some((l) => l.startsWith('daemon crashed:')), 'a crash is an ERROR line');
  });

  test('crashes outside the window never accumulate: a daemon that crashes every 11 minutes is restarted every time, after 2s', async () => {
    const h = harness([crash(1), crash(1), crash(1), crash(1), crash(1), crash(1), clean()], { runTime: 11 * 60_000 });
    assert.equal(await h.run(), 0);
    assert.equal(h.runs, 7);
    assert.ok(h.sleeps.every((d) => d === 2000), String(h.sleeps));
  });

  test('a custom policy gives up after its own maximum, reusing the last delay, and names its own window', async () => {
    const h = harness([crash(1), crash(1), crash(1)], { runTime: 1000 });
    const policy = { delaysMs: [1000], maxRestarts: 2, windowMs: 60_000 };
    assert.equal(await h.run(policy), 1);
    assert.equal(h.runs, 3);
    assert.deepEqual(h.sleeps, [1000, 1000]);
    assert.match(h.all(), /daemon crashed 3 times in 1 minute, not restarting/);
  });

  test('a daemon killed by a signal nobody forwarded (code -1) is a crash, is restarted, and the log explains it', async () => {
    const h = harness([crash(-1), clean()]);
    assert.equal(await h.run(), 0);
    assert.deepEqual(h.sleeps, [2000]);
    for (const want of ['code -1', 'killed by a signal or forcibly terminated', 'OOM']) {
      assert.ok(h.all().includes(want), `the log must explain a -1 exit, lacks ${want}`);
    }
    assert.ok(readMarker(h).includes('killed by a signal or forcibly terminated'));
  });

  test('a failure after a stop signal is an intentional stop whatever the code (1, 143, -1): no restart, not a crash', async () => {
    for (const code of [1, 143, -1]) {
      const h = harness([signalled(code)]);
      assert.equal(await h.run(), code);
      assert.equal(h.runs, 1);
      assert.deepEqual(h.sleeps, []);
      assert.doesNotMatch(h.all(), /crashed/);
      assert.equal(fs.existsSync(markerPath(h)), false);
    }
  });

  test('a stop signal during the back-off ends the watchdog with the code of the crash, once in the log, without restarting', async () => {
    const h = harness([crash(7), crash(7)], { interruptSleep: 1 });
    assert.equal(await h.run(), 7);
    assert.equal(h.runs, 1);
    const lines = h.logs.warn.filter((l) => l.includes('stop signal received while waiting to restart'));
    assert.equal(lines.length, 1, h.all());
    assert.ok(lines[0].includes('not restarting'));
  });
});

describe('crash marker (crashed.json)', () => {
  test('is written for the status command with time, kind, source, error, version and pid, carrying the exit code', async () => {
    const h = harness([crash(9), clean()]);
    await h.run();
    const marker = JSON.parse(readMarker(h));
    for (const key of ['time', 'kind', 'source', 'error', 'version', 'pid']) {
      assert.ok(key in marker, `marker lacks ${key}: ${JSON.stringify(marker)}`);
    }
    assert.equal(marker.source, 'launcher');
    assert.equal(marker.pid, 4242);
    assert.match(marker.error, /code 9/);
    assert.ok(!Number.isNaN(Date.parse(marker.time)));
  });

  test('a marker the daemon wrote is never overwritten (O_EXCL)', async () => {
    const h = harness([crash(1), clean()]);
    writeMarker(h, DAEMON_MARKER);
    await h.run();
    assert.equal(readMarker(h), DAEMON_MARKER);
  });

  test('is created exclusively: a file that appears at the instant of the write is not replaced', async () => {
    // writeExclusive is the only creating call: a fs whose exclusive write reports EEXIST must lead to a read, not to a plain write.
    const calls = [];
    const racing = {
      ...realFs,
      writeExclusive: (file) => {
        calls.push('exclusive');
        fs.writeFileSync(file, DAEMON_MARKER);
        const e = new Error('EEXIST');
        e.code = 'EEXIST';
        throw e;
      },
      writeFile: () => { calls.push('plain'); },
    };
    const h = harness([crash(1), clean()], { fs: racing });
    await h.run();
    assert.deepEqual(calls, ['exclusive']);
    assert.equal(readMarker(h), DAEMON_MARKER);
  });

  test('a later crash replaces the stale marker the watchdog wrote itself', async () => {
    const h = harness([crash(1), crash(5), clean()]);
    await h.run();
    const got = readMarker(h);
    assert.ok(got.includes('code 5') && !got.includes('code 1 '), got);
    assert.ok(got.includes('"source": "launcher"'), got);
  });

  test('a report the daemon wrote during the crashed run beats the stale marker of the previous crash', async () => {
    const h = harness([crash(1), crash(1), clean()], { duringRun: (run) => { if (run === 1) { writeMarker(h, DAEMON_MARKER); } } });
    await h.run();
    assert.equal(readMarker(h), DAEMON_MARKER);
  });

  test('a marker left by an earlier session is replaced by a new crash', async () => {
    const h = harness([crash(9), clean()]);
    writeMarker(h, '{"time":"2026-10-24T10:00:00Z","kind":"exit","source":"launcher","error":"node exited with code 2","version":"unknown","pid":1}');
    await h.run();
    assert.match(readMarker(h), /code 9/);
  });

  test('a launcher marker dated after the start of the crashed run is kept', async () => {
    const h = harness([crash(9), clean()]);
    const newer = '{"time":"2099-01-01T00:00:00Z","kind":"exit","source":"launcher","error":"node exited with code 2","version":"unknown","pid":1}';
    writeMarker(h, newer);
    await h.run();
    assert.equal(readMarker(h), newer);
  });

  test('an unparseable time on a launcher marker is treated as stale and replaced', async () => {
    const h = harness([crash(9), clean()]);
    writeMarker(h, '{"time":"not a time","kind":"exit","source":"launcher","error":"x","version":"unknown","pid":1}');
    await h.run();
    assert.match(readMarker(h), /code 9/);
  });

  test('a marker that is not valid JSON is left alone, with a warning that names the file and says to delete it', async () => {
    const h = harness([crash(9), clean()]);
    writeMarker(h, '{not json');
    await h.run();
    assert.equal(readMarker(h), '{not json');
    const warn = h.logs.warn.join('\n');
    assert.ok(warn.includes(markerPath(h)) && warn.includes('delete it'), warn);
  });

  test('a marker that cannot be written is a warning, never the end of the watchdog', async () => {
    const failing = { ...realFs, writeExclusive: () => { throw new Error('ENOSPC: no space left'); } };
    const h = harness([crash(9), clean()], { fs: failing });
    assert.equal(await h.run(), 0);
    assert.match(h.logs.warn.join('\n'), /could not write the crash marker .*ENOSPC/);
  });

  test('no temporary file is left behind when a marker is replaced', async () => {
    const h = harness([crash(1), crash(5), clean()]);
    await h.run();
    assert.equal(fs.existsSync(`${markerPath(h)}.tmp`), false);
  });
});

describe('what restarting cannot fix', () => {
  test('a bundle that cannot be found ends the watchdog with 1, no start, no restart, the error says what to do', async () => {
    const h = harness([], { bundles: () => { throw new Error('cannot find the daemon bundle X: reinstall with: npm install -g @wadeck-app/orchestrator-cli'); } });
    assert.equal(await h.run(), 1);
    assert.equal(h.runs, 0);
    assert.deepEqual(h.sleeps, []);
    assert.match(h.logs.error.join('\n'), /cannot find the daemon bundle X: reinstall with: npm install/);
  });

  test('a spawn failure ends the watchdog with 1 and is not restarted', async () => {
    let attempts = 0;
    const h = harness([], { startDaemon: async () => { attempts++; throw new Error('spawn node ENOENT'); } });
    assert.equal(await h.run(), 1);
    assert.equal(attempts, 1);
    assert.deepEqual(h.sleeps, []);
    const error = h.logs.error.join('\n');
    assert.ok(error.includes('spawn node ENOENT') && error.includes('reinstall with: npm install -g'), error);
    assert.equal(fs.existsSync(markerPath(h)), false, 'a daemon that never started did not crash');
  });

  test('a bundle that disappears after a restart request ends the watchdog with 1 (found at the next start)', async () => {
    const h = harness([clean()], {
      duringRun: () => { fs.writeFileSync(sentinel(h), '1'); },
      bundles: (run) => {
        if (run === 0) {
          return 'first.cjs';
        }
        throw new Error('bundle gone');
      },
    });
    assert.equal(await h.run(), 1);
    assert.equal(h.runs, 1);
  });
});

describe('the bundle is looked up at every start', () => {
  test('after a restart sentinel and after a crash the daemon starts on the bundle found at that moment (an update replaces the file)', async () => {
    const h = harness([clean(), crash(1), clean()], {
      duringRun: (run) => { if (run === 0) { fs.writeFileSync(sentinel(h), '1'); } },
      bundles: (run) => `bundle-v${run + 1}.cjs`,
    });
    assert.equal(await h.run(), 0);
    assert.deepEqual(h.bundlesStarted, ['bundle-v1.cjs', 'bundle-v2.cjs', 'bundle-v3.cjs']);
  });
});

describe('config.launcher-pid', () => {
  test('is written at every start and removed when the watchdog ends', async () => {
    const h = harness([crash(1), clean()]);
    await h.run();
    assert.equal(h.pidFileWrites, 2);
    assert.equal(h.pidFileRemoves, 1);
  });

  test('is removed even when the watchdog ends on an error', async () => {
    const h = harness([], { bundles: () => { throw new Error('no bundle'); } });
    await h.run();
    assert.equal(h.pidFileRemoves, 1);
  });

  test('a pid file that cannot be written is a warning, not the end', async () => {
    const h = harness([clean()], { pidFile: { write: () => { throw new Error('EACCES'); }, remove: () => {} } });
    assert.equal(await h.run(), 0);
    assert.match(h.logs.warn.join('\n'), /could not write launcher PID file: EACCES/);
  });

  test('the real pid file holds the pid in decimal without newline, and is removed only while it is still ours', () => {
    const dir = mkdir();
    const file = path.join(dir, 'config.launcher-pid');
    const mine = createPidFile(dir, 777);
    mine.write();
    assert.equal(fs.readFileSync(file, 'utf8'), '777');
    mine.remove();
    assert.equal(fs.existsSync(file), false);

    mine.write();
    fs.writeFileSync(file, '888');
    mine.remove();
    assert.equal(fs.readFileSync(file, 'utf8'), '888', 'the pid file of another launcher must not be removed');

    fs.rmSync(file);
    assert.doesNotThrow(() => mine.remove(), 'an absent file is not an error');
  });

  test('the log names both pids in the form the launcher e2e test reads', async () => {
    const h = harness([clean()]);
    await h.run();
    assert.ok(h.logs.info.includes('PIDs: launcher=999 node=4242'), h.all());
  });
});
