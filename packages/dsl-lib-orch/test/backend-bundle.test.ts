import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { OUT_DIR_VAR } from './out-dir.js';
import { ALLOWED_ROUTES } from '@wadeck-app/app-module-orchestrator/routes';

/*
 * The unit tests in app-module-orchestrator run the TypeScript sources; app-core runs the bundle
 * `app-core-cli package` makes of them. This loads that bundle the way app-core's loader does (dynamic
 * import, default export called with a context), because a bundle can break in ways the sources never do:
 * a `require` of a package that was not inlined, a default export that is not the function itself.
 */
let backendFile: string;

/**
 * Loads the bundle in a fresh Node process with its own import(), as app-core's loader does, and returns
 * the type of the default export and the routes the setup registered. Not in-process: vitest's module
 * runner hands back a namespace object where the real loader gets the function.
 */
function loadLikeAppCore(file: string): { type: string; routes: string[] } {
  const script = [
    'const loaded = await import(process.argv[1]);',
    'const routes = [];',
    'if (typeof loaded.default === "function") {',
    '  await loaded.default({ registerRoute: (method, subPath) => { routes.push(method + " " + subPath); } });',
    '}',
    'process.stdout.write(JSON.stringify({ type: typeof loaded.default, routes }));',
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(file).href], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) {
    throw new Error(`Loading ${file} failed (exit ${String(run.status)}): ${run.stderr}`);
  }
  return JSON.parse(run.stdout) as { type: string; routes: string[] };
}

beforeAll(() => {
  const packaged = process.env[OUT_DIR_VAR];
  if (packaged === undefined) {
    throw new Error(`${OUT_DIR_VAR} is not set: the module is packaged by global-setup.ts, check that vitest.config.ts still lists it.`);
  }
  backendFile = path.join(packaged, 'api-backend', 'backend.cjs');
});

describe('the packaged backend', () => {
  it('loads with a function as its default export and registers exactly the allowed routes', () => {
    const loaded = loadLikeAppCore(backendFile);

    expect(loaded.type, 'app-core needs the default export to be the setup function itself').toBe('function');
    expect(loaded.routes.sort()).toEqual([...ALLOWED_ROUTES].sort());
  });

  it('is self-contained: it requires no package at runtime, since app-core cannot resolve the module\'s dependencies', () => {
    const source = fs.readFileSync(backendFile, 'utf8');
    const requires = [...source.matchAll(/\brequire\(["']([^"'./][^"']*)["']\)/g)]
      .map(m => m[1]!)
      .filter(spec => !spec.startsWith('node:') && !builtinModules.includes(spec));
    expect(requires).toEqual([]);
  });

  it('uses no raw timer of its own: the log stream\'s poll goes through the context', () => {
    const source = fs.readFileSync(backendFile, 'utf8');
    // The only setInterval left in the bundle is the global fallback orch-core uses when no timers are passed.
    expect(source).toMatch(/timers\.setInterval\(/);
    expect(source).not.toMatch(/\bpollTimer = setInterval\(/);
  });
});
