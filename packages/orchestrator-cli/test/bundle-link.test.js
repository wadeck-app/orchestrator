'use strict';

// A launcher started from <configDir>/bin/<stamp>/ (staged out of node_modules) finds the daemon bundle only through
// <dirname of node>/node_modules/<spec>, or by walking up node_modules from its own folder, which a staged copy has none of
// above it. On Windows the start-at-login value cannot carry LAUNCHER_BUNDLE_OVERRIDE, so when the global modules live
// elsewhere (%APPDATA%\npm, the Windows installer's default) the staged folder gets a junction named node_modules that
// leads to them.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planBundleLink, ensureBundleLink } = require('../src/bundle-link');

const SPEC = '@wadeck-app/orchestrator-cli/dist/orchestrator.cjs';
const onWindows = process.platform === 'win32';
const skipLink = onWindows ? false : 'junctions are Windows only (the start-at-login entry of the other platforms carries LAUNCHER_BUNDLE_OVERRIDE)';

function fakeGlobalModules() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bundle-link-'));
  const modules = path.join(root, 'npm', 'node_modules');
  const bundle = path.join(modules, ...SPEC.split('/'));
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, '// bundle');
  const nodeDir = path.join(root, 'nodejs');
  fs.mkdirSync(nodeDir, { recursive: true });
  const stage = path.join(root, 'config', 'bin', '2026.11.15-001-abc-bin.1');
  fs.mkdirSync(stage, { recursive: true });
  return { root, modules, bundle, nodeDir, stage };
}

describe('planBundleLink: which node_modules the launcher has to be shown', () => {
  test('modules next to node: the launcher finds the bundle itself, no link', () => {
    const f = fakeGlobalModules();
    const nodeModulesOfNode = path.join(f.nodeDir, 'node_modules');
    const bundle = path.join(nodeModulesOfNode, ...SPEC.split('/'));
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, '// bundle');

    assert.equal(planBundleLink({ daemonPath: bundle, spec: SPEC, nodeDir: f.nodeDir }), null);
  });

  test('modules elsewhere: the plan names the node_modules folder that holds the bundle', () => {
    const f = fakeGlobalModules();

    const plan = planBundleLink({ daemonPath: f.bundle, spec: SPEC, nodeDir: f.nodeDir });

    assert.equal(plan.modulesDir, f.modules);
  });

  test('no node on PATH: the link is still planned, the launcher cannot look next to node', () => {
    const f = fakeGlobalModules();

    assert.equal(planBundleLink({ daemonPath: f.bundle, spec: SPEC, nodeDir: null }).modulesDir, f.modules);
  });

  test('a bundle that is not at <modules>/<spec> (a checkout) gets no link, and says nothing is wrong', () => {
    const f = fakeGlobalModules();
    const checkout = path.join(f.root, 'checkout', 'dist', 'orchestrator.cjs');
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    fs.writeFileSync(checkout, '// bundle');

    assert.equal(planBundleLink({ daemonPath: checkout, spec: SPEC, nodeDir: f.nodeDir }), null);
  });
});

describe('ensureBundleLink', () => {
  test('creates node_modules in the staged folder, and the bundle resolves through it', { skip: skipLink }, () => {
    const f = fakeGlobalModules();

    const outcome = ensureBundleLink(f.stage, { modulesDir: f.modules });

    assert.equal(outcome, 'created');
    assert.ok(fs.existsSync(path.join(f.stage, 'node_modules', ...SPEC.split('/'))));
  });

  test('a second call changes nothing', { skip: skipLink }, () => {
    const f = fakeGlobalModules();
    ensureBundleLink(f.stage, { modulesDir: f.modules });

    assert.equal(ensureBundleLink(f.stage, { modulesDir: f.modules }), 'unchanged');
  });

  test('a link that points somewhere else (the npm prefix changed) is pointed at the new folder', { skip: skipLink }, () => {
    const f = fakeGlobalModules();
    const other = fakeGlobalModules();
    ensureBundleLink(f.stage, { modulesDir: other.modules });

    assert.equal(ensureBundleLink(f.stage, { modulesDir: f.modules }), 'replaced');
    assert.equal(fs.realpathSync(path.join(f.stage, 'node_modules')), fs.realpathSync(f.modules));
  });

  test('removing the staged folder removes the link and never what it leads to', { skip: skipLink }, () => {
    const f = fakeGlobalModules();
    ensureBundleLink(f.stage, { modulesDir: f.modules });

    fs.rmSync(f.stage, { recursive: true });

    assert.ok(fs.existsSync(f.bundle), 'the global node_modules lost its content');
  });

  test('a real folder named node_modules is never replaced: the error says what to do', { skip: skipLink }, () => {
    const f = fakeGlobalModules();
    fs.mkdirSync(path.join(f.stage, 'node_modules'));

    assert.throws(() => ensureBundleLink(f.stage, { modulesDir: f.modules }), /not a link.*delete it/s);
  });
});
