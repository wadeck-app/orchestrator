import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { OUT_DIR_VAR } from './out-dir.js';
import { MODULE_DIR } from '../src/paths.js';
import { MODULE_ID } from '@wadeck-app/app-module-orchestrator/moduleConfig';

/*
 * app-core refuses a module whose manifest.json has no `id`, or one that differs from the id it is registered
 * under (decision 83 in app-core, enforced since app-core-cli 029). The module then sits in app-core's `failed`
 * list with "id: Required", the dashboard pages are gone, and nothing on this side fails: the daemon's log says
 * "registered" or logs the refusal, long after the commit that caused it.
 */
const packageDir = MODULE_DIR;
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8')) as { id?: unknown };

describe('manifest.json', () => {
  it('declares its own id', () => {
    expect(manifest.id, 'manifest.json needs an "id": app-core marks a module without one as failed').toBeTypeOf('string');
  });

  it('declares the id the dashboard routes, the api and the daemon use', () => {
    expect(manifest.id).toBe(MODULE_ID);
  });
});

/*
 * The source manifest is what is edited; the packaged one is what the daemon registers and app-core loads.
 * `app-core-cli package` rewrites the paths and stamps the version, and its own check only proves the files
 * exist. These say that what the daemon ships is the whole module and nothing points back into the sources.
 */
describe('the packaged manifest (dist-module/manifest.json)', () => {
  interface Packaged {
    id: string;
    version: string;
    backendEntryPath: string;
    dslLib: { entry: string; css: string; shared: Record<string, string> };
    extensionPoints: Array<{ view: { type: string; value: string } }>;
  }
  let packagedDir: string;
  let packaged: Packaged;

  beforeAll(() => {
    const dir = process.env[OUT_DIR_VAR];
    if (dir === undefined) {
      throw new Error(`${OUT_DIR_VAR} is not set: the module is packaged by global-setup.ts, check that vitest.config.ts still lists it.`);
    }
    packagedDir = dir;
    packaged = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Packaged;
  });

  it('keeps the id and stamps the version it was packaged with', () => {
    expect(packaged.id).toBe(MODULE_ID);
    expect(packaged.version).toBe('0.0.0-test');
  });

  it('points the backend, the components, the stylesheet and every view at files inside the package', () => {
    const named = [
      packaged.backendEntryPath,
      packaged.dslLib.entry,
      packaged.dslLib.css,
      ...packaged.extensionPoints.filter(e => e.view.type === 'path').map(e => e.view.value),
    ];
    expect(named.length).toBeGreaterThan(10);
    for (const rel of named) {
      expect(rel, `${rel} points back into the sources`).not.toMatch(/\bsrc\//);
      expect(fs.existsSync(path.join(packagedDir, rel)), `${rel} is named by the packaged manifest but was not written`).toBe(true);
    }
  });

  it('declares the same shared ranges as the source, so the shell checks what the module was built against', () => {
    expect(packaged.dslLib.shared).toEqual((manifest as { dslLib: { shared: unknown } }).dslLib.shared);
  });
});

/*
 * app-core's dashboard is a grid of 100px cells. A widget without `width` gets 2 cells (216px) and widens itself
 * when its content overflows, so the tile's size depended on what was inside. The dashboard widget is sized for the
 * three figures side by side.
 */
describe('manifest.json - the dashboard widget size', () => {
  const widgets = (manifest as unknown as { extensionPoints: Array<{ kind: string; slot: string; label: string; width?: unknown }> })
    .extensionPoints.filter(e => e.kind === 'widget' && e.slot === 'dashboard');

  it('declares the dashboard widget', () => {
    expect(widgets.map(w => w.label)).toEqual(['Orchestrator']);
  });

  it('gives every dashboard widget an explicit width in cells, between 1 and 12', () => {
    for (const w of widgets) {
      expect(w.width, `${w.label} has no "width": app-core gives it 2 cells and widens it on overflow`).toBeTypeOf('number');
      expect(Number.isInteger(w.width) && (w.width as number) >= 1 && (w.width as number) <= 12, `${w.label}: width must be an integer of 1-12 cells`).toBe(true);
    }
  });

  it('makes the Orchestrator widget 4 cells wide: 416px of content, room for three figures side by side without a wrapped label', () => {
    expect(widgets.find(w => w.label === 'Orchestrator')?.width).toBe(4);
  });
});
