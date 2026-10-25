'use strict';

// Guard: nothing a test runs may reach the developer's global npm prefix or the real registry. The preload
// (helpers/isolate-config-dir.js) points every process of the run at a throwaway prefix and an unreachable registry.
// Cheap checks of that environment and of its helpers. Where requests actually GO is proven against a fake local
// registry in npm-isolation-registry.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SCOPE_REGISTRY_VAR, UNREACHABLE_REGISTRY, createIsolatedNpmEnv, applySuiteNpmGuard } = require('./helpers/isolated-npm-env');

const PRELOAD = path.join(__dirname, 'helpers', 'isolate-config-dir.js');
const PRELOAD_HINT = 'the preload did not run: use `npm test`, not node --test alone';
const dirs = [];
const tmp = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-npm-iso-${label}-`));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function npmConfigGet(key, cwd) {
  // A command line, not an argument list: npm is npm.cmd on Windows and needs a shell; every argument here is a literal.
  return spawnSync(`npm config get ${key} --workspaces=false`, { env: process.env, cwd, encoding: 'utf8', shell: true, windowsHide: true, timeout: 60_000 });
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

describe('the suite environment (what every test process inherited from the preload)', () => {
  test('npm\'s global prefix is a throwaway under the test temp root', () => {
    assert.ok(process.env.ORCH_TEST_TMP_ROOT, PRELOAD_HINT);
    const res = npmConfigGet('prefix');
    assert.equal(res.status, 0, `npm config get prefix failed: ${res.stderr} ${res.error ?? ''}`);
    assert.ok(inside(res.stdout.trim(), process.env.ORCH_TEST_TMP_ROOT),
      `npm's global prefix is ${res.stdout.trim()}, outside ${process.env.ORCH_TEST_TMP_ROOT}: an updater run from a test would install into the real one`);
  });

  // From the repository directory: the project-level npm config there names GitHub Packages for the scope.
  test('both the default and the scope registry resolve to the unreachable one, from the repository directory', () => {
    for (const key of ['registry', '@wadeck-app:registry']) {
      const res = npmConfigGet(key);
      assert.equal(res.status, 0, `npm config get ${key} failed: ${res.stderr} ${res.error ?? ''}`);
      assert.equal(res.stdout.trim(), UNREACHABLE_REGISTRY, `${key} resolves to ${res.stdout.trim()} (preload: ${process.env.ORCH_TEST_TMP_ROOT ? 'ran' : 'missing'})`);
    }
  });

  test('the npm working directory exists, is under the throwaway root and is empty', () => {
    const cwd = process.env.ORCH_TEST_NPM_CWD;
    assert.ok(cwd && process.env.ORCH_TEST_TMP_ROOT, PRELOAD_HINT);
    assert.ok(inside(cwd, process.env.ORCH_TEST_TMP_ROOT), `ORCH_TEST_NPM_CWD is ${cwd}`);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});

describe('the preload', () => {
  function afterPreload(extra) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^NPM_CONFIG_/i.test(k) || k === 'ORCH_TEST_TMP_ROOT') {
        delete env[k];
      }
    }
    Object.assign(env, extra);
    const script = path.join(tmp('print'), 'print-npm-env.js');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^NPM_CONFIG_/i.test(k)))));\n');
    const run = spawnSync(process.execPath, ['--require', PRELOAD, script], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, `preload run failed: ${run.stderr} ${run.error ?? ''}`);
    return JSON.parse(run.stdout);
  }

  test('sets a prefix, a registry and its own npm config files when nothing is set', () => {
    const vars = afterPreload({});
    assert.ok(vars.NPM_CONFIG_PREFIX && vars.NPM_CONFIG_USERCONFIG && vars.NPM_CONFIG_GLOBALCONFIG, JSON.stringify(Object.keys(vars)));
    assert.equal(vars.NPM_CONFIG_REGISTRY, UNREACHABLE_REGISTRY);
    assert.notEqual(vars.NPM_CONFIG_USERCONFIG, vars.NPM_CONFIG_GLOBALCONFIG);
  });

  test('honours ORCH_TEST_NPM_PREFIX / _REGISTRY, and the scope registry follows the registry', () => {
    const vars = afterPreload({ ORCH_TEST_NPM_PREFIX: path.join(os.tmpdir(), 'chosen-prefix'), ORCH_TEST_NPM_REGISTRY: 'http://127.0.0.1:4873' });
    assert.equal(vars.NPM_CONFIG_PREFIX, path.join(os.tmpdir(), 'chosen-prefix'));
    assert.equal(vars.NPM_CONFIG_REGISTRY, 'http://127.0.0.1:4873');
    assert.equal(vars[SCOPE_REGISTRY_VAR], 'http://127.0.0.1:4873');
  });

  test('replaces the user-level npm config file even when one is set: a real one carries the scope registry and the token', () => {
    const real = path.join(os.tmpdir(), 'someone', 'user-npm-config');
    const vars = afterPreload({ NPM_CONFIG_USERCONFIG: real });
    assert.notEqual(vars.NPM_CONFIG_USERCONFIG, real);
  });
});

describe('the helpers', () => {
  test('createIsolatedNpmEnv drops leaked steering variables and points npm at the tree', () => {
    const root = tmp('env');
    const env = createIsolatedNpmEnv(root, {}, { PATH: 'x', UPDATER_FORCE: '1', LAUNCHER_BUNDLE_OVERRIDE: 'y', NPM_CONFIG_PREFIX: path.join(os.tmpdir(), 'real') });
    assert.equal(env.UPDATER_FORCE, undefined);
    assert.equal(env.LAUNCHER_BUNDLE_OVERRIDE, undefined);
    assert.equal(env.PATH, 'x');
    assert.ok(inside(env.NPM_CONFIG_PREFIX, root), env.NPM_CONFIG_PREFIX);
    assert.equal(env.NPM_CONFIG_REGISTRY, UNREACHABLE_REGISTRY);
  });

  test('both npm config files carry the registry and the scope registry on their own, so a dropped variable cannot reach GitHub', () => {
    const env = createIsolatedNpmEnv(tmp('files'), {}, {});
    for (const file of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /^registry=http:\/\/127\.0\.0\.1:9$/m, file);
      assert.match(text, /^@wadeck-app:registry=http:\/\/127\.0\.0\.1:9$/m, file);
    }
  });

  // `npm test` exports the caller's npm configuration as npm_config_*: the real global prefix arrived that way.
  test('applySuiteNpmGuard drops inherited npm_config_* of any case, and honours only the ORCH_TEST_NPM_* choice', () => {
    const real = path.join(os.tmpdir(), 'real');
    const env = { NPM_CONFIG_PREFIX: real, npm_config_registry: 'https://real.example', npm_config_cache: real };
    const root = tmp('guard');
    const set = applySuiteNpmGuard(root, env);
    assert.ok(inside(env.NPM_CONFIG_PREFIX, root), env.NPM_CONFIG_PREFIX);
    assert.equal(env.npm_config_registry, undefined);
    assert.equal(env.NPM_CONFIG_REGISTRY, UNREACHABLE_REGISTRY);
    assert.ok(inside(env.NPM_CONFIG_CACHE, root), env.NPM_CONFIG_CACHE);
    assert.ok(set.includes('NPM_CONFIG_USERCONFIG'));
    const mine = path.join(os.tmpdir(), 'mine');
    const chosen = { ORCH_TEST_NPM_PREFIX: mine };
    applySuiteNpmGuard(tmp('guard2'), chosen);
    assert.equal(chosen.NPM_CONFIG_PREFIX, mine);
  });
});
