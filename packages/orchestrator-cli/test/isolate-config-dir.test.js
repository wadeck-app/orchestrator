'use strict';

// helpers/isolate-config-dir.js is preloaded by `npm test`. It must keep a test that starts a real daemon from
// touching the user's machine: the daemon registers its module with app-core at start, and a daemon given a
// throwaway config dir by a test registered a manifest inside that dir with the user's LIVE app-core. The dir
// was deleted by the test, and the dashboard lost its orchestrator tab ("the manifest ... does not exist").
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, 'helpers', 'isolate-config-dir.js');

function envAfterPreload(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const key of ['ORCH_CONFIG_DIR', 'APP_CORE_CONFIG_DIR']) {
    if (!(key in extraEnv)) {
      delete env[key];
    }
  }
  const script = 'process.stdout.write(JSON.stringify({ orch: process.env.ORCH_CONFIG_DIR, appCore: process.env.APP_CORE_CONFIG_DIR }))';
  const run = spawnSync(process.execPath, ['--require', HELPER, '-e', script], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, `preload failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

describe('the test preload', () => {
  test('points app-core at a folder that does not exist, so a daemon started by a test registers nothing', () => {
    const { appCore } = envAfterPreload();
    assert.ok(appCore, 'APP_CORE_CONFIG_DIR is not set: a daemon started by a test would use ~/.config/app-core');
    assert.equal(fs.existsSync(appCore), false, `${appCore} exists, so a daemon would find an app-core to register with`);
  });

  test('keeps an app-core folder chosen on purpose', () => {
    const { appCore } = envAfterPreload({ APP_CORE_CONFIG_DIR: 'C:\\somewhere\\chosen' });
    assert.equal(appCore, 'C:\\somewhere\\chosen');
  });

  test('keeps an orchestrator config dir chosen on purpose', () => {
    const { orch } = envAfterPreload({ ORCH_CONFIG_DIR: 'C:\\somewhere\\orch' });
    assert.equal(orch, 'C:\\somewhere\\orch');
  });
});
