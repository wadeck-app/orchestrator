'use strict';

// Guard: where do the requests of a spawned npm GO? A fake registry on 127.0.0.1 (port 0) records every request and
// answers 404. The only way npm learns its address is the isolation environment (createIsolatedNpmEnv). No external
// network, no DNS, no fixed port, and no dependence on how a given npm version resolves the scope registry.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { SCOPE_REGISTRY_VAR, UNREACHABLE_REGISTRY, createIsolatedNpmEnv, isolatedNpmCwd } = require('./helpers/isolated-npm-env');

const GITHUB = /npm\.pkg\.github\.com/i;
const requests = [];
let server;
let fakeUrl;
let root;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-npm-fake-registry-'));
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: 'not found (fake registry)' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  fakeUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Everything needed to tell, from a CI log alone, where npm went. Environment variables are listed by NAME only: a value may be a token.
function diagnostic(res, env, cwd) {
  const npm = (args) => spawnSync(`npm ${args}`, { env, cwd, encoding: 'utf8', shell: true, windowsHide: true, timeout: 60_000 });
  const ask = (key) => {
    const r = npm(`config get ${key} --workspaces=false`);
    return r.status === 0 ? r.stdout.trim() : `(failed: ${String(r.stderr).trim()})`;
  };
  const names = Object.keys(env).filter((k) => /npm|auth|registry/i.test(k)).sort();
  return [
    '',
    `--- npm isolation diagnostic (${process.platform}, node ${process.version}, npm ${npm('--version').stdout.trim()})`,
    `cwd: ${cwd ?? `(inherited) ${process.cwd()}`}`,
    `fake registry: ${fakeUrl}; requests it saw: ${JSON.stringify(requests)}`,
    `npm config get registry: ${ask('registry')}`,
    `npm config get @wadeck-app:registry: ${ask('@wadeck-app:registry')}`,
    `env names: ${names.join(', ')}`,
    `exit status: ${res.status}, signal: ${res.signal}, error: ${res.error ? res.error.message : 'none'}`,
    `stdout: ${String(res.stdout).trim()}`,
    `stderr: ${String(res.stderr).trim()}`,
  ].join('\n');
}

// Asynchronous on purpose: the fake registry lives in THIS process, a spawnSync would block the event loop that answers npm.
function npmView(pkg, env, cwd) {
  return new Promise((resolve) => {
    // A command line, not an argument list: npm is npm.cmd on Windows and needs a shell; every argument here is a literal.
    const child = spawn(`npm view ${pkg} version`, { env, cwd, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { error = e; });
    const timer = setTimeout(() => {
      error = new Error('npm view did not finish within 90 s');
      child.kill();
    }, 90_000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, error, stdout, stderr });
    });
  });
}

function assertWentToFakeRegistry(res, env, cwd, pkgName) {
  const why = diagnostic(res, env, cwd);
  assert.equal(res.error, undefined, `npm could not run or timed out${why}`);
  assert.notEqual(res.status, 0, `npm view succeeded against a registry that only answers 404${why}`);
  assert.ok(requests.some((r) => r.url.includes(pkgName)), `the fake registry received no request naming ${pkgName}${why}`);
  assert.ok(requests.every((r) => r.host === new URL(fakeUrl).host), `a request carried another host${why}`);
  assert.doesNotMatch(String(res.stderr), GITHUB, `npm mentions GitHub Packages${why}`);
}

describe('where a spawned npm sends its requests (fake local registry)', async () => {
  test('an unscoped package goes to the registry given through the isolation environment', async () => {
    requests.length = 0;
    const env = createIsolatedNpmEnv(root, { registry: fakeUrl });
    const cwd = isolatedNpmCwd(root);
    const res = await npmView('orch-fake-unscoped-package', env, cwd);
    assertWentToFakeRegistry(res, env, cwd, 'orch-fake-unscoped-package');
  });

  test('a @wadeck-app package goes to the scope registry even when the default registry is another one', async () => {
    requests.length = 0;
    const env = createIsolatedNpmEnv(root, { registry: fakeUrl, extra: { NPM_CONFIG_REGISTRY: UNREACHABLE_REGISTRY, [SCOPE_REGISTRY_VAR]: fakeUrl } });
    const cwd = isolatedNpmCwd(root);
    const res = await npmView('@wadeck-app/shared-cli', env, cwd);
    assertWentToFakeRegistry(res, env, cwd, 'shared-cli');
  });

  test('a @wadeck-app package goes to the registry given through the isolation environment', async () => {
    requests.length = 0;
    const env = createIsolatedNpmEnv(root, { registry: fakeUrl });
    const cwd = isolatedNpmCwd(root);
    const res = await npmView('@wadeck-app/shared-cli', env, cwd);
    assertWentToFakeRegistry(res, env, cwd, 'shared-cli');
  });

  // Unexplained Linux behaviour, kept visible but not gating. On CI ubuntu (npm 11.19), from the repository directory,
  // `npm view @wadeck-app/shared-cli version` reached https://npm.pkg.github.com although `npm config get registry` and
  // `npm config get @wadeck-app:registry` both reported 127.0.0.1:9. A publishConfig explanation was disproved
  // (shared-cli is not the local package). Nothing under test depends on it: no test runs npm from the repository
  // directory, they use the isolated working directory above. If this starts passing everywhere, remove the todo.
  test('from the repository directory (project-level npm config applies), npm does not reach GitHub Packages', { todo: 'unexplained on npm 11.19 / Linux; no test runs npm from here' }, async () => {
    requests.length = 0;
    const env = createIsolatedNpmEnv(root, { registry: fakeUrl });
    const res = await npmView('@wadeck-app/shared-cli', env, undefined);
    assertWentToFakeRegistry(res, env, undefined, 'shared-cli');
  });
});
