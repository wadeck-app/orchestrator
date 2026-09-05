'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// TrayManager builds menu item titles. These titles must not contain
// Unicode symbols (checkmarks, crosses, etc.) - they violate shared/no-emoji and should
// use plain-text markers like [ok] / [fail] instead (matching cli self-check output).

const { TrayManager } = require('../src/tray-manager');
const { EventEmitter } = require('node:events');

function makeTrayManager() {
  const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
  const state = { getAll: () => ({}) };
  const registry = { list: () => [] };
  return new TrayManager('/tmp/test-tray', scheduler, state, registry, '1.0.0');
}

const EMOJI_RE = /[ -⟿\u{1F000}-\u{1FFFF}]/u;

describe('TrayManager menu titles must not contain Unicode symbols', () => {
  test('success status title uses plain text, not unicode checkmark', () => {
    const mgr = makeTrayManager();
    const menu = mgr._buildMenu();
    const statusItem = menu.items.find(i => i.id === 'status');
    assert.ok(statusItem, 'status item must exist');
    assert.ok(
      !EMOJI_RE.test(statusItem.title),
      `status title "${statusItem.title}" contains a Unicode symbol - use plain text like "[ok]" instead`
    );
  });

  test('failure status title uses plain text, not unicode cross', () => {
    const mgr = makeTrayManager();
    // Inject a fake failure
    mgr._failures.push({ id: 'j1', label: 'My job', exitCode: 1, message: null, time: '10:00' });
    const menu = mgr._buildMenu();
    for (const item of menu.items) {
      assert.ok(
        !EMOJI_RE.test(item.title),
        `menu item "${item.id}" title "${item.title}" contains a Unicode symbol - use plain text instead`
      );
    }
  });
});
