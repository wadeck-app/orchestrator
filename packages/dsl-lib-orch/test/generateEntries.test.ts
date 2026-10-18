import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateEntries } from '../scripts/generate-entries.js';
import { LIB_ENTRIES } from '../src/paths.js';

describe('the generated entries file', () => {
  it('is what the generator produces now (run "npm run entries --workspace=packages/dsl-lib-orch" if not)', () => {
    expect(fs.existsSync(LIB_ENTRIES), `${LIB_ENTRIES} is missing: run "npm run entries --workspace=packages/dsl-lib-orch"`).toBe(true);
    expect(fs.readFileSync(LIB_ENTRIES, 'utf8').replace(/\r\n/g, '\n')).toBe(generateEntries());
  }, 60_000);
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
