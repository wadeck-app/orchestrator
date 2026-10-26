'use strict';

// The login entry is ONE per user on macOS (the LaunchAgent label) and on Linux (orchestrator.service), whatever the config dir.
// `orch uninstall` run for another config dir (a dev checkout with its own .dev-config, a second instance) used to remove it
// for the first one without a word. disableStartup now refuses, says whose entry it is, and removes nothing.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { disableStartup } = require('../src/startup');

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-disable-guard-'));
  dirs.push(dir);
  return dir;
}

function recorder() {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return Buffer.alloc(0); };
  return { calls, exec };
}

const plistFor = (configDir) => `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array><string>/opt/launcher</string><string>${configDir}</string></array></dict></plist>`;
const unitFor = (configDir) => `[Service]\nExecStart="/opt/launcher" "${configDir}"\nEnvironment="ORCH_CONFIG_DIR=${configDir}"\n\n[Install]\nWantedBy=default.target\n`;

describe('disableStartup on macOS', () => {
  test('removes the entry of this config dir', () => {
    const plistPath = path.join(tmp(), 'agent.plist');
    fs.writeFileSync(plistPath, plistFor('/cfg/a'));
    const { calls, exec } = recorder();
    const result = disableStartup('/cfg/a', { platform: 'darwin', plistPath, exec });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(plistPath), false);
    assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout'), JSON.stringify(calls));
  });

  test('refuses the entry of another config dir, removes nothing, and names the way out', () => {
    const plistPath = path.join(tmp(), 'agent.plist');
    fs.writeFileSync(plistPath, plistFor('/cfg/real'));
    const { calls, exec } = recorder();
    const result = disableStartup('/cfg/dev', { platform: 'darwin', plistPath, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /belongs to another config dir/);
    assert.ok(result.error.includes(plistPath), 'names the entry');
    assert.match(result.error, /ORCH_CONFIG_DIR/);
    assert.equal(fs.existsSync(plistPath), true, 'the entry is still there');
    assert.deepEqual(calls, [], 'launchctl was not called');
  });

  test('no entry at all is still "already off"', () => {
    const plistPath = path.join(tmp(), 'absent.plist');
    const { exec } = recorder();
    const result = disableStartup('/cfg/a', { platform: 'darwin', plistPath, exec });
    assert.equal(result.ok, true);
    assert.match(result.detail, /plist=already-absent/);
  });
});

describe('disableStartup on Linux', () => {
  test('refuses the unit of another config dir, removes nothing, and names the way out', () => {
    const unitPath = path.join(tmp(), 'orchestrator.service');
    fs.writeFileSync(unitPath, unitFor('/cfg/real'));
    const { calls, exec } = recorder();
    const result = disableStartup('/cfg/dev', { platform: 'linux', unitPath, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /belongs to another config dir/);
    assert.ok(result.error.includes(unitPath));
    assert.equal(fs.existsSync(unitPath), true);
    assert.deepEqual(calls, [], 'systemctl was not called');
  });

  test('removes the unit of this config dir', () => {
    const unitPath = path.join(tmp(), 'orchestrator.service');
    fs.writeFileSync(unitPath, unitFor('/cfg/a'));
    const { calls, exec } = recorder();
    const result = disableStartup('/cfg/a', { platform: 'linux', unitPath, exec });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(unitPath), false);
    assert.ok(calls.some((c) => c[0] === 'systemctl' && c.includes('disable')));
  });
});
