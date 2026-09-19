'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { loadDaemonConfig } = require('../src/daemonConfig');

/*
 * config.yml had no test at all, and no way to tell the user it had failed to understand a line:
 * `catchUpStaggerSeconds: fve` parsed to NaN, went straight into a setTimeout, and the job fired
 * immediately with nothing said. A config file that is silently misread is worse than one that is
 * missing, because the user believes their setting is in force.
 */

const dirs = [];

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function withConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-daemon-config-'));
  dirs.push(dir);
  if (contents !== null) {
    fs.writeFileSync(path.join(dir, 'config.yml'), contents);
  }
  const warnings = [];
  const config = loadDaemonConfig(dir, (msg) => warnings.push(msg));
  return { config, warnings };
}

describe('defaults', () => {
  test('a missing config.yml yields every default, and says nothing about it', () => {
    const { config, warnings } = withConfig(null);
    assert.equal(config.autoUpdate, true);
    assert.equal(config.catchUpInitialDelaySeconds, 300);
    assert.equal(config.catchUpStaggerSeconds, 300);
    assert.equal(config.onceRetentionDays, 360);
    assert.equal(config.onceRetentionMaxJobs, 50);
    assert.deepEqual(warnings, [], 'an absent config file is normal, not a warning');
  });
});

describe('once retention keys', () => {
  test('both are read', () => {
    const { config, warnings } = withConfig('onceRetentionDays: 30\nonceRetentionMaxJobs: 5\n');
    assert.equal(config.onceRetentionDays, 30);
    assert.equal(config.onceRetentionMaxJobs, 5);
    assert.deepEqual(warnings, []);
  });

  test('zero is accepted -- it means "do not keep past once jobs at all"', () => {
    const { config, warnings } = withConfig('onceRetentionDays: 0\nonceRetentionMaxJobs: 0\n');
    assert.equal(config.onceRetentionDays, 0);
    assert.equal(config.onceRetentionMaxJobs, 0);
    assert.deepEqual(warnings, [], 'zero is a deliberate setting, not a mistake');
  });
});

describe('a value the parser cannot use is reported, not swallowed', () => {
  test('a non-numeric value warns, names the key and the fallback, and keeps the default', () => {
    const { config, warnings } = withConfig('onceRetentionDays: soon\n');
    assert.equal(config.onceRetentionDays, 360, 'a bad value became the setting');
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    assert.match(warnings[0], /onceRetentionDays/, 'the warning does not name the key');
    assert.match(warnings[0], /soon/, 'the warning does not quote what was found');
    assert.match(warnings[0], /360/, 'the warning does not say what was used instead');
  });

  test('a negative value is refused -- it would prune everything on the next firing', () => {
    const { config, warnings } = withConfig('onceRetentionMaxJobs: -1\n');
    assert.equal(config.onceRetentionMaxJobs, 50);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /onceRetentionMaxJobs/);
  });

  test('the pre-existing catch-up keys are held to the same standard', () => {
    const { config, warnings } = withConfig('catchUpStaggerSeconds: fve\n');
    assert.equal(config.catchUpStaggerSeconds, 300);
    assert.equal(warnings.length, 1, 'a NaN delay still went in silently');
  });

  test('an unknown key is reported -- a typo must not read as "not configured"', () => {
    const { warnings } = withConfig('onceRetentionDay: 30\n');
    assert.equal(warnings.length, 1, `expected the typo to be reported, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /onceRetentionDay/);
  });

  test('comments and blank lines are not keys', () => {
    const { warnings } = withConfig('# onceRetentionDays: 30\n\n   \nautoUpdate: false\n');
    assert.deepEqual(warnings, []);
  });

  test('loadDaemonConfig works without a warning callback, as callers that do not log may pass none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-daemon-config-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.yml'), 'onceRetentionDays: nope\n');
    const config = loadDaemonConfig(dir);
    assert.equal(config.onceRetentionDays, 360);
  });
});

describe('autoUpdate', () => {
  test('false is read as false and true as true', () => {
    assert.equal(withConfig('autoUpdate: false\n').config.autoUpdate, false);
    assert.equal(withConfig('autoUpdate: true\n').config.autoUpdate, true);
  });

  test('a value that is neither is reported rather than silently read as false', () => {
    const { config, warnings } = withConfig('autoUpdate: yes\n');
    assert.equal(config.autoUpdate, true, 'a typo turned auto-update off');
    assert.equal(warnings.length, 1, '"yes" was silently taken as false');
    assert.match(warnings[0], /autoUpdate/);
  });
});
