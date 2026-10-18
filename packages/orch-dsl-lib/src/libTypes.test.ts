import { describe, expect, it } from 'vitest';
import { LIB_EXTRA_TYPES, listLibTypes, readOrchUiTypes } from './libTypes.js';

/*
 * The dsl-lib ships the components of orch-ui, plus the few dsl-ui built-ins its registry overrides wire to
 * the pages. This list is what the bundle exports AND what the module's pages prefix with the module id,
 * so it has to be one list: two lists is how a page names a type the bundle does not contain.
 */
describe('readOrchUiTypes', () => {
  it('lists the components generated entries import from orch-ui, and only those', () => {
    const source = [
      "import { Badge } from '@wadeck-app/dsl-ui/dist/components/display/Badge.js'",
      "import { JobCardGrid } from '../../../orch-ui/src/components/JobCardGrid.js'",
      "import { RunHistory } from '../../../orch-ui/src/components/RunHistory.js'",
    ].join('\n');
    expect([...readOrchUiTypes(source)].sort()).toEqual(['JobCardGrid', 'RunHistory']);
  });

  it('throws when it finds none, since an empty list would silently ship an empty library', () => {
    expect(() => readOrchUiTypes("import { Badge } from '@wadeck-app/dsl-ui/x.js'")).toThrow(/orch-ui/);
  });
});

describe('listLibTypes', () => {
  const source = "import { JobCardGrid } from '../../../orch-ui/src/components/JobCardGrid.js'";

  it('adds the dsl-ui built-ins the library re-exports with their events wired', () => {
    expect(LIB_EXTRA_TYPES).toContain('SearchBar');
    expect(listLibTypes(source)).toEqual(['JobCardGrid', 'SearchBar']);
  });

  it('is sorted and has no duplicate, so the generated bundle entry is stable', () => {
    const twice = `${source}\nimport { SearchBar } from '../../../orch-ui/src/components/SearchBar.js'`;
    expect(listLibTypes(twice)).toEqual(['JobCardGrid', 'SearchBar']);
  });
});
