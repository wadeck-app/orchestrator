'use strict';

// Guard: nothing a test runs may reach the developer's global npm prefix or the real registry. The preload
// (helpers/isolate-config-dir.js) points every process of the run at a throwaway prefix and an unreachable registry.
// These tests ask real npm, so they fail if the preload is missing or if a config file leaks the real scope registry.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SCOPE_REGISTRY_VAR, UNREACHABLE_REGISTRY, createIsolatedNpmEnv, applySuiteNpmGuard } = require('./helpers/isolated-npm-env');

const PRELOAD = path.join(__dirname, 'helpers', 'isolate-config-dir.js');
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

function npm(args, env, cwd) {
  // A command line, not an argument list: npm is npm.cmd on Windows and needs a shell; every argument here is a literal.
  return spawnSync(`npm ${args.join(' ')}`, { env, cwd, encoding: 'utf8', shell: true, windowsHide: true, timeout: 60_000 });
}

// Everything needed to tell, from a CI log alone, why npm reached (or did not reach) the wrong registry.
// Environment variables are listed by NAME only: a value may be a token.
function diagnostic(res, env, cwd) {
  const ask = (key) => {
    const r = npm(['config', 'get', key, '--workspaces=false'], env, cwd);
    return r.status === 0 ? r.stdout.trim() : `(failed: ${String(r.stderr).trim()})`;
  };
  const names = Object.keys(env).filter((k) => /npm|auth|registry/i.test(k)).sort();
  return [
    '',
    `--- npm isolation diagnostic (${process.platform}, node ${process.version}, npm ${npm(['--version'], env, cwd).stdout.trim()})`,
    `cwd: ${cwd ?? `(inherited) ${process.cwd()}`}`,
    `npm config get registry: ${ask('registry')}`,
    `npm config get @wadeck-app:registry: ${ask('@wadeck-app:registry')}`,
    `npm config get userconfig: ${ask('userconfig')}`,
    `env names: ${names.join(', ')}`,
    `exit status: ${res.status}, signal: ${res.signal}, error: ${res.error ? res.error.message : 'none'}`,
    `stdout: ${String(res.stdout).trim()}`,
    `stderr: ${String(res.stderr).trim()}`,
  ].join('\n');
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

describe('the suite environment (what every test process inherited from the preload)', () => {
  test('the global prefix is a throwaway under the test temp root', () => {
    assert.ok(process.env.ORCH_TEST_TMP_ROOT, 'the preload did not run: use `npm test`, not node --test alone');
    const res = npm(['config', 'get', 'prefix', '--workspaces=false'], process.env);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(inside(res.stdout.trim(), process.env.ORCH_TEST_TMP_ROOT),
      `npm's global prefix is ${res.stdout.trim()}, outside ${process.env.ORCH_TEST_TMP_ROOT}: an updater run from a test would install into the real one`);
  });

  test('both the default and the @wadeck-app registry are unreachable, whatever the user-level or project-level npm config says (cwd is inside the repository)', () => {
    for (const key of ['registry', '@wadeck-app:registry']) {
      const res = npm(['config', 'get', key, '--workspaces=false'], process.env);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.trim(), UNREACHABLE_REGISTRY, `${key} resolves to ${res.stdout.trim()}`);
    }
  });

  // Both directories: the clean one is what a test that spawns npm itself should use; the repository one is where the
  // product code under test (tray `npm view`, updater) runs npm, with the project-level .npmrc naming GitHub Packages.
  // Measured on Windows: without the scope variable, `npm view` from the repository reaches GitHub Packages (401).
  // CI ubuntu 2026-10-25 reached it from the repository WITH the variable set, for a reason not established.
  for (const [label, cwd] of [['a directory with no npm config', () => process.env.ORCH_TEST_NPM_CWD], ['the repository (project-level .npmrc applies)', () => undefined]]) {
    test(`a real npm request fails at once instead of reaching GitHub Packages, run from ${label}`, () => {
      assert.ok(process.env.ORCH_TEST_NPM_CWD, 'the preload did not run: use `npm test`, not node --test alone');
      const dir = cwd();
      const res = npm(['view', '@wadeck-app/orchestrator-cli', 'version'], process.env, dir);
      const why = diagnostic(res, process.env, dir);
      assert.notEqual(res.status, 0, `npm view succeeded: the registry was reachable${why}`);
      assert.doesNotMatch(String(res.stderr), /npm\.pkg\.github\.com/i, `npm reached GitHub Packages${why}`);
      assert.match(String(res.stderr), /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|127\.0\.0\.1:9/i, `unexpected npm failure${why}`);
    });
  }

  test('npm root -g, the call the updater makes, is under the throwaway prefix', () => {
    const res = npm(['root', '-g', '--workspaces=false'], process.env);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(inside(res.stdout.trim(), process.env.ORCH_TEST_TMP_ROOT), `npm root -g is ${res.stdout.trim()}`);
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
    const script = 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^NPM_CONFIG_/i.test(k)))))';
    const run = spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }

  test('sets a prefix, a registry and its own npm config files when nothing is set', () => {
    const vars = afterPreload({});
    assert.ok(vars.NPM_CONFIG_PREFIX && vars.NPM_CONFIG_USERCONFIG && vars.NPM_CONFIG_GLOBALCONFIG);
    assert.equal(vars.NPM_CONFIG_REGISTRY, UNREACHABLE_REGISTRY);
    assert.notEqual(vars.NPM_CONFIG_USERCONFIG, vars.NPM_CONFIG_GLOBALCONFIG);
  });

  test('honours ORCH_TEST_NPM_PREFIX / _REGISTRY, and the scope registry follows the registry', () => {
    const vars = afterPreload({ ORCH_TEST_NPM_PREFIX: 'C:\\chosen\\prefix', ORCH_TEST_NPM_REGISTRY: 'http://127.0.0.1:4873' });
    assert.equal(vars.NPM_CONFIG_PREFIX, 'C:\\chosen\\prefix');
    assert.equal(vars.NPM_CONFIG_REGISTRY, 'http://127.0.0.1:4873');
    assert.equal(vars[SCOPE_REGISTRY_VAR], 'http://127.0.0.1:4873');
  });

  test('replaces the npm user config even when one is set: a real one carries the scope registry and the token', () => {
    const vars = afterPreload({ NPM_CONFIG_USERCONFIG: 'C:\\Users\\someone\\user-npm-config' });
    assert.notEqual(vars.NPM_CONFIG_USERCONFIG, 'C:\\Users\\someone\\user-npm-config');
  });
});

