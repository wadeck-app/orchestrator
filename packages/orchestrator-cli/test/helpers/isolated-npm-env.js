'use strict';

// Test helper (not shipped): an environment in which npm cannot reach the real machine.
//
// Incident 2026-10-24: an integration test ran a repo-built bundle's `cli update` against the real config dir and the
// real global npm. The `npm install -g` it started was killed halfway and left the global CLI uninstalled, with no state,
// no log and no rollback. Anything in a test that can run the updater, UpdateManager, `orch cli update` or an npm
// command gets this environment: a throwaway global prefix, a throwaway cache, npm config files of its own (the user-level
// npm config carries the scope registry and the auth token), and a registry nothing listens on, so a network access
// fails at once instead of installing. The scope registry gets its own variable: the repository's project-level npm
// config also names https://npm.pkg.github.com for @wadeck-app, it is read from the working directory of a test, and
// a scope registry beats `registry` (measured: `npm view` from a test reached GitHub Packages until this was added).
const fs = require('node:fs');
const path = require('node:path');

/** Nothing listens on the discard port: an npm network access fails fast. */
const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9';

// Names that steer the updater, the launcher or npm. A value leaked from the developer's shell must not change a test.
const STEERING = /^(UPDATER_|LAUNCHER_|NPM_CONFIG_)/i;

// Environment config outranks the project-level and user-level files.
const SCOPE_REGISTRY_VAR = 'npm_config_@wadeck-app:registry';

/**
 * Creates the throwaway npm tree under `root` and returns the variables that point npm at it.
 * @param {string} root an existing, throwaway directory
 * @param {{ registry?: string }} [opts] registry defaults to UNREACHABLE_REGISTRY; pass a mock registry to exercise a real install
 */
function npmIsolationVars(root, opts = {}) {
  const registry = opts.registry ?? UNREACHABLE_REGISTRY;
  const prefix = path.join(root, 'npm-prefix');
  const cache = path.join(root, 'npm-cache');
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const rc = `registry=${registry}\n@wadeck-app:registry=${registry}\nfetch-retries=0\nfetch-timeout=3000\naudit=false\nfund=false\nupdate-notifier=false\n`;
  // Two files: npm refuses to use the same one for the user and the global level.
  const userConfig = path.join(root, 'npm-user.ini');
  const globalConfig = path.join(root, 'npm-global.ini');
  fs.writeFileSync(userConfig, rc);
  fs.writeFileSync(globalConfig, rc);
  return {
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_REGISTRY: registry,
    [SCOPE_REGISTRY_VAR]: registry,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
  };
}

/**
 * A full environment for a spawned process: `base` minus the steering variables, plus the isolation. `opts.extra` goes last.
 */
function createIsolatedNpmEnv(root, opts = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!STEERING.test(k)) {
      env[k] = v;
    }
  }
  return Object.assign(env, npmIsolationVars(root, opts), opts.extra);
}

/**
 * The suite-wide guard, applied by the preload to the test process itself (children inherit it).
 * Every npm_config_* variable already in the environment is dropped first, whatever its case: `npm test` exports the
 * caller's whole npm configuration that way (measured: the real global prefix reached the tests through it), so a
 * variable found there cannot be told from a deliberate choice. A deliberate choice is made with
 * ORCH_TEST_NPM_PREFIX / ORCH_TEST_NPM_REGISTRY (the registry also serves @wadeck-app).
 * @returns {string[]} the names it set
 */
function applySuiteNpmGuard(root, env = process.env) {
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) {
      delete env[key];
    }
  }
  const vars = npmIsolationVars(root, { registry: env.ORCH_TEST_NPM_REGISTRY || undefined });
  if (env.ORCH_TEST_NPM_PREFIX) {
    vars.NPM_CONFIG_PREFIX = env.ORCH_TEST_NPM_PREFIX;
  }
  Object.assign(env, vars);
  return Object.keys(vars);
}

module.exports = { SCOPE_REGISTRY_VAR, UNREACHABLE_REGISTRY, npmIsolationVars, createIsolatedNpmEnv, applySuiteNpmGuard };
