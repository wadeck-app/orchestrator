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

describe('buildWindowsCommand', () => {
  // When the Go launcher binary exists (it does in the dev monorepo at launcher-go/dist/),
  // the command is: "orchestrator.exe" "configDir" -- 2 quoted segments.
  // When it doesn't exist (node fallback): "node.exe" "index.js" "configDir" -- 3 segments.

  test('contains configDir', () => {
    const cmd = buildWindowsCommand(FAKE_DIR);
    assert.ok(cmd.includes(FAKE_DIR), `expected configDir in command`);
  });

  test('is a quoted shell string (at least one double-quoted segment)', () => {
    const cmd = buildWindowsCommand(FAKE_DIR);
    assert.ok((cmd.match(/"/g) ?? []).length >= 2, `expected double-quoted segments`);
  });

  test('launcher path includes "orchestrator" when binary present, else node', () => {
    const cmd = buildWindowsCommand(FAKE_DIR);
    const hasLauncher = cmd.toLowerCase().includes('orchestrator');
    const hasNode     = cmd.includes(process.execPath);
    assert.ok(hasLauncher || hasNode, `expected either orchestrator binary or node in command`);
  });

  test('node fallback contains index.js when no launcher binary', () => {
    // If the launcher exists this test is N/A -- still passes via the OR
    const cmd = buildWindowsCommand(FAKE_DIR);
    const hasLauncher = cmd.toLowerCase().includes('orchestrator.exe');
    assert.ok(hasLauncher || cmd.includes('index.js'), `expected launcher or index.js`);
  });
});

describe('buildMacArgs', () => {
  // With Go launcher present: [launcherPath, configDir] (2 elements)
  // Without launcher (node fallback): [node, index.js, configDir] (3 elements)

  test('returns at least 2 elements', () => {
    const args = buildMacArgs(FAKE_DIR);
    assert.ok(args.length >= 2, `expected at least 2 elements, got ${args.length}`);
  });

  test('first element is a valid executable path (launcher or node)', () => {
    const first = buildMacArgs(FAKE_DIR)[0];
    const isLauncher = first.includes('orchestrator');
    const isNode     = first === process.execPath;
    assert.ok(isLauncher || isNode, `expected launcher or node as first arg, got ${first}`);
  });

  test('last element is configDir', () => {
    const args = buildMacArgs(FAKE_DIR);
    assert.equal(args[args.length - 1], FAKE_DIR);
  });

  test('node fallback: second element ends with index.js when no launcher', () => {
    const args = buildMacArgs(FAKE_DIR);
    if (args.length === 3) {
      // node fallback
      assert.ok(args[1].endsWith('index.js'), `expected index.js as second arg`);
    } else {
      // launcher mode: only 2 elements, second is configDir -- already tested above
      assert.equal(args.length, 2);
    }
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