describe('the helpers', () => {
  test('createIsolatedNpmEnv drops leaked steering variables and points npm at the tree', () => {
    const root = tmp('env');
    const env = createIsolatedNpmEnv(root, {}, { PATH: 'x', UPDATER_FORCE: '1', LAUNCHER_BUNDLE_OVERRIDE: 'y', NPM_CONFIG_PREFIX: 'C:\\real' });
    assert.equal(env.UPDATER_FORCE, undefined);
    assert.equal(env.LAUNCHER_BUNDLE_OVERRIDE, undefined);
    assert.equal(env.PATH, 'x');
    assert.ok(inside(env.NPM_CONFIG_PREFIX, root));
    assert.equal(env.NPM_CONFIG_REGISTRY, UNREACHABLE_REGISTRY);
  });

  test('both config files carry the registry and the scope registry on their own, so a dropped variable cannot reach GitHub', () => {
    const env = createIsolatedNpmEnv(tmp('files'), {}, {});
    for (const file of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /^registry=http:\/\/127\.0\.0\.1:9$/m);
      assert.match(text, /^@wadeck-app:registry=http:\/\/127\.0\.0\.1:9$/m);
    }
  });

  test('the npm working directory exists, is under the throwaway root and has no project-level npm config or package.json above it', () => {
    const cwd = process.env.ORCH_TEST_NPM_CWD;
    assert.ok(cwd && inside(cwd, process.env.ORCH_TEST_TMP_ROOT), `ORCH_TEST_NPM_CWD is ${cwd}`);
    assert.deepEqual(fs.readdirSync(cwd), []);
    // npm's project root is the nearest ancestor holding a package.json or a node_modules; only there is a project-level
    // npm config read. (A file in the home directory is the user-level one, replaced by ours, unless a package.json
    // makes the home directory a project.)
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      assert.ok(!fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules')), `${dir} would be npm's project root for npm run from ${cwd}`);
      if (path.dirname(dir) === dir) { break; }
    }
  });

  test('a registry can be given for a test that exercises a real install against a mock', () => {
    const env = createIsolatedNpmEnv(tmp('reg'), { registry: 'http://127.0.0.1:5555' }, {});
    assert.equal(env.NPM_CONFIG_REGISTRY, 'http://127.0.0.1:5555');
    assert.match(fs.readFileSync(env.NPM_CONFIG_USERCONFIG, 'utf8'), /@wadeck-app:registry=http:\/\/127\.0\.0\.1:5555/);
  });

  // `npm test` exports the caller's npm configuration as npm_config_*: the real global prefix arrived that way.
  test('applySuiteNpmGuard drops inherited npm_config_* of any case, and honours only the ORCH_TEST_NPM_* choice', () => {
    const env = { NPM_CONFIG_PREFIX: 'D:\\real', npm_config_registry: 'https://real.example', npm_config_cache: 'D:\\realcache' };
    const root = tmp('guard');
    const set = applySuiteNpmGuard(root, env);
    assert.ok(inside(env.NPM_CONFIG_PREFIX, root));
    assert.equal(env.npm_config_registry, undefined);
    assert.equal(env.NPM_CONFIG_REGISTRY, UNREACHABLE_REGISTRY);
    assert.ok(inside(env.NPM_CONFIG_CACHE, root));
    assert.ok(set.includes('NPM_CONFIG_USERCONFIG'));
    const chosen = { ORCH_TEST_NPM_PREFIX: 'D:\\mine' };
    applySuiteNpmGuard(tmp('guard2'), chosen);
    assert.equal(chosen.NPM_CONFIG_PREFIX, 'D:\\mine');
  });
});
