import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { buildBackend } from '../scripts/build-backend.mjs';
import { ALLOWED_ROUTES } from './routes.js';

/*
 * The unit tests run the TypeScript sources; app-core runs the bundle. This builds the bundle the way
 * `npm run build` does and loads it the way app-core's loader does (dynamic import, default export
 * called with a context), because a bundle can break in ways the sources never do: a `require` left
 * inside an ES module, a dependency that was not inlined.
 */
let outDir: string;
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-module-build-')); });
afterEach(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe('the backend bundle', () => {
  it('loads as an ES module and registers exactly the allowed routes', async () => {
    const outfile = path.join(outDir, 'backend.mjs');
    await buildBackend({ outfile });

    const loaded = await import(pathToFileURL(outfile).href) as { default: (ctx: ModuleContext) => Promise<void> };
    const registerRoute = vi.fn();
    await loaded.default({ registerRoute } as unknown as ModuleContext);

    expect(registerRoute.mock.calls.map(([method, subPath]) => `${method} ${subPath}`).sort())
      .toEqual([...ALLOWED_ROUTES].sort());
  });

  it('is self-contained: it imports no package at runtime, since app-core cannot resolve the module\'s dependencies', async () => {
    const outfile = path.join(outDir, 'backend.mjs');
    await buildBackend({ outfile });

    const source = fs.readFileSync(outfile, 'utf8');
    const bareImports = [...source.matchAll(/^import .* from ["']([^"'./][^"']*)["']/gm)]
      .map(m => m[1]!)
      .filter(spec => !spec.startsWith('node:'));
    expect(bareImports).toEqual([]);
  });
});
