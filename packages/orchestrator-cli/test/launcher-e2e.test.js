'use strict';

// The real Go launcher starting the real daemon, on whatever OS runs the suite (CI runs it on Windows, macOS and Linux).
// Everything else tests one half of this: the launcher's Go tests use a fake daemon, the daemon's tests have no launcher.
// What only this shows: the daemon starts under the launcher, what it prints survives although its stdio is the NUL device,
// a daemon that dies is started again, and a stop ends both for good.
//
// Mirrors how cli.ts starts it (launcher <configDir>, LAUNCHER_BUNDLE_OVERRIDE), with a throwaway config dir, no tray, and a
// throwaway HOME: macOS keeps ONE login agent for every config dir, and a daemon refreshes it at start.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { findLauncherBinary } = require('../src/platform-binary');
// The COMPILED module, as in platform-binary.test.js: findDaemonEntry() resolves relative to its own directory, so only the
// dist/ copy sees the layout that ships.
const { findDaemonEntry } = require('../dist/platform-binary.js');
const { killTree } = require('../src/process-tree');
const { createDaemonClient } = require('@wadeck-app/singleton-daemon-kit');

const launcher = findLauncherBinary();
if (launcher === null) {
  throw new Error('No launcher binary for this platform. Build it with: npm run build-launcher --workspace=packages/orchestrator-cli. This test does not skip: a skipped test would report a green run that exercised nothing.');
}
const bundle = findDaemonEntry();
if (bundle === null) {
  throw new Error('No daemon bundle. Build it with: npm run build --workspace=packages/orchestrator-cli. This test does not skip.');
}

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()();
  }
});

async function until(what, predicate, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

const readAll = (dir, pattern) => {
  try {
    return fs.readdirSync(dir).filter((f) => pattern.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  } catch {
    return '';
  }
};

test('the launcher starts the daemon, restarts it after a crash, and a stop ends both for good', { timeout: 180_000 }, async () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-home-'));
  cleanups.push(async () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const child = spawn(launcher, [dir], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, LAUNCHER_BUNDLE_OVERRIDE: bundle, ORCH_CONFIG_DIR: dir, ORCH_NO_TRAY: '1', HOME: home, USERPROFILE: home },
  });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  let launcherGone = false;
  void exited.then(() => { launcherGone = true; });
  cleanups.push(async () => { if (!launcherGone) { await killTree(child.pid); } });

  const client = createDaemonClient({ configDir: dir, commands: {} });
  // The last failure is kept and named if the wait times out: a daemon that never answers must say why.
  let lastError = 'no attempt yet';
  const version = async () => {
    try {
      return await client.version();
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  };
  // The daemon that counts is the launcher's own child, named in its log. "Whoever answers on the port" is not enough: the port of a
  // killed daemon is free, and a daemon of another test running at the same time (the files of the suite run in parallel) can
  // take it and answer with a different pid.
  const launcherChildPid = () => {
    const all = [...readAll(path.join(dir, 'logs'), /launcher\.log$/).matchAll(/PIDs: launcher=\d+ node=(\d+)/g)];
    return all.length === 0 ? null : Number(all[all.length - 1][1]);
  };
  const ownDaemon = async (notPid) => {
    const child = launcherChildPid();
    if (child === null || child === notPid) {
      return null;
    }
    const v = await version();
    return v !== null && v.pid === child ? v : null;
  };
  const waitFor = (what, predicate) => until(what, predicate).catch((e) => {
    throw new Error(`${e.message} (last error from the daemon: ${lastError}; launcher log: ${readAll(path.join(dir, 'logs'), /launcher\.log$/)})`);
  });

  // A failure names both logs: what happened between the launcher and the daemon is the whole point of this test.
  try {
  // 1. It starts.
  const first = await waitFor('the daemon to answer', () => ownDaemon(null));
  assert.equal(typeof first.pid, 'number');
  cleanups.push(async () => { try { process.kill(first.pid, 'SIGKILL'); } catch { /* gone */ } });

  // 2. What it prints survives: its stdio is the NUL device under the launcher.
  const appLogs = path.join(dir, 'logs', 'app');
  await until('the console output in the daemon log', () => /\[stdout\] \[orchestrator\] daemon ready/.test(readAll(appLogs, /^daemon-.*\.log$/)));

  // 3. A daemon that dies is started again, and says what happened.
  process.kill(first.pid, 'SIGKILL');
  const second = await waitFor('a new daemon of the launcher to answer', () => ownDaemon(first.pid));
  const launcherLog = readAll(path.join(dir, 'logs'), /launcher\.log$/);
  assert.match(launcherLog, /daemon crashed: .*\(crash 1 in the last 10 minutes\)/);
  assert.match(launcherLog, /restarting in 2s \(crash 1 of 3 allowed in 10 minutes\)/);
  await until('the new daemon to read the crash marker', () => /the previous daemon \(pid=\d+.*crashed at/.test(readAll(appLogs, /^daemon-.*\.log$/)));
  assert.equal(fs.existsSync(path.join(dir, 'crashed.json')), false, 'the new daemon clears the marker');

  // 4. A stop is not a crash: the launcher leaves, with 0, and nothing starts again.
  await client.send('quit');
  const { code } = await Promise.race([
    exited,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('the launcher did not exit after quit')), 60_000); }),
  ]);
  assert.equal(code, 0);
  assert.match(readAll(path.join(dir, 'logs'), /launcher\.log$/), /Exiting cleanly/);
  assert.notEqual(second.pid, first.pid);
  assert.doesNotMatch(readAll(path.join(dir, 'logs'), /launcher\.log$/), /crash 2 in the last/);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- launcher log ---\n${readAll(path.join(dir, 'logs'), /launcher\.log$/)}\n--- daemon log ---\n${readAll(path.join(dir, 'logs', 'app'), /^daemon-.*\.log$/)}`);
  }
});
