import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODULE_ID } from '@wadeck-app/orch-dsl-lib/moduleConfig';

/*
 * app-core refuses a module whose manifest.json has no `id`, or one that differs from the id it is registered
 * under (decision 83 in app-core, enforced since app-core-cli 029). The module then sits in app-core's `failed`
 * list with "id: Required", the dashboard pages are gone, and nothing on this side fails: the daemon's log says
 * "registered" or logs the refusal, long after the commit that caused it.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8')) as { id?: unknown };

describe('manifest.json', () => {
  it('declares its own id', () => {
    expect(manifest.id, 'manifest.json needs an "id": app-core marks a module without one as failed').toBeTypeOf('string');
  });

  it('declares the id the dashboard routes, the api and the daemon use', () => {
    expect(manifest.id).toBe(MODULE_ID);
  });
});
