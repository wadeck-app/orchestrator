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

/*
 * Everything below was added after running mutation testing over these page files
 * (scripts/mutation-test.mjs). Renaming a single key in a page and re-running the suite showed
 * that half of the mutants survived: the checks above cover the component nodes and nothing else,
 * so the entire data and mutation layer of every page - `$sources`, `$brains`, and the event names
 * a node declares - was unverified. Concretely, these all passed the suite before:
 *
 *   url: -> urlZ:            a brain that fetches nothing
 *   $brain: -> $brainZ:      a brain with no implementation
 *   onToggle: -> onToggleZ:  a brain listening for an event the node never emits
 *   $type: -> $typeZ:        a node that renders nothing, which is the exact defect this
 *                            file was created for - `walk` identifies a node BY `$type`, so
 *                            renaming it made the node invisible to every check at once
 */

/** Route parameters the engine fills in by itself, from `$route: /jobs/:id`. */
function routeParams(page: Node): Set<string> {
  const route = typeof page['$route'] === 'string' ? page['$route'] : '';
  return new Set([...route.matchAll(/:(\w+)/g)].map(m => m[1]!));
}

/** `{id}` placeholders in a url or navigation target. */
function placeholders(template: unknown): string[] {
  return typeof template === 'string' ? [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]!) : [];
}

function entriesOf(page: Node, key: string): [string, Node][] {
  const map = page[key];
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return [];
  }
  return Object.entries(map as Node).map(([k, v]) => [k, v as Node]);
}

// Keys the engine consumes itself. Every other key on a brain is a URL parameter, so it is dead
// weight unless the template names it.
const BRAIN_ENGINE_KEYS = new Set(['$brain', '$reload', '$outputs', '_event', 'url', 'body', 'to', 'route', 'varName', 'value']);
const SOURCE_KEYS = new Set(['url', 'poll', 'params']);

describe('every object in a slot is a renderable node', () => {
  // `walk` recognises a node by its `$type`, so a node missing one is skipped by every other
  // check in this file rather than reported by it. The renderer has nothing to render.
  it.each(pageFiles)('%s has no slot entry without a $type', file => {
    const untyped: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            if (typeof (item as Node)['$type'] !== 'string') {
              untyped.push(`${path}[${i}]: ${JSON.stringify(Object.keys(item as Node))}`);
            }
          }
          visit(item, `${path}[${i}]`);
        });
        return;
      }
      if (value !== null && typeof value === 'object') {
        Object.entries(value as Node).forEach(([k, v]) => visit(v, `${path}.${k}`));
      }
    };
    // `$brains` and `$sources` are declarations, not nodes.
    Object.entries(pages.get(file)!)
      .filter(([k]) => k !== '$brains' && k !== '$sources')
      .forEach(([k, v]) => visit(v, k));

    expect(untyped).toEqual([]);
  });
});

describe('every event a brain listens for is an event some node emits', () => {
  /** node $id -> event name -> declared payload keys. */
  function declaredOutputs(page: Node): Map<string, Map<string, string[]>> {
    const byId = new Map<string, Map<string, string[]>>();
    for (const node of walk(page)) {
      const id = node['$id'], outputs = node['$outputs'];
      if (typeof id !== 'string' || outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
        continue;
      }
      byId.set(id, new Map(
        Object.entries(outputs as Node)
          .map(([event, payload]) => [event, Array.isArray(payload) ? payload.map(String) : []])
      ));
    }
    return byId;
  }

  // `$outputs.jobGrid.onToggle` naming an event the node does not declare is a brain that never
  // fires. The check above this one only proved the node id exists, so a renamed event name -
  // on either side - was invisible.
  it.each(pageFiles)('%s listens only for declared events', file => {
    const page = pages.get(file)!;
    const declared = declaredOutputs(page);
    const dangling = references(page)
      .filter(r => r.startsWith('$outputs.'))
      .filter(r => {
        const [, id, event] = r.split('.');
        const events = declared.get(id!);
        return events !== undefined && event !== undefined && !events.has(event);
      });

    expect([...new Set(dangling)]).toEqual([]);
  });

  // The payload key too: `$outputs.jobGrid.onToggle.action` is undefined at runtime unless
  // `onToggle` lists `action`, which is how a brain sends a request with a missing parameter.
  it.each(pageFiles)('%s reads only declared payload keys', file => {
    const page = pages.get(file)!;
    const declared = declaredOutputs(page);
    const dangling = references(page)
      .filter(r => r.startsWith('$outputs.'))
      .filter(r => {
        const [, id, event, key] = r.split('.');
        if (key === undefined) {
          return false;
        }
        const payload = declared.get(id!)?.get(event!);
        return payload !== undefined && !payload.includes(key);
      });

    expect([...new Set(dangling)]).toEqual([]);
  });
});

