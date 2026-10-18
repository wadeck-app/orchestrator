'use strict';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deadPort, fakeAppCore } from './helpers/app-core-fakes.js';

/*
 * The daemon tells app-core, at every start, where its module lives. This is best effort by design --
 * the daemon never waits on app-core -- but each outcome has to be distinguishable and say what to do,
 * because "the dashboard module did not show up in app-core" is otherwise a mystery with no trace.
 */
let registerWithAppCore;
let resolveAppCorePort;
let describeOutcome;
let findAppModuleManifest;
let registerOnStart;
before(async () => {
  ({ registerWithAppCore, resolveAppCorePort, describeOutcome, findAppModuleManifest, registerOnStart } = await import('../dist/app-core-registration.js'));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-appcore-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function freshDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestFile() {
  const file = path.join(freshDir(`manifest-${Math.random().toString(36).slice(2)}`), 'manifest.json');
  fs.writeFileSync(file, '{}');
  return file;
}

describe('resolveAppCorePort', () => {
  it('prefers APP_CORE_PORT', () => {
    const dir = freshDir('port-env');
    fs.writeFileSync(path.join(dir, 'server.port.json'), JSON.stringify({ pid: 1, port: 4999 }));
    assert.equal(resolveAppCorePort(dir, { APP_CORE_PORT: '4861' }), 4861);
  });

  it('then the port app-core wrote for itself, which is the port it really listens on', () => {
    const dir = freshDir('port-file');
    fs.writeFileSync(path.join(dir, 'server.port.json'), JSON.stringify({ pid: 1, port: 4999 }));
    assert.equal(resolveAppCorePort(dir, {}), 4999);
  });

  it('then app-core\'s default port', () => {
    assert.equal(resolveAppCorePort(freshDir('port-none'), {}), 4850);
  });

  it('names the variable when APP_CORE_PORT is not a port, instead of falling back to another', () => {
    assert.throws(() => resolveAppCorePort(freshDir('port-bad'), { APP_CORE_PORT: 'abc' }), /APP_CORE_PORT.*abc/);
  });

  it('says a port file it cannot read is unusable, and falls back to the default', () => {
    const dir = freshDir('port-corrupt');
    fs.writeFileSync(path.join(dir, 'server.port.json'), '{not json');
    assert.equal(resolveAppCorePort(dir, {}), 4850);
  });
});

describe('registerWithAppCore', () => {
  it('registers the manifest with a running app-core', async () => {
    const appCore = await fakeAppCore((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"orchestrator"}'); });
    const manifestPath = manifestFile();
    try {
      const outcome = await registerWithAppCore({
        id: 'orchestrator', manifestPath, appCoreConfigDir: freshDir('cfg-ok'), env: { APP_CORE_PORT: String(appCore.port) },
      });

      assert.deepEqual(outcome, { status: 'registered', port: appCore.port });
      assert.deepEqual(appCore.seen, [{
        method: 'POST', url: '/api/modules/register',
        body: { id: 'orchestrator', source: { type: 'file', path: manifestPath } },
      }]);
    } finally {
      await appCore.close();
    }
  });

  it('reports a refusal with app-core\'s own reason, rather than a bare status code', async () => {
    const appCore = await fakeAppCore((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"manifest.json failed validation: path must look like /jobs/:id"}'); });
    try {
      const outcome = await registerWithAppCore({
        id: 'orchestrator', manifestPath: manifestFile(), appCoreConfigDir: freshDir('cfg-refused'), env: { APP_CORE_PORT: String(appCore.port) },
      });

      assert.equal(outcome.status, 'refused');
      assert.equal(outcome.httpStatus, 400);
      assert.match(outcome.reason, /path must look like/);
    } finally {
      await appCore.close();
    }
  });

  it('leaves a pickup file for app-core\'s next start when it is not running but is installed', async () => {
    const cfg = freshDir('cfg-deferred');
    const manifestPath = manifestFile();

    const outcome = await registerWithAppCore({
      id: 'orchestrator', manifestPath, appCoreConfigDir: cfg, env: { APP_CORE_PORT: String(await deadPort()) },
    });

    const file = path.join(cfg, 'modules', 'orchestrator.json');
    assert.deepEqual(outcome, { status: 'deferred', file });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { id: 'orchestrator', source: { type: 'file', path: manifestPath } });
  });

  it('treats an app-core that accepts the connection but never answers as not running', async () => {
    const appCore = await fakeAppCore(() => { /* never answers */ });
    const cfg = freshDir('cfg-hung');
    try {
      const outcome = await registerWithAppCore({
        id: 'orchestrator', manifestPath: manifestFile(), appCoreConfigDir: cfg, env: { APP_CORE_PORT: String(appCore.port) }, timeoutMs: 150,
      });
      assert.equal(outcome.status, 'deferred');
    } finally {
      await appCore.close();
    }
  });

  it('does nothing, and creates nothing, when app-core was never installed', async () => {
    const cfg = path.join(tmp, 'never-installed');

    const outcome = await registerWithAppCore({
      id: 'orchestrator', manifestPath: manifestFile(), appCoreConfigDir: cfg, env: { APP_CORE_PORT: String(await deadPort()) },
    });

    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.reason, /not installed|not found/i);
    assert.equal(fs.existsSync(cfg), false, 'a user who never installed app-core must not get an app-core folder');
  });

  it('refuses a manifest that does not exist, naming it: that is a packaging bug, not "app-core is down"', async () => {
    await assert.rejects(
      registerWithAppCore({ id: 'orchestrator', manifestPath: path.join(tmp, 'missing', 'manifest.json'), appCoreConfigDir: freshDir('cfg-nomanifest'), env: {} }),
      /manifest.*missing[\\/]manifest\.json/s,
    );
  });
});

describe('describeOutcome', () => {
  const id = 'orchestrator';

  it('says what happened for each outcome, and what to do when something is wrong', () => {
    assert.match(describeOutcome({ status: 'registered', port: 4850 }, id), /registered.*4850/);
    assert.match(describeOutcome({ status: 'deferred', file: '/x/modules/orchestrator.json' }, id), /not running.*\/x\/modules\/orchestrator\.json.*next start/s);
    assert.match(describeOutcome({ status: 'skipped', reason: 'app-core is not installed' }, id), /not installed/);
    const refused = describeOutcome({ status: 'refused', port: 4850, httpStatus: 400, reason: 'bad manifest' }, id);
    assert.match(refused, /refused.*400.*bad manifest/s);
    assert.match(refused, /Fix|fix|check/, 'a refusal must say what to do next');
  });
});

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
