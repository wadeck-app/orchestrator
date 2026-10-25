'use strict';

// The updater entry runs `runUpdater` as a side effect of being loaded, so it is exercised the way it
// ships: as a child process. Run from a checkout it carries no CalVer (__ORCH_VERSION__ is only defined by
// the bundler), which is exactly the dev build the guard must stop before ANY npm call or config edit.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'updater', 'entry.ts');
const dirs = [];

function runEntry(extraEnv) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-updater-guard-'));
  dirs.push(configDir);
  const run = spawnSync(process.execPath, ['--require', require.resolve('tsx/cjs'), ENTRY], {
    env: { ...process.env, ORCH_CONFIG_DIR: configDir, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const logDir = path.join(configDir, 'logs');
  const logs = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => f.endsWith('.ndjson')).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n')
    : '';
  return { configDir, run, logs };
}

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('the updater entry refuses to run from a development build', () => {
  test('a background run logs why and exits 0 without touching the config or the state', () => {
    const { configDir, run, logs } = runEntry({});
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(logs, /this is a development build \(version 0\.0\.0-dev\): it does not update the global install/);
    assert.equal(fs.existsSync(path.join(configDir, 'update-state.json')), false);
  });

  test('an explicit run (UPDATER_FORCE) says it on stderr, exits 1 and leaves config.yml byte for byte', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-updater-guard-yml-'));
    dirs.push(configDir);
    const yml = 'autoUpdate: false\r\ncatchUpInitialDelaySeconds: 5\r\n';
    fs.writeFileSync(path.join(configDir, 'config.yml'), yml);
    const run = spawnSync(process.execPath, ['--require', require.resolve('tsx/cjs'), ENTRY], {
      env: { ...process.env, ORCH_CONFIG_DIR: configDir, UPDATER_FORCE: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    });
    assert.equal(run.status, 1, `stdout: ${run.stdout} stderr: ${run.stderr}`);
    assert.match(run.stderr, /this is a development build \(version 0\.0\.0-dev\)/);
    assert.equal(fs.readFileSync(path.join(configDir, 'config.yml'), 'utf8'), yml, 'config.yml was modified');
  });
});
