import { describe, expect, it } from 'vitest';
import { derivePage, readOrchUiTypes, type DeriveOptions } from './derivePages.js';

/*
 * The module's pages are orch-app's pages, rewritten for where they are mounted. Deriving them keeps
 * orch-app the single source of truth: a page fixed there reaches the module on the next derive
 * instead of drifting in a hand-kept copy. The rewrite is textual, not parse-and-dump, so the
 * comments that explain why a page is shaped the way it is survive.
 */
const OPTS: DeriveOptions = {
  moduleId: 'orchestrator',
  routePrefix: '/modules/orchestrator',
  apiPrefix: '/api/modules/orchestrator',
  orchTypes: new Set(['JobCardGrid', 'RunHistory', 'MutationFeedback']),
};

describe('derivePage', () => {
  it('drops the $route line: the manifest owns the path in a module', () => {
    expect(derivePage('$route: /jobs/:id\n\n$sources:\n  a: 1\n', OPTS)).toBe('$sources:\n  a: 1\n');
  });

  it('fails loudly on a page with no $route, instead of guessing it is a fragment', () => {
    expect(() => derivePage('$type: PageContent\n', OPTS)).toThrow(/\$route/);
  });

  it('prefixes the type of an orch-ui component, wherever it is nested', () => {
    const out = derivePage('$route: /\n$type: PageContent\nsections:\n  - $type: JobCardGrid\n    items:\n      - $type: RunHistory\n', OPTS);
    expect(out).toContain('  - $type: orchestrator:JobCardGrid');
    expect(out).toContain('      - $type: orchestrator:RunHistory');
  });

  it('leaves dsl-ui types alone', () => {
    const out = derivePage('$route: /\n$type: PageContent\nsections:\n  - $type: PageHeader\n  - $type: SearchBar\n', OPTS);
    expect(out).toContain('$type: PageContent');
    expect(out).toContain('- $type: PageHeader');
    expect(out).toContain('- $type: SearchBar');
    expect(out).not.toContain('orchestrator:PageHeader');
  });

  it('does not touch a type that merely starts with the name of an orch-ui one', () => {
    const out = derivePage('$route: /\nsections:\n  - $type: JobCardGridExtra\n', OPTS);
    expect(out).toContain('$type: JobCardGridExtra');
  });

  it.each([
    ['url: GET /api/jobs', 'url: GET /api/modules/orchestrator/api/jobs'],
    ['url: POST /api/jobs/{id}/{action}', 'url: POST /api/modules/orchestrator/api/jobs/{id}/{action}'],
    ['url: DELETE /api/jobs/{id}', 'url: DELETE /api/modules/orchestrator/api/jobs/{id}'],
    ['url: GET /api/audit?limit=100', 'url: GET /api/modules/orchestrator/api/audit?limit=100'],
  ])('moves the API call "%s" under the module prefix', (input, expected) => {
    expect(derivePage(`$route: /x\n$sources:\n  s:\n    ${input}\n`, OPTS)).toContain(`    ${expected}`);
  });

  it.each([
    ['to: /', 'to: /modules/orchestrator/'],
    ['to: /jobs/{id}/logs', 'to: /modules/orchestrator/jobs/{id}/logs'],
    ['route: /jobs/{id}', 'route: /modules/orchestrator/jobs/{id}'],
    ['route: /jobs/new', 'route: /modules/orchestrator/jobs/new'],
  ])('moves the navigation "%s" under the module route prefix', (input, expected) => {
    expect(derivePage(`$route: /x\n$brains:\n  b:\n    ${input}\n`, OPTS)).toContain(`    ${expected}`);
  });

  it('keeps comments, which say why a page is built the way it is', () => {
    const out = derivePage('$route: /\n# why this exists\n$sources:\n  s:\n    url: GET /api/jobs  # polled\n', OPTS);
    expect(out).toContain('# why this exists');
    expect(out).toContain('url: GET /api/modules/orchestrator/api/jobs  # polled');
  });

  it('refuses a URL it cannot place, rather than leaving a call that would hit app-core itself', () => {
    expect(() => derivePage('$route: /\n$sources:\n  s:\n    url: GET https://example.com/x\n', OPTS)).toThrow(/url/i);
  });

  it('refuses a navigation target that is not an absolute path', () => {
    expect(() => derivePage('$route: /\n$brains:\n  b:\n    to: jobs\n', OPTS)).toThrow(/to:/);
  });
});

describe('readOrchUiTypes', () => {
  it('lists the components generated entries import from orch-ui, and only those', () => {
    const source = [
      "import { Badge } from '@wadeck-app/dsl-ui/dist/components/display/Badge.js'",
      "import { JobCardGrid } from '../../../orch-ui/src/components/JobCardGrid.js'",
      "import { RunHistory } from '../../../orch-ui/src/components/RunHistory.js'",
    ].join('\n');
    expect([...readOrchUiTypes(source)].sort()).toEqual(['JobCardGrid', 'RunHistory']);
  });

  it('throws when it finds none, since an empty list would silently prefix nothing', () => {
    expect(() => readOrchUiTypes("import { Badge } from '@wadeck-app/dsl-ui/x.js'")).toThrow(/orch-ui/);
  });
});
