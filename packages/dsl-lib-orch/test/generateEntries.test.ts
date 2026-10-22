import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateEntries } from '../scripts/generate-entries.js';
import { LIB_ENTRIES } from '../src/paths.js';

describe('the generated entries file', () => {
  it('is what the generator produces now (run "npm run entries --workspace=packages/dsl-lib-orch" if not)', () => {
    expect(fs.existsSync(LIB_ENTRIES), `${LIB_ENTRIES} is missing: run "npm run entries --workspace=packages/dsl-lib-orch"`).toBe(true);
    expect(fs.readFileSync(LIB_ENTRIES, 'utf8').replace(/\r\n/g, '\n')).toBe(generateEntries());
    // Same limit as the Windows-listing test below: a generation parses every component with ts-morph and took 61 s
    // on a loaded macOS runner (run c49883d, "Test timed out in 60000ms", nothing failing), 45 s for its sibling.
  }, 240_000);
});

/*
 * dsl-renderer lists the component files with fs.readdirSync and never sorts them, so the order of the entries was the
 * file system's: case-insensitive on Windows (RunningAlertDetail before RunTelemetry), byte order on Linux and macOS
 * (the reverse). The file committed from a Windows machine then differed from what CI generated, and this test failed
 * on ubuntu and macOS only (run 432). The generator now sorts the listing itself; this checks that both orders give
 * the same file.
 */
describe('the generated entries do not depend on the file system listing order', () => {
  function withListing<T>(order: (a: string, b: string) => number, run: () => T): T {
    const real = fs.readdirSync;
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
      const result = (real as (...a: unknown[]) => unknown).apply(fs, args);
      return Array.isArray(result) && result.every((entry) => typeof entry === 'string') ? [...result].sort(order) : result;
    }) as typeof fs.readdirSync;
    try {
      return run();
    } finally {
      fs.readdirSync = real;
    }
  }

  const caseInsensitive = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase());

  // One generation, not two (each parses every component with ts-morph): the committed file is in byte order, which is
  // what the test above checks natively on Linux and macOS, so a Windows-style listing must give that same file.
  it('gives the committed file for a case-insensitive listing, the order Windows lists in', () => {
    const windows = withListing(caseInsensitive, () => generateEntries());

    expect(windows).toBe(fs.readFileSync(LIB_ENTRIES, 'utf8').replace(/\r\n/g, '\n'));
  }, 240_000);
});

/*
 * Older dsl-renderer generators emitted two defects that needed a patch after generation. Nothing patches
 * the file here, so a regression of the generator would otherwise surface as a type error or as a
 * RouterProvider that renders nothing, far from its cause.
 */
describe('the generator, defects of its older releases', () => {
  const source = generateEntries();

  it('gives RouterProvider its children', () => {
    expect(source).not.toContain('render: () => <RouterProvider />');
    expect(source).toContain('<RouterProvider>{items');
  });

  it('passes DataTableProps its type argument', () => {
    expect(source).not.toContain("DataTableProps['");
    expect(source).toContain("DataTableProps<Record<string, unknown>>['");
  });
});
