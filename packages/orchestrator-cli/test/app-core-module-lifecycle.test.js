'use strict';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deadPort, fakeAppCore } from './helpers/app-core-fakes.js';

/*
 * The module app-core remembers must outlive the npm folder it came from. app-core stores the PATH of
 * a manifest, and npm replaces the package folder on every update and deletes it on uninstall: a path
 * into node_modules is a path that dies. So the daemon copies the module into its own config dir, per
 * version, registers the copy, and only removes older copies once app-core has accepted the new one --
 * the same shape as the native launcher binary, and for the same reason (see platform-binary.ts).
 */
let stageAppModule;
let pruneStagedModules;
let registerOnStart;
before(async () => {
  ({ stageAppModule, pruneStagedModules, registerOnStart } = await import('../dist/app-core-registration.js'));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-appcore-life-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let counter = 0;
function freshDir(name) {
  const dir = path.join(tmp, `${name}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** An installed package: <root>/orchestrator-cli/app-module/{manifest.json,...}. */
function installedPackage() {
  const packageRoot = path.join(freshDir('inst'), 'orchestrator-cli');
  const dir = path.join(packageRoot, 'app-module');
  fs.mkdirSync(path.join(dir, 'api-backend', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dsl-lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'api-backend', 'dist', 'backend.mjs'), 'export default () => {};');
  fs.writeFileSync(path.join(dir, 'dsl-lib', 'entries.mjs'), 'export default [];');
  return { packageRoot, dir };
}

describe('stageAppModule', () => {
  it('copies the whole module under <config dir>/app-module/<stamp> and returns its manifest', () => {
    const { dir } = installedPackage();
    const configDir = freshDir('stage');

    const manifest = stageAppModule(dir, configDir, '2026.10.1');

    assert.equal(manifest, path.join(configDir, 'app-module', '2026.10.1', 'manifest.json'));
    assert.ok(fs.existsSync(path.join(configDir, 'app-module', '2026.10.1', 'api-backend', 'dist', 'backend.mjs')));
    assert.ok(fs.existsSync(path.join(configDir, 'app-module', '2026.10.1', 'dsl-lib', 'entries.mjs')));
  });

  it('copies once per stamp: a second call keeps what is there', () => {
    const { dir } = installedPackage();
    const configDir = freshDir('stage');
    const manifest = stageAppModule(dir, configDir, 'v1');
    const marker = path.join(path.dirname(manifest), 'kept.txt');
    fs.writeFileSync(marker, 'still here');

    stageAppModule(dir, configDir, 'v1');

    assert.ok(fs.existsSync(marker), 'a second start must not rewrite a copy that is already complete');
  });

  it('replaces the leftovers of a copy that was interrupted', () => {
    const { dir } = installedPackage();
    const configDir = freshDir('stage');
    fs.mkdirSync(path.join(configDir, 'app-module', 'v1.partial'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'app-module', 'v1.partial', 'half.txt'), 'x');

    const manifest = stageAppModule(dir, configDir, 'v1');

    assert.ok(fs.existsSync(manifest));
    assert.equal(fs.existsSync(path.join(configDir, 'app-module', 'v1.partial')), false);
  });

  it('refuses a stamp that would escape the folder', () => {
    const { dir } = installedPackage();
    assert.throws(() => stageAppModule(dir, freshDir('stage'), '../../evil'), /stamp/i);
  });

  it('fails loudly, naming the source, when the module to copy is not there', () => {
    assert.throws(() => stageAppModule(path.join(tmp, 'no-such-module'), freshDir('stage'), 'v1'), /no-such-module/);
  });
});

describe('pruneStagedModules', () => {
  it('removes the copies of other versions and keeps the current one', () => {
    const { dir } = installedPackage();
    const configDir = freshDir('prune');
    for (const stamp of ['v1', 'v2', 'v3']) {
      stageAppModule(dir, configDir, stamp);
    }

    const removed = pruneStagedModules(configDir, 'v3');

    assert.equal(removed, 2);
    assert.deepEqual(fs.readdirSync(path.join(configDir, 'app-module')), ['v3']);
  });

  it('does nothing when nothing was ever staged', () => {
    assert.equal(pruneStagedModules(freshDir('prune'), 'v1'), 0);
  });
});

describe('registerOnStart with an installed package', () => {
  const accept = (_req, res) => { res.writeHead(200); res.end('{}'); };
  const refuse = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad manifest"}'); };

  async function start(extra) {
    const lines = [];
    await registerOnStart({ enabled: true, devInstance: false, log: l => lines.push(l), ...extra });
    return lines;
  }

  it('registers the copy in the config dir, not the file npm owns', async () => {
    const { packageRoot } = installedPackage();
    const orchConfig = freshDir('orch-cfg');
    const appCore = await fakeAppCore(accept);
    try {
      await start({ packageRoot, moduleStamp: 'v1', orchConfigDir: orchConfig, appCoreConfigDir: freshDir('ac'), env: { APP_CORE_PORT: String(appCore.port) } });

      const registered = appCore.seen[0].body.source.path;
      assert.equal(registered, path.join(orchConfig, 'app-module', 'v1', 'manifest.json'));
      assert.ok(!registered.includes(packageRoot), 'the path app-core remembers must survive npm replacing the package');
    } finally {
      await appCore.close();
    }
  });

  it('drops the older copies once app-core has accepted the new one', async () => {
    const { packageRoot, dir } = installedPackage();
    const orchConfig = freshDir('orch-cfg');
    stageAppModule(dir, orchConfig, 'v1');
    const appCore = await fakeAppCore(accept);
    try {
      await start({ packageRoot, moduleStamp: 'v2', orchConfigDir: orchConfig, appCoreConfigDir: freshDir('ac'), env: { APP_CORE_PORT: String(appCore.port) } });
      assert.deepEqual(fs.readdirSync(path.join(orchConfig, 'app-module')), ['v2']);
    } finally {
      await appCore.close();
    }
  });

  it('keeps the older copy when app-core refuses the new one, since it still points at it', async () => {
    const { packageRoot, dir } = installedPackage();
    const orchConfig = freshDir('orch-cfg');
    stageAppModule(dir, orchConfig, 'v1');
    const appCore = await fakeAppCore(refuse);
    try {
      const lines = await start({ packageRoot, moduleStamp: 'v2', orchConfigDir: orchConfig, appCoreConfigDir: freshDir('ac'), env: { APP_CORE_PORT: String(appCore.port) } });
      assert.deepEqual(fs.readdirSync(path.join(orchConfig, 'app-module')).sort(), ['v1', 'v2']);
      assert.match(lines.join('\n'), /refused/);
    } finally {
      await appCore.close();
    }
  });

  it('also drops the older copies when app-core is down, because the pickup file now names the new one', async () => {
    const { packageRoot, dir } = installedPackage();
    const orchConfig = freshDir('orch-cfg');
    stageAppModule(dir, orchConfig, 'v1');
    const acConfig = freshDir('ac');

    await start({ packageRoot, moduleStamp: 'v2', orchConfigDir: orchConfig, appCoreConfigDir: acConfig, env: { APP_CORE_PORT: String(await deadPort()) } });

    assert.deepEqual(fs.readdirSync(path.join(orchConfig, 'app-module')), ['v2']);
    const pickup = JSON.parse(fs.readFileSync(path.join(acConfig, 'modules', 'orchestrator.json'), 'utf8'));
    assert.equal(pickup.source.path, path.join(orchConfig, 'app-module', 'v2', 'manifest.json'));
  });

  it('copies nothing when app-core was never installed', async () => {
    const { packageRoot } = installedPackage();
    const orchConfig = freshDir('orch-cfg');

    const lines = await start({ packageRoot, moduleStamp: 'v1', orchConfigDir: orchConfig, appCoreConfigDir: path.join(tmp, 'ac-never'), env: { APP_CORE_PORT: String(await deadPort()) } });

    assert.equal(fs.existsSync(path.join(orchConfig, 'app-module')), false, 'no module folder for a machine that does not use app-core');
    assert.match(lines[0], /not installed/);
  });

  it('registers a source checkout\'s module in place, with no copy', async () => {
    const root = freshDir('checkout');
    fs.mkdirSync(path.join(root, 'app-module-orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app-module-orchestrator', 'manifest.json'), '{}');
    const packageRoot = path.join(root, 'orchestrator-cli');
    fs.mkdirSync(packageRoot, { recursive: true });
    const orchConfig = freshDir('orch-cfg');
    const appCore = await fakeAppCore(accept);
    try {
      await start({ packageRoot, moduleStamp: 'dev', orchConfigDir: orchConfig, appCoreConfigDir: freshDir('ac'), env: { APP_CORE_PORT: String(appCore.port) } });
      assert.equal(path.resolve(appCore.seen[0].body.source.path), path.resolve(packageRoot, '..', 'app-module-orchestrator', 'manifest.json'));
      assert.equal(fs.existsSync(path.join(orchConfig, 'app-module')), false);
    } finally {
      await appCore.close();
    }
  });

  it('says when it cannot make the copy, and lets the daemon run on', async () => {
    const { packageRoot } = installedPackage();
    const orchConfig = freshDir('orch-cfg');
    fs.writeFileSync(path.join(orchConfig, 'app-module'), 'a file where the folder should be');

    const lines = await start({ packageRoot, moduleStamp: 'v1', orchConfigDir: orchConfig, appCoreConfigDir: freshDir('ac'), env: {} });

    assert.match(lines.join('\n'), /app-core: registration failed.*app-module/s);
  });
});
