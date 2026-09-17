/**
 * Wiring tests over the REAL page files in src/dsl/pages.
 *
 * integration.test.tsx deliberately mounts inline YAML strings, so nothing checked the
 * files the app actually ships. That gap let a page break silently: a HorizontalStack was
 * given a `children` slot where the registry entry reads `items`, so both controls vanished
 * from the job list while the build and every test stayed green. Only a screenshot caught
 * it.
 *
 * These tests are static: they read the YAML and the generated registry, and need no DOM.
 * That keeps them fast enough to cover every page and every node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(HERE, 'dsl', 'pages');
const ENTRIES_FILE = path.join(HERE, 'generated', 'entries.tsx');

type Node = Record<string, unknown>;

const pageFiles = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.yaml')).sort();

/** Parsed pages, keyed by file name. */
const pages = new Map<string, Node>(
  pageFiles.map(f => [f, parseYaml(fs.readFileSync(path.join(PAGES_DIR, f), 'utf8')) as Node])
);

/**
 * Prop keys each registry entry actually reads, taken from the generated render bodies.
 *
 * The generator emits `node['gap']` for a prop and `node['items']` for a slot, so a key
 * absent here is a key the component will never see - which is exactly the failure mode
 * this file exists for.
 */
function readKeysByType(): Map<string, Set<string>> {
  const src = fs.readFileSync(ENTRIES_FILE, 'utf8');
  const byType = new Map<string, Set<string>>();
  // Entries are emitted as `export const XEntry: ComponentRegistryEntry = { name: 'X', ... }`.
  const blocks = src.split(/export const \w+Entry: ComponentRegistryEntry = \{/).slice(1);
  for (const block of blocks) {
    const name = /name: '([^']+)'/.exec(block)?.[1];
    if (!name) {
      continue;
    }
    const keys = new Set([...block.matchAll(/node\['([^']+)'\]/g)].map(m => m[1]!));
    byType.set(name, keys);
  }
  return byType;
}

const readKeys = readKeysByType();

/** Every node in a page tree, depth-first. */
function walk(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    node.forEach(n => walk(n, out));
    return out;
  }
  if (node === null || typeof node !== 'object') {
    return out;
  }
  const obj = node as Node;
  if (typeof obj['$type'] === 'string') {
    out.push(obj);
  }
  Object.values(obj).forEach(v => walk(v, out));
  return out;
}

/** Every `$sources.x` / `$vars.x` / `$outputs.x` reference in a page, as raw strings. */
function references(page: Node): string[] {
  const found: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      found.push(...(v.match(/\$(?:sources|vars|outputs|brains)\.[\w.]+/g) ?? []));
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v !== null && typeof v === 'object') {
      Object.values(v as Node).forEach(visit);
    }
  };
  visit(page);
  return found;
}

describe('every page file is parseable and declares a route', () => {
  it('finds page files at all', () => {
    expect(pageFiles.length).toBeGreaterThan(5);
  });

  it.each(pageFiles)('%s parses and has a $route and a $type', file => {
    const page = pages.get(file)!;
    expect(typeof page['$route']).toBe('string');
    expect(typeof page['$type']).toBe('string');
  });
});

describe('every $type used by a page is registered', () => {
  it.each(pageFiles)('%s uses only registered components', file => {
    const unknown = walk(pages.get(file))
      .map(n => n['$type'] as string)
      .filter(t => !readKeys.has(t));

    expect(unknown).toEqual([]);
  });
});

// The regression this file was written for.
describe('every prop a page sets is a prop the component receives', () => {
  // Conventions handled by the engine, not passed through to the component.
  const ENGINE_KEYS = new Set(['$type', '$id', '$outputs', '$route', '$sources', '$brains', '$vars', '$reload', '$brain']);

  it.each(pageFiles)('%s sets no prop the registry entry ignores', file => {
    const ignored: string[] = [];
    for (const node of walk(pages.get(file))) {
      const type = node['$type'] as string;
      const known = readKeys.get(type);
      if (!known) {
        continue; // unregistered types are reported by the test above
      }
      for (const key of Object.keys(node)) {
        if (!ENGINE_KEYS.has(key) && !known.has(key)) {
          ignored.push(`${type}.${key}`);
        }
      }
    }

    expect(ignored).toEqual([]);
  });

  // Guards the guard: if the parse of the generated file ever returns nothing, the test
  // above would pass for every page while checking nothing at all.
  it('extracted prop keys from the generated registry', () => {
    expect(readKeys.size).toBeGreaterThan(20);
    expect(readKeys.get('HorizontalStack')).toContain('items');
    expect(readKeys.get('SearchBar')).toContain('value');
  });
});

describe('every reference a page makes resolves within that page', () => {
  it.each(pageFiles)('%s references only declared sources', file => {
    const page = pages.get(file)!;
    const declared = new Set(Object.keys((page['$sources'] as Node) ?? {}));
    const missing = references(page)
      .filter(r => r.startsWith('$sources.'))
      .map(r => r.split('.')[1]!)
      .filter(name => !declared.has(name));

    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(pageFiles)('%s references only declared vars', file => {
    const page = pages.get(file)!;
    const declared = new Set(Object.keys((page['$vars'] as Node) ?? {}));
    const missing = references(page)
      .filter(r => r.startsWith('$vars.'))
      .map(r => r.split('.')[1]!)
      .filter(name => !declared.has(name));

    expect([...new Set(missing)]).toEqual([]);
  });

  // A brain wired to $outputs.someId.onX is dead unless a node carries that $id. This is
  // how a button can look connected and do nothing.
  it.each(pageFiles)('%s wires outputs only to nodes that carry the $id', file => {
    const page = pages.get(file)!;
    const ids = new Set(walk(page).map(n => n['$id']).filter((v): v is string => typeof v === 'string'));
    const missing = references(page)
      .filter(r => r.startsWith('$outputs.'))
      .map(r => r.split('.')[1]!)
      .filter(id => !ids.has(id));

    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(pageFiles)('%s references only declared brains', file => {
    const page = pages.get(file)!;
    const declared = new Set(Object.keys((page['$brains'] as Node) ?? {}));
    const missing = references(page)
      .filter(r => r.startsWith('$brains.') && !r.startsWith('$brains.$'))
      .map(r => r.split('.')[1]!)
      .filter(name => !declared.has(name));

    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('a node that declares $outputs is reachable by a brain', () => {
  it.each(pageFiles)('%s has no $id whose outputs nothing consumes', file => {
    const page = pages.get(file)!;
    const consumed = new Set(
      references(page).filter(r => r.startsWith('$outputs.')).map(r => r.split('.')[1]!)
    );
    // An $id with declared $outputs that no brain reads is a control wired to nothing.
    const orphans = walk(page)
      .filter(n => typeof n['$id'] === 'string' && n['$outputs'] !== undefined)
      .map(n => n['$id'] as string)
      .filter(id => !consumed.has(id));

    expect(orphans).toEqual([]);
  });
});
