'use strict';

// A repo-built bundle (0.2.0, 0.0.0-dev) is older than every published CalVer, so the updater always found
// an "update" and ran a real `npm install -g` over the user's global install. An install killed halfway
// left the CLI uninstalled (incident 2026-10-24). A build that is not a published release must refuse.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isReleaseVersion, devBuildRefusalMessage } = require('../src/dev-build-guard');

describe('isReleaseVersion', () => {
  test('accepts the versions CI publishes, with or without a zero-padded day', () => {
    assert.equal(isReleaseVersion('2026.10.24-514-aac78c7a'), true);
    assert.equal(isReleaseVersion('2026.10.3-035-1e4adce3'), true);
    assert.equal(isReleaseVersion('2026.9.13-1000-b23303c8'), true);
  });

  test('refuses the placeholders a checkout carries', () => {
    for (const v of ['0.2.0', '0.0.0-dev', '0.0.0', '1.0.0']) {
      assert.equal(isReleaseVersion(v), false, v);
    }
  });

  test('refuses a CalVer-looking version that lacks the build number or the commit hash', () => {
    for (const v of ['2026.10.24', '2026.10.24-514', '2026.10.24-514-AAC78C7A', '2026.10.24-514-aac78c7', '2026.10.24-514-aac78c7a-local-dev', '2026.10.24-5-aac78c7a']) {
      assert.equal(isReleaseVersion(v), false, v);
    }
  });

  test('refuses a missing or non-string version instead of guessing', () => {
    for (const v of [undefined, null, '', 42, {}]) {
      assert.equal(isReleaseVersion(v), false, String(v));
    }
  });
});

describe('devBuildRefusalMessage', () => {
  test('names the version, says nothing was touched and what to do instead', () => {
    const msg = devBuildRefusalMessage('0.2.0');
    assert.match(msg, /this is a development build \(version 0\.2\.0\)/);
    assert.match(msg, /does not update the global install/);
    assert.match(msg, /run it from the repo or install the published package/);
    assert.match(msg, /npm install -g @wadeck-app\/orchestrator-cli/);
  });
});
