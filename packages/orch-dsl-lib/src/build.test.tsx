// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComponentRegistryEntry } from '@wadeck-app/dsl-renderer';
import { OUT_DIR_VAR } from './out-dir.js';
import { listLibTypes } from './libTypes.js';
import { ORCH_APP_ENTRIES } from './paths.js';

/*
 * What app-core does with a module's dsl-lib: set the shared packages on a global, import the bundle,
 * register its entries. This does the same with the real packages, because a bundle can pass every
 * unit test of its sources and still break once built: a second copy of React, a config module
 * duplicated between the components and the entry that configures them.
 */
let outDir: string;
let entries: ComponentRegistryEntry[];
let bundleSource: string;

beforeAll(async () => {
  const built = process.env[OUT_DIR_VAR];
  if (built === undefined) {
    throw new Error(`${OUT_DIR_VAR} is not set: the bundle is built by global-setup.ts, check that vitest.config.ts still lists it.`);
  }
  outDir = built;
  bundleSource = fs.readFileSync(path.join(outDir, 'entries.mjs'), 'utf8');

  globalThis.__APP_CORE_SHARED__ = {
    'react': await import('react'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    'react-router-dom': await import('react-router-dom'),
    '@wadeck-app/dsl-ui': await import('@wadeck-app/dsl-ui'),
    '@wadeck-app/dsl-renderer': await import('@wadeck-app/dsl-renderer'),
  };
  // A data: URL, not the file's: vitest's module runner cannot import an ES module that sits outside the
  // project ("Cannot find module"), while a data: URL goes to Node's own import, as app-core's does.
  const dataUrl = `data:text/javascript;base64,${Buffer.from(bundleSource).toString('base64')}`;
  const loaded = await import(/* @vite-ignore */ dataUrl) as { default: ComponentRegistryEntry[] };
  entries = loaded.default;
}, 120_000);

afterAll(() => {
  globalThis.__APP_CORE_SHARED__ = undefined;
});

describe('the dsl-lib bundle', () => {
  it('produces the entry and the stylesheet the manifest points at', () => {
    expect(fs.existsSync(path.join(outDir, 'entries.mjs'))).toBe(true);
    expect(fs.statSync(path.join(outDir, 'style.css')).size).toBeGreaterThan(1000);
  });

  /*
   * The shell loads this sheet after its own. A utility both sheets define, repeated here without its
   * longhand siblings, overrides the shell's: orch-ui uses `px-2`, dsl-ui's SearchBar has `px-2 pl-7`,
   * and the sheet that only knew `px-2` shrank the search field's left padding and put the magnifier on
   * the placeholder. So the sheet is a superset: it also scans dsl-ui, and keeps Tailwind's own order.
   */
  it('carries dsl-ui\'s utilities in Tailwind\'s order, so it cannot override the shell\'s with a shorthand alone', () => {
    const css = fs.readFileSync(path.join(outDir, 'style.css'), 'utf8');
    const shorthand = css.indexOf('.px-2 {');
    const longhand = css.indexOf('.pl-7 {');
    expect(shorthand, '.px-2 is missing').toBeGreaterThan(-1);
    expect(longhand, '.pl-7 (used by dsl-ui\'s SearchBar) is missing: the sheet does not scan dsl-ui').toBeGreaterThan(-1);
    expect(longhand, '.pl-7 must come after .px-2 or it loses to it').toBeGreaterThan(shorthand);
  });

  it('exports exactly the library types: orch-ui\'s components and the wired built-ins, no other dsl-ui entry', () => {
    const expected = listLibTypes(fs.readFileSync(ORCH_APP_ENTRIES, 'utf8'));
    expect(entries.map(e => e.name).sort()).toEqual(expected);
    expect(entries.map(e => e.name)).toContain('JobCardGrid');
    expect(entries.map(e => e.name)).not.toContain('Badge');
  });

  it('carries no copy of React or of dsl-ui: those come from the shell, two copies break hooks and contexts', () => {
    expect(bundleSource).not.toMatch(/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|ReactCurrentDispatcher/);
    expect(bundleSource).not.toMatch(/@radix-ui/);
    expect(bundleSource).toContain('__APP_CORE_SHARED__');
  });

  it('wires events for SearchBar like orch-app does: the shell\'s own SearchBar publishes nothing', async () => {
    const searchBar = entries.find(e => e.name === 'SearchBar')!;
    const published: unknown[][] = [];
    const ctx = { $publishOutput: (...args: unknown[]) => { published.push(args); } };
    const node = { $type: 'SearchBar', $id: 'bar', $outputs: { onChange: ['value'] }, value: '', placeholder: 'Search', debounceMs: 0 };

    render(<>{searchBar.render({ node, registry: {}, ctx } as never)}</>);
    await userEvent.setup().type(screen.getByRole('searchbox'), 'abc');

    await waitFor(() => { expect(published.length).toBeGreaterThan(0); });
    expect(published[0]!.slice(0, 2)).toEqual(['bar', 'onChange']);
  });

  it('calls the module\'s own API, not /api: its components and the entry that configures them share one config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const toggle = entries.find(e => e.name === 'JobToggle')!;
    const job = { id: 'j1', type: 'cron', label: 'Job', command: 'echo', schedule: '* * * * *', enabled: true, triggerMode: 'fire-and-forget' };

    render(<>{toggle.render({ node: { $type: 'JobToggle', job }, registry: {}, ctx: {} } as never)}</>);
    screen.getByRole('switch').click();

    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/modules/orchestrator/api/jobs/j1/disable', { method: 'POST' });
    fetchMock.mockRestore();
  });

  it('links to the module\'s own routes, not the root', () => {
    const switcher = entries.find(e => e.name === 'DesignSwitcher')!;
    render(
      <React.Fragment>{switcher.render({ node: { $type: 'DesignSwitcher', jobId: 'j1' }, registry: {}, ctx: {} } as never)}</React.Fragment>,
    );
    expect(screen.getByRole('link', { name: 'Default' })).toHaveAttribute('href', '/modules/orchestrator/jobs/j1');
  });
});
