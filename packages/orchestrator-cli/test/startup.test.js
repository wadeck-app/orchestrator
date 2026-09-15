'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const {
  buildRegValueName,
  buildWindowsCommand,
  buildMacArgs,
  buildMacPlist,
  enableStartup,
  disableStartup,
  isStartupEnabled,
} = require('../src/startup');

const FAKE_DIR = 'C:\\Users\\Test\\.config\\orchestrator';
const INDEX_JS = path.join(__dirname, '..', 'src', 'index.js');

describe('buildRegValueName', () => {
  test('includes configDir in value name', () => {
    const name = buildRegValueName(FAKE_DIR);
    assert.ok(name.includes(FAKE_DIR), `expected "${FAKE_DIR}" in "${name}"`);
    assert.ok(name.startsWith('Orchestrator ('), `expected prefix "Orchestrator ("`);
  });

  test('different configDirs produce different value names', () => {
    assert.notEqual(buildRegValueName('C:\\a'), buildRegValueName('C:\\b'));
  });
});

// Both builders now REQUIRE the Go launcher and throw without it. The node fallback these
// tests used to cover was removed deliberately: registering node + the bundle produces a daemon
// with no supervisor, so nothing would restart it after an update, and nothing said so. The
// launcher is absent on any host that is not a published target, which is what CI runs on.
const { findLauncherBinary } = require('../src/platform-binary');
const hasLauncher = findLauncherBinary() !== null;

describe('buildWindowsCommand', () => {
  test('two quoted segments, launcher then configDir', () => {
    if (!hasLauncher) {
      assert.throws(() => buildWindowsCommand(FAKE_DIR), /no launcher binary/);
      return;
    }
    const cmd = buildWindowsCommand(FAKE_DIR);
    assert.ok(cmd.includes(FAKE_DIR), 'expected configDir in the command');
    assert.match(cmd, /^"[^"]+" "[^"]+"$/, `expected exactly two quoted segments, got: ${cmd}`);
    assert.ok(!cmd.includes(process.execPath), 'must not fall back to node + bundle');
  });
});

describe('buildMacArgs', () => {
  test('exactly [launcher, configDir]', () => {
    if (!hasLauncher) {
      assert.throws(() => buildMacArgs(FAKE_DIR), /no launcher binary/);
      return;
    }
    const args = buildMacArgs(FAKE_DIR);
    assert.equal(args.length, 2, `expected [launcher, configDir], got ${JSON.stringify(args)}`);
    assert.equal(args[1], FAKE_DIR);
    assert.notEqual(args[0], process.execPath, 'must not fall back to node + bundle');
  });
});

describe('buildMacPlist', () => {
  test('contains orchestrator label', () => {
    const plist = buildMacPlist([process.execPath, INDEX_JS, FAKE_DIR], FAKE_DIR);
    assert.ok(plist.includes('com.wadeck.orchestrator'), 'expected orchestrator label');
  });

  test('contains RunAtLoad true', () => {
    const plist = buildMacPlist([process.execPath, INDEX_JS, FAKE_DIR], FAKE_DIR);
    assert.ok(plist.includes('<key>RunAtLoad</key>'), 'expected RunAtLoad key');
    assert.ok(plist.includes('<true/>'), 'expected true value');
  });

  test('contains ORCH_CONFIG_DIR environment variable', () => {
    const plist = buildMacPlist([process.execPath, INDEX_JS, FAKE_DIR], FAKE_DIR);
    assert.ok(plist.includes('ORCH_CONFIG_DIR'), 'expected ORCH_CONFIG_DIR in plist');
  });

  test('contains all program arguments', () => {
    const args  = [process.execPath, INDEX_JS, FAKE_DIR];
    const plist = buildMacPlist(args, FAKE_DIR);
    for (const arg of args) {
      assert.ok(plist.includes(arg.replace(/&/g, '&amp;').replace(/</g, '&lt;')),
        `expected arg "${arg}" in plist`);
    }
  });
});

describe('enableStartup on unsupported platform', () => {
  test('returns ok:false on non-Windows non-macOS', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      // Skip: we ARE on a supported platform, can't easily test this without mocking platform
      return;
    }
    const result = enableStartup(FAKE_DIR);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes(process.platform));
  });
});
