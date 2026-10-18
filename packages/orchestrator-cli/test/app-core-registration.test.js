'use strict';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeAppCore } from './helpers/app-core-fakes.js';

/*
 * The daemon tells app-core, at every start, where its module lives. This is best effort by design --
 * the daemon never waits on app-core -- but each outcome has to be distinguishable and say what to do,
 * because "the dashboard module did not show up in app-core" is otherwise a mystery with no trace.
 */

let findAppModuleManifest;
let registerOnStart;
before(async () => {
  ({ findAppModuleManifest, registerOnStart } = await import('../dist/app-core-registration.js'));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-appcore-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function freshDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('findAppModuleManifest', () => {
  function layout(files) {
    const root = freshDir(`layout-${Math.random().toString(36).slice(2)}`);
    for (const file of files) {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '{}');
    }
    return path.join(root, 'orchestrator-cli');
  }

  it('finds the module shipped inside the installed package', () => {
    const packageRoot = layout(['orchestrator-cli/app-module/manifest.json']);
    assert.equal(findAppModuleManifest(packageRoot), path.join(packageRoot, 'app-module', 'manifest.json'));
  });

  it('falls back to the sibling package of a source checkout', () => {
    const packageRoot = layout(['app-module-orchestrator/manifest.json']);
    assert.equal(findAppModuleManifest(packageRoot), path.join(packageRoot, '..', 'app-module-orchestrator', 'manifest.json'));
  });

  it('prefers the installed one when both exist', () => {
    const packageRoot = layout(['orchestrator-cli/app-module/manifest.json', 'app-module-orchestrator/manifest.json']);
    assert.equal(findAppModuleManifest(packageRoot), path.join(packageRoot, 'app-module', 'manifest.json'));
  });

  it('returns nothing when there is none', () => {
    assert.equal(findAppModuleManifest(layout([])), undefined);
  });
});

describe('registerOnStart', () => {
  function collect() {
    const lines = [];
    return { lines, log: line => lines.push(line) };
  }

  function packageWithModule() {
    const root = freshDir(`pkg-${Math.random().toString(36).slice(2)}`);
    const packageRoot = path.join(root, 'orchestrator-cli');
    fs.mkdirSync(path.join(packageRoot, 'app-module'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'app-module', 'manifest.json'), '{}');
    return packageRoot;
  }

  it('says so, and contacts nobody, when appCore is switched off', async () => {
    const appCore = await fakeAppCore((_req, res) => { res.writeHead(200); res.end('{}'); });
    const { lines, log } = collect();
    try {
      await registerOnStart({ enabled: false, devInstance: false, packageRoot: packageWithModule(), appCoreConfigDir: freshDir('cfg-off'), env: { APP_CORE_PORT: String(appCore.port) }, log });
      assert.deepEqual(appCore.seen, []);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /turned off.*appCore: false/);
    } finally {
      await appCore.close();
    }
  });

  it('never registers a development instance: a checkout must not replace the installed module', async () => {
    const appCore = await fakeAppCore((_req, res) => { res.writeHead(200); res.end('{}'); });
    const { lines, log } = collect();
    try {
      await registerOnStart({ enabled: true, devInstance: true, packageRoot: packageWithModule(), appCoreConfigDir: freshDir('cfg-dev'), env: { APP_CORE_PORT: String(appCore.port) }, log });
      assert.deepEqual(appCore.seen, []);
      assert.match(lines[0], /development instance/);
    } finally {
      await appCore.close();
    }
  });

  it('says where it looked when the package carries no module, instead of staying silent', async () => {
    const { lines, log } = collect();
    await registerOnStart({ enabled: true, devInstance: false, packageRoot: path.join(freshDir('empty-pkg'), 'orchestrator-cli'), appCoreConfigDir: freshDir('cfg-nomod'), env: {}, log });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /no app-module.*app-module[\\/]manifest\.json/s);
  });

  it('registers and logs the outcome', async () => {
    const appCore = await fakeAppCore((_req, res) => { res.writeHead(200); res.end('{}'); });
    const { lines, log } = collect();
    try {
      await registerOnStart({ enabled: true, devInstance: false, packageRoot: packageWithModule(), orchConfigDir: freshDir('orch-go'), moduleStamp: 'v1', appCoreConfigDir: freshDir('cfg-go'), env: { APP_CORE_PORT: String(appCore.port) }, log });
      assert.equal(appCore.seen.length, 1);
      assert.match(lines[0], /registered/);
    } finally {
      await appCore.close();
    }
  });

  it('logs a failure instead of throwing: a daemon must not fail to start because of app-core', async () => {
    const { lines, log } = collect();
    await assert.doesNotReject(registerOnStart({ enabled: true, devInstance: false, packageRoot: packageWithModule(), orchConfigDir: freshDir('orch-bad'), moduleStamp: 'v1', appCoreConfigDir: freshDir('cfg-badport'), env: { APP_CORE_PORT: 'not-a-port' }, log }));
    assert.match(lines[0], /registration failed.*APP_CORE_PORT/s);
  });
});
