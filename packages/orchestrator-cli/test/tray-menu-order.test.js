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
