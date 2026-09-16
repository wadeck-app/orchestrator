'use strict';

// A dev daemon runs the checkout's build against its own config dir, and looked identical to the
// installed one: same white tray icon, and version 0.2.0 because that is the placeholder CI
// overwrites. Two identical icons for two different builds is how you read the wrong daemon's logs.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

function read(file) {
  return fs.readFileSync(path.join(SRC, file), 'utf8');
}

describe('dev instance is distinguishable', () => {
  // Asserted on the source: the wiring happens inside createDaemon, which a unit test cannot drive
  // without starting a real daemon and its tray.
  const index = read('index.ts');

  test('keys off an explicit env var, not the config path', () => {
    assert.match(index, /ORCH_DEV_INSTANCE/, 'no dev-instance signal at all');
    assert.ok(!/\.dev-config/.test(index),
      'the daemon infers dev mode from a path; it should be told, not guess');
  });

  test('suffixes the version it reports', () => {
    assert.match(index, /-local-dev/, 'no -local-dev suffix');
    // appVersion is the only field that reaches `orch status`: the kit writes its own `version`
    // after spreading versionExtra, so putting it there would have been a silent no-op.
    assert.match(index, /appVersion:\s*displayVersion/,
      'the suffix never reaches the daemon version endpoint');
  });

  test('tints the tray with a supported colour', () => {
    const { SUPPORTED_TRAY_COLORS } = require('../src/tray-icons');
    const match = /trayColor = isDevInstance \? '(#[0-9A-Fa-f]{6})'/.exec(index);
    assert.ok(match, 'no dev tray colour');
    const colour = match[1];
    assert.ok(SUPPORTED_TRAY_COLORS.includes(colour),
      `${colour} is not a generated colour, so getIcons would silently fall back to white`);
    assert.notEqual(colour.toUpperCase(), '#FFFFFF', 'the dev tray is the same white as the real one');
  });

  test('the dev colour has a full icon set, checking state included', () => {
    const { getIcons } = require('../src/tray-icons');
    const match = /trayColor = isDevInstance \? '(#[0-9A-Fa-f]{6})'/.exec(index);
    const set = getIcons(match[1]);
    for (const state of ['idle', 'error', 'running', 'success', 'checking']) {
      assert.ok(set[state], `dev colour has no ${state} icon`);
    }
    // And it really is a different image, not white under another name.
    const white = getIcons('#FFFFFF');
    assert.notEqual(set.idle, white.idle, 'the dev icon is byte-identical to the default');
  });
});

describe('the -local-dev suffix does not fake an update', () => {
  // A dev version can never equal what npm publishes, so the comparison has to ignore the marker
  // or the tray would claim an update was available forever.
  const trayManager = read('tray-manager.ts');

  test('the update comparison strips it', () => {
    assert.match(trayManager, /replace\(\/-local-dev\$\/, ''\)/,
      'check-update compares the suffixed version, so a dev tray always shows an update');
  });

  test('and still strips the git hash it stripped before', () => {
    assert.match(trayManager, /-\[0-9a-f\]\{6,8\}\$/, 'the git-hash normalisation was lost');
  });
});

describe('dev-server sets the signal', () => {
  test('so the daemon it starts is marked', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'dev-server.mjs'), 'utf8');
    assert.match(script, /ORCH_DEV_INSTANCE:\s*'1'/,
      'dev-server no longer marks its daemon; the tray would look like the installed one');
  });
});
