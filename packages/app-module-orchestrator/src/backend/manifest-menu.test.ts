import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface Point {
  kind: string;
  slot: string;
  path?: string;
}
const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as { extensionPoints: Point[] };
const pages = manifest.extensionPoints.filter((p): p is Point & { path: string } => p.kind === 'page' && typeof p.path === 'string');

// The rule of the shell (app-core frontend-shell, layout/navModel.ts isPageCurrent): a menu page whose path is "/" is `exact` and
// highlights only itself; any other menu page highlights its own path and the routes below it. A route page that no menu page
// highlights leaves the left menu with nothing highlighted (seen in a browser on /modules/orchestrator/jobs/<id>, reported by
// the owner of another module with the same manifest shape).
const isUnder = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`);
const highlights = (menuPath: string, route: string): boolean => (menuPath === '/' ? route === '/' : isUnder(route, menuPath));
// A parameter stands for any value.
const sample = (path: string): string => path.replace(/:[A-Za-z]+/g, 'x');

describe('left menu: a page of the module always highlights an entry', () => {
  const menu = pages.filter((p) => p.slot === 'nav');
  const routes = pages.filter((p) => p.slot !== 'nav' && p.path !== '/');

  it('has menu pages and route pages (the test would pass for nothing otherwise)', () => {
    expect(menu.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes.map((r) => r.path))('the route page %s is under a menu page that is not the exact module home', (route) => {
    const owners = menu.filter((m) => highlights(m.path, sample(route)));
    expect(owners.map((m) => m.path), `no menu page highlights ${route}: put it under a menu page (a path starting with the path of one), the home "/" only highlights itself`).not.toHaveLength(0);
  });

  it('has a page at the module home, so the entry of the module in the top bar opens something', () => {
    expect(pages.some((p) => p.path === '/')).toBe(true);
  });
});
