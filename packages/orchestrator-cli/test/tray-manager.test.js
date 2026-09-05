'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// Minimal stub of TrayProcess
function makeTrayProcess() {
  let killed = false;
  return {
    killed: false,
    async kill() { killed = true; this.killed = true; },
    wasKilled: () => killed,
    onStderrLine: () => {},
    onExit: () => {},
    onError: () => {},
    onClicked: () => {},
    async ready() {},
    async send() {},
    capturedStderr: () => '',
  };
}

// Import compiled TrayManager
const { TrayManager } = require('../src/tray-manager');

describe('TrayManager restart - tray process must be killed before restart event (no orphan + no respawn)', () => {
  test('clicking Restart kills the tray-go binary before emitting restart', async () => {
    // We can only test the kill-before-emit contract by patching _tp directly.
    // This guards against orphaned tray-go processes on daemon restart.

    const calls = [];

    // Build a minimal TrayManager (won't start the binary - _tp stays null)
    const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
    const state = { getAll: () => ({}) };
    const registry = { list: () => [] };

    const mgr = new TrayManager(
      '/tmp/fake-config',
      scheduler,
      state,
      registry,
      '0.0.0-test',
      undefined,
      null,
    );

    // Inject a fake running tray process directly
    const fakeTp = makeTrayProcess();
    mgr._tp = fakeTp;
    mgr._restartAttempt = 0;

    // Track event order
    const order = [];
    fakeTp.kill = async () => { fakeTp.killed = true; order.push('killed'); };
    mgr.on('restart', () => order.push('restart-emitted'));

    // Simulate user clicking Restart from the tray menu
    mgr._handleClick('restart');

    // Allow any async kills to settle
    await new Promise(r => setTimeout(r, 50));

    // The tray process MUST be killed before the restart event fires
    assert.ok(order.includes('killed'),        'tray-go must be killed on restart');
    assert.ok(order.includes('restart-emitted'), 'restart event must fire');
    assert.equal(order.indexOf('killed'), 0,   'kill must happen BEFORE restart-emitted');
  });

  test('clicking Quit kills the tray-go binary before emitting quit', async () => {
    const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
    const state = { getAll: () => ({}) };
    const registry = { list: () => [] };

    const mgr = new TrayManager('/tmp/fake-config', scheduler, state, registry, '0.0.0-test', undefined, null);

    const fakeTp = makeTrayProcess();
    mgr._tp = fakeTp;

    const order = [];
    fakeTp.kill = async () => { fakeTp.killed = true; order.push('killed'); };
    mgr.on('quit', () => order.push('quit-emitted'));

    mgr._handleClick('quit');
    await new Promise(r => setTimeout(r, 50));

    assert.ok(order.includes('killed'),      'tray-go must be killed on quit');
    assert.ok(order.includes('quit-emitted'), 'quit event must fire');
    assert.equal(order.indexOf('killed'), 0, 'kill must happen BEFORE quit-emitted');
  });

  test('process.exit hook kills tray synchronously (guards CLI orch restart path)', async () => {
    // The `orch restart` RPC command calls process.exit(0) directly without going through
    // trayManager.stop(). The process.on('exit') hook registered in start() must kill it.
    const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
    const state = { getAll: () => ({}) };
    const registry = { list: () => [] };

    const mgr = new TrayManager('/tmp/fake-config', scheduler, state, registry, '0.0.0-test', undefined, null);

    // Patch _spawnTray so start() doesn't actually spawn a binary
    mgr._spawnTray = async () => {};

    await mgr.start();  // registers the process.on('exit') hook

    // Inject fake tp with pid - exit hook now uses _killByPid(pid) via taskkill/SIGKILL
    let killedPid = null;
    mgr._killByPid = (pid) => { killedPid = pid; };
    mgr._tp = {
      killed: false,
      process: { pid: 99999 },
      kill: async function() { this.killed = true; },
    };

    // Simulate process.exit via the 'exit' event
    process.emit('exit', 0);

    assert.equal(killedPid, 99999, 'process.on(exit) must kill the tray binary via _killByPid');
  });

  test('killing tray during restart does NOT trigger _scheduleRestart via onExit', async () => {
    // Guard: when killAndRestart() kills the tray, the onExit handler must not
    // schedule a new spawn (which would create a zombie systray icon).
    const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
    const state = { getAll: () => ({}) };
    const registry = { list: () => [] };

    const mgr = new TrayManager('/tmp/fake-config', scheduler, state, registry, '0.0.0-test', undefined, null);

    let spawnCount = 0;
    // Patch _spawnTray to track unwanted respawns
    mgr._spawnTray = async () => { spawnCount++; };

    // Build a fake tp with a real onExit callback
    let exitCb = null;
    const fakeTp = {
      killed: false,
      kill: async function() { this.killed = true; if (exitCb) exitCb(1); },
      onStderrLine: () => {},
      onExit:  (cb) => { exitCb = cb; },
      onError: () => {},
      onClicked: () => {},
      ready: async () => {},
      send: async () => {},
      capturedStderr: () => '',
    };
    mgr._tp = fakeTp;
    mgr._restartAttempt = 0;
    mgr.on('restart', () => {});

    mgr._handleClick('restart');
    await new Promise(r => setTimeout(r, 200));

    assert.equal(spawnCount, 0, '_scheduleRestart must NOT fire when kill is intentional');
  });
});
