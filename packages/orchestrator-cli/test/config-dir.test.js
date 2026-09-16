'use strict';

// Guards the trap that made this session overwrite the user's live daemon: the daemon accepted only
// ORCH_CONFIG_DIR and dropped --config-dir in silence, while dashboard-manager passes that very flag
// to orch-server. Asserted against the real daemon bundle, not a helper, because the defect was in
// how the entry point resolved its own configuration.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Prefers the bundle, falls back to the tsc output. CI's build-and-test job compiles but
// deliberately does not bundle, so requiring the bundle here failed all three legs -- the same
// mistake I had already made with the entry-points self-check earlier today, in a fix whose own
// comment states that build-and-test does not bundle. Both entries run the same argv resolution,
// which is what these tests are about.
const DAEMON_CANDIDATES = [
  path.join(__dirname, '..', 'dist', 'orchestrator.cjs'),
  path.join(__dirname, '..', 'dist', 'index.js'),
];
const DAEMON = DAEMON_CANDIDATES.find((p) => fs.existsSync(p));
const tmpDirs = [];

function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-cfgdir-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** True once the daemon has written its pre-start marker, which names the directory it chose. */
function hasDaemonLog(dir) {
  const logDir = path.join(dir, 'logs', 'daemon');
  if (!fs.existsSync(logDir)) return false;
  return fs.readdirSync(logDir).some((f) => f.startsWith('daemon-') && f.endsWith('.log'));
}

/**
 * Starts the daemon, waits for it to reveal its chosen directory, then stops it.
 *
 * Waits on the condition rather than on a fixed timeout: the daemon never exits on its own, so a
 * timeout would cost seconds per case and, worse, would pass a slow start off as a wrong directory.
 */
async function daemonChose(dir, args, env = {}, timeoutMs = 8000) {
  const child = spawn(process.execPath, [DAEMON, ...args], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (hasDaemonLog(dir)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  } finally {
    if (child.pid !== undefined) {
      // The daemon spawns a tray and possibly a dashboard, so the whole tree has to go.
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        } catch { /* already gone */ }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
  }
}

describe('daemon config dir resolution', () => {
  if (DAEMON === undefined) {
    // Not a skip: with no entry at all this file would assert nothing while appearing to pass.
    throw new Error(
      `no daemon entry found, looked for:\n  ${DAEMON_CANDIDATES.join('\n  ')}\n`
      + 'run: npm run build --workspace=packages/orchestrator-cli',
    );
  }

  test('--config-dir wins over ORCH_CONFIG_DIR instead of being ignored', async () => {
    const chosen = tmpDir('argv');
    const decoy = tmpDir('decoy');
    assert.equal(await daemonChose(chosen, ['--config-dir', chosen], { ORCH_CONFIG_DIR: decoy }), true,
      `daemon did not use --config-dir ${chosen}`);
    assert.equal(hasDaemonLog(decoy), false,
      'daemon wrote into ORCH_CONFIG_DIR despite an explicit --config-dir');
  });

  test('--config-dir=<path> form works too', async () => {
    const chosen = tmpDir('equals');
    assert.equal(await daemonChose(chosen, [`--config-dir=${chosen}`]), true,
      `daemon did not use --config-dir=${chosen}`);
  });

  test('ORCH_CONFIG_DIR still works, since start-at-login depends on it', async () => {
    const chosen = tmpDir('env');
    assert.equal(await daemonChose(chosen, [], { ORCH_CONFIG_DIR: chosen }), true,
      `daemon did not use ORCH_CONFIG_DIR ${chosen}`);
  });

  test('a --config-dir with no value is a usage error, not a fallback to the real dir', () => {
    const res = spawnSync(process.execPath, [DAEMON, '--config-dir'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}`);
    assert.match(res.stderr, /--config-dir requires a path/,
      `expected an actionable message, got: ${JSON.stringify(res.stderr)}`);
  });
});

// Keeps the flag the daemon reads and the flag the dashboard is given from drifting apart again.
describe('config dir flag is consistent across processes', () => {
  test('dashboard-manager passes the same flag name the daemon accepts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard-manager.ts'), 'utf8');
    assert.match(src, /'--config-dir'/, 'dashboard-manager no longer passes --config-dir');
    const entry = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    assert.match(entry, /'--config-dir'/, 'the daemon no longer reads --config-dir');
  });
});
