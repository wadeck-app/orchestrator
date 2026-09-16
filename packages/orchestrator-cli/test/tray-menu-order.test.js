'use strict';

// The tray menu order had drifted from wdrive's with nothing asserting it: the separator sat
// between "Start at login" and "Restart", cutting the toggle off from the actions it belongs with.
// Locked here so the two trays cannot diverge silently again.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

function makeTrayManager(dashboardManager) {
  const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
  const state = { getAll: () => ({}) };
  const registry = { list: () => [] };
  return new TrayManager('/tmp/test-tray-order', scheduler, state, registry, '1.0.0', undefined, dashboardManager);
}

/** Ids in menu order, separators collapsed to the literal 'separator'. */
function shape(menu) {
  return menu.items.map((i) => (i.type === 'separator' ? 'separator' : i.id));
}

describe('tray menu layout', () => {
  test('the system group is Start at login, Restart, Quit with the divider above it', () => {
    const ids = shape(makeTrayManager()._buildMenu());
    const tail = ids.slice(-4);
    assert.deepEqual(tail, ['separator', 'startup-toggle', 'restart', 'quit'],
      `unexpected tail order: ${ids.join(' | ')}`);
  });

  test('no separator sits between Start at login and Restart', () => {
    const ids = shape(makeTrayManager()._buildMenu());
    const startup = ids.indexOf('startup-toggle');
    const restart = ids.indexOf('restart');
    assert.ok(startup !== -1 && restart !== -1, 'startup-toggle or restart missing from the menu');
    assert.equal(restart, startup + 1,
      `Restart is not directly under Start at login: ${ids.slice(startup, restart + 1).join(' | ')}`);
  });

  test('Start at login carries its checked state, so the toggle reads as a toggle', () => {
    const menu = makeTrayManager()._buildMenu();
    const item = menu.items.find((i) => i.id === 'startup-toggle');
    assert.ok(item, 'startup-toggle missing');
    assert.equal(typeof item.checked, 'boolean', 'checked must be a boolean for the tray to draw a tick');
  });

  test('Open Dashboard is disabled when no dashboard manager is wired', () => {
    const menu = makeTrayManager(undefined)._buildMenu();
    const item = menu.items.find((i) => i.id === 'open-dashboard');
    assert.ok(item, 'open-dashboard missing');
    assert.equal(item.enabled, false, 'a dashboard entry that cannot open anything must not look clickable');
  });

  test('every id in the menu is unique, so clicks cannot be ambiguous', () => {
    const ids = makeTrayManager()._buildMenu().items.map((i) => i.id);
    assert.deepEqual(ids, [...new Set(ids)], `duplicate menu ids: ${ids.join(' | ')}`);
  });
});

// The version row is the only affordance for checking for an update, and nothing said so.
describe('version item', () => {
  function versionItem(mgr) {
    return mgr._buildMenu().items.find((i) => i.id === 'update-btn');
  }

  test('invites the click while idle', () => {
    const item = versionItem(makeTrayManager());
    assert.match(item.title, /^v1\.0\.0 \(click for update\)$/, `unexpected title: ${item.title}`);
    assert.equal(item.enabled, true);
  });

  test('drops the invitation while the check is running', () => {
    const mgr = makeTrayManager();
    mgr._updateStatus = 'checking';
    const item = versionItem(mgr);
    assert.ok(!/click for update/.test(item.title), `still inviting a click: ${item.title}`);
    // Clicking again mid-check would start a second npm view.
    assert.equal(item.enabled, false);
  });

  test('drops the invitation once an update is found, since the install row is the action', () => {
    const mgr = makeTrayManager();
    mgr._updateStatus = 'available';
    mgr._latestVersion = '9.9.9';
    const item = versionItem(mgr);
    assert.ok(!/click for update/.test(item.title),
      `points at the wrong row when an update is available: ${item.title}`);
    const install = mgr._buildMenu().items.find((i) => i.id === 'update-install');
    assert.ok(install, 'no install row to point at');
  });

  test('a transient label still wins over the version string', () => {
    const mgr = makeTrayManager();
    mgr._versionLabel = 'Up to date';
    assert.equal(versionItem(mgr).title, 'Up to date');
  });
});

// Between the click and the answer the icon did not move at all: `npm view` takes seconds, the
// menu said "Checking..." and the tray looked idle, so the click read as having done nothing.
describe('tray icon during an update check', () => {
  const { getIcons } = require('../src/tray-icons');
  const icons = getIcons();

  test('a distinct checking icon exists for every supported colour', () => {
    const { SUPPORTED_TRAY_COLORS } = require('../src/tray-icons');
    for (const colour of SUPPORTED_TRAY_COLORS) {
      const set = getIcons(colour);
      assert.ok(set.checking, `no checking icon for ${colour}`);
      for (const other of ['idle', 'error', 'running', 'success']) {
        assert.notEqual(set.checking, set[other],
          `checking icon is identical to ${other} for ${colour}: the tray would not appear to react`);
      }
    }
  });

  test('shows the checking icon while checking', () => {
    const mgr = makeTrayManager();
    mgr._updateStatus = 'checking';
    assert.equal(mgr._buildMenu().icon, icons.checking);
  });

  test('shows it while an update is installing too', () => {
    const mgr = makeTrayManager();
    mgr._updateStatus = 'updating';
    assert.equal(mgr._buildMenu().icon, icons.checking);
  });

  test('is idle when nothing is happening', () => {
    assert.equal(makeTrayManager()._buildMenu().icon, icons.idle);
  });

  // Failures are about the jobs, not about this check, and must stay visible.
  test('a job failure still outranks the checking icon', () => {
    const mgr = makeTrayManager();
    mgr._updateStatus = 'checking';
    mgr._failures = [{ jobId: 'j1', entry: { startedAt: 'x', exitCode: 1 } }];
    assert.equal(mgr._buildMenu().icon, icons.error);
  });
});
