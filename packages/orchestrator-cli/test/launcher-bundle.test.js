'use strict';

// 2026-10-31: `orch start` fixed LAUNCHER_BUNDLE_OVERRIDE to the versioned path of the bundle for the launcher's whole life.
// After `nvm use` the launcher kept starting the old node's bundle while the updater installed into the new one (822 restarts).
// When the launcher finds the very same bundle by itself at each spawn (<dirname of node>/node_modules/<spec>, stable on nvm for
// Windows where that directory is a junction), nothing is fixed and the daemon follows the node in use.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { launcherBundleOverride, nodeDirOnPath, LAUNCHER_BUNDLE_SPEC } = require('../src/launcher-bundle');

describe('launcherBundleOverride', () => {
  const spec = '@wadeck-app/orchestrator-cli/dist/orchestrator.cjs';
  const same = (p) => p;

  test('nothing is fixed when the launcher finds this very bundle under the node directory', () => {
    const nodeDir = path.join(path.sep, 'nodejs');
    const bundle = path.join(nodeDir, 'node_modules', ...spec.split('/'));
    assert.equal(launcherBundleOverride({ daemonPath: bundle, spec, nodeDir, realpath: same }), undefined);
  });

  test('the junction and the versioned directory are the same bundle once resolved', () => {
    const junction = path.join(path.sep, 'nodejs', 'node_modules', ...spec.split('/'));
    const versioned = path.join(path.sep, 'nvm', 'v24', 'node_modules', ...spec.split('/'));
    const realpath = (p) => (p === junction ? versioned : p);
    assert.equal(launcherBundleOverride({ daemonPath: versioned, spec, nodeDir: path.join(path.sep, 'nodejs'), realpath }), undefined);
  });

  test('a bundle somewhere else stays fixed: the launcher would not find it', () => {
    const daemonPath = path.join(path.sep, 'repo', 'dist', 'orchestrator.cjs');
    assert.equal(launcherBundleOverride({ daemonPath, spec, nodeDir: path.join(path.sep, 'nodejs'), realpath: same }), daemonPath);
  });

  test('a node directory that holds another install stays fixed', () => {
    const nodeDir = path.join(path.sep, 'nodejs');
    const daemonPath = path.join(path.sep, 'old', 'node_modules', ...spec.split('/'));
    const realpath = (p) => p;
    assert.equal(launcherBundleOverride({ daemonPath, spec, nodeDir, realpath }), daemonPath);
  });

  test('no node on PATH: stays fixed', () => {
    const daemonPath = path.join(path.sep, 'x', 'orchestrator.cjs');
    assert.equal(launcherBundleOverride({ daemonPath, spec, nodeDir: null, realpath: same }), daemonPath);
  });

  test('a path that cannot be resolved (missing file) stays fixed instead of throwing', () => {
    const daemonPath = path.join(path.sep, 'x', 'orchestrator.cjs');
    const realpath = () => { throw new Error('ENOENT'); };
    assert.equal(launcherBundleOverride({ daemonPath, spec, nodeDir: path.join(path.sep, 'nodejs'), realpath }), daemonPath);
  });

  test('the spec is the one the launcher is built with', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ci', 'launcher.config.json'), 'utf8'));
    assert.equal(LAUNCHER_BUNDLE_SPEC, cfg.nodeScript);
  });
});

describe('nodeDirOnPath', () => {
  test('is the first PATH directory holding node, the way the launcher looks it up', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nodedir-'));
    try {
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      const exe = process.platform === 'win32' ? 'node.exe' : 'node';
      fs.writeFileSync(path.join(b, exe), '');
      assert.equal(nodeDirOnPath({ PATH: [a, b].join(path.delimiter) }), b);
      assert.equal(nodeDirOnPath({ PATH: a }), null);
      assert.equal(nodeDirOnPath({}), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