describe('every brain declares an implementation it can actually run', () => {
  const KNOWN_CTX = new Set(['$brains.$ctx.setVar', '$brains.$ctx.navigate', '$brains.$ctx.reload']);

  it.each(pageFiles)('%s declares a known $brain for every brain', file => {
    const bad: string[] = [];
    for (const [name, decl] of entriesOf(pages.get(file)!, '$brains')) {
      const ref = decl['$brain'];
      if (typeof ref !== 'string') {
        bad.push(`${name}: no $brain`);
      } else if (!ref.startsWith('$brains.$http.') && !KNOWN_CTX.has(ref)) {
        bad.push(`${name}: unknown brain ${ref}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // An $http brain with no `url`, or a navigate with neither `to` nor `route`, is silently a
  // no-op: useBrains returns early on a falsy target rather than reporting it.
  it.each(pageFiles)('%s gives every brain the parameters its kind requires', file => {
    const missing: string[] = [];
    for (const [name, decl] of entriesOf(pages.get(file)!, '$brains')) {
      const ref = decl['$brain'];
      if (typeof ref !== 'string') {
        continue; // reported above
      }
      if (ref.startsWith('$brains.$http.') && typeof decl['url'] !== 'string') {
        missing.push(`${name}: $http brain without a url`);
      }
      if (ref === '$brains.$ctx.navigate' && typeof decl['to'] !== 'string' && typeof decl['route'] !== 'string') {
        missing.push(`${name}: navigate without a to/route`);
      }
      if (ref === '$brains.$ctx.setVar' && (typeof decl['varName'] !== 'string' || decl['value'] === undefined)) {
        missing.push(`${name}: setVar without varName/value`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Both directions. A placeholder with no source resolves to the literal `{id}` in the request
  // path; a parameter no template names is a value computed and thrown away.
  it.each(pageFiles)('%s resolves every url placeholder and uses every parameter', file => {
    const page = pages.get(file)!;
    const fromRoute = routeParams(page);
    const problems: string[] = [];
    for (const [name, decl] of entriesOf(page, '$brains')) {
      const template = decl['url'] ?? decl['to'] ?? decl['route'];
      const named = placeholders(template);
      const params = Object.keys(decl).filter(k => !BRAIN_ENGINE_KEYS.has(k));
      for (const p of named) {
        if (!fromRoute.has(p) && !params.includes(p)) {
          problems.push(`${name}: {${p}} has no route param and no brain param`);
        }
      }
      for (const p of params) {
        if (!named.includes(p)) {
          problems.push(`${name}: parameter "${p}" is not used by the template`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(pageFiles)('%s reloads only declared sources', file => {
    const page = pages.get(file)!;
    const declared = new Set(Object.keys((page['$sources'] as Node) ?? {}));
    const unknown: string[] = [];
    for (const [name, decl] of entriesOf(page, '$brains')) {
      const reload = decl['$reload'];
      if (!Array.isArray(reload)) {
        continue;
      }
      reload.filter(s => !declared.has(String(s))).forEach(s => unknown.push(`${name}: $reload ${String(s)}`));
    }
    expect(unknown).toEqual([]);
  });
});

describe('every source declares a request it can actually make', () => {
  it.each(pageFiles)('%s gives every source a url and no unknown keys', file => {
    const problems: string[] = [];
    for (const [name, decl] of entriesOf(pages.get(file)!, '$sources')) {
      if (typeof decl['url'] !== 'string') {
        problems.push(`${name}: no url`);
      }
      Object.keys(decl).filter(k => !SOURCE_KEYS.has(k)).forEach(k => problems.push(`${name}: unknown key "${k}"`));
    }
    expect(problems).toEqual([]);
  });

  it.each(pageFiles)('%s resolves every source url placeholder', file => {
    const page = pages.get(file)!;
    const fromRoute = routeParams(page);
    const problems: string[] = [];
    for (const [name, decl] of entriesOf(page, '$sources')) {
      const params = decl['params'];
      const paramKeys = params !== null && typeof params === 'object' ? Object.keys(params as Node) : [];
      const named = placeholders(decl['url']);
      for (const p of named) {
        if (!fromRoute.has(p) && !paramKeys.includes(p)) {
          problems.push(`${name}: {${p}} has no route param and no source param`);
        }
      }
      for (const p of paramKeys) {
        if (!named.includes(p)) {
          problems.push(`${name}: param "${p}" is not used by the url`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// Guards the guards. Every check above passes trivially on an empty collection, so a helper that
// silently stops finding brains, sources or outputs would turn this whole file green while
// verifying nothing - the same failure mode as a test that skips its own assertion.
describe('the new checks are looking at something', () => {
  it('finds brains, sources and declared outputs across the pages', () => {
    const all = [...pages.values()];
    const brains = all.flatMap(p => entriesOf(p, '$brains'));
    const sources = all.flatMap(p => entriesOf(p, '$sources'));
    const outputs = all.flatMap(p => walk(p).filter(n => n['$outputs'] !== undefined));

    expect(brains.length).toBeGreaterThan(15);
    expect(sources.length).toBeGreaterThan(5);
    expect(outputs.length).toBeGreaterThan(5);
    // A page with a templated url has to be in the set, or the placeholder checks never run.
    expect(brains.some(([, d]) => placeholders(d['url'] ?? d['to'] ?? d['route']).length > 0)).toBe(true);
  });

  it('extracts route parameters and placeholders', () => {
    expect([...routeParams({ $route: '/jobs/:id/logs' })]).toEqual(['id']);
    expect(placeholders('POST /api/jobs/{id}/{action}')).toEqual(['id', 'action']);
    expect(placeholders(undefined)).toEqual([]);
  });
});
