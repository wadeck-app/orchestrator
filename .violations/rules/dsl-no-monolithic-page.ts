import type { Rule, Violation } from '@wadeck/violations-rules';
import fs from 'node:fs';
import { load as parseYaml } from 'js-yaml';

/**
 * DSL pages must compose from small dsl-ui primitives, NOT wrap the entire page
 * in a single "page-level" composite component (e.g. JobDetailSection, JobListSection).
 *
 * Valid:   sections: [PageHeader, Section, RunHistory, TriggerButton, ...]
 * Invalid: sections: [JobDetailSection]  ← entire page in one component
 *
 * A component is "page-level" if its $type ends with "Section" AND it is not
 * a known dsl-ui layout primitive (Section itself is fine as a layout wrapper).
 *
 * @see capability-framework dsl-agent-fleet-app/src/dsl/pages/*.yaml for correct examples
 */

const DSL_UI_PRIMITIVES = new Set([
  'PageContent', 'PageHeader', 'Section', 'HorizontalStack', 'VerticalStack',
  'ActionBar', 'DataTable', 'SearchBar', 'FilterChips', 'Pagination',
  'ButtonAction', 'ButtonCancel', 'RefreshButton', 'FetchSpinner',
  'RunHistory', 'TriggerButton', 'EnableToggle', 'JobStatusBadge',
  'NextFireCountdown', 'LogViewer', 'JobForm',
]);

function isPageLevelComposite(type: string): boolean {
  // Flag anything ending in "Section" that is NOT a known layout primitive
  return type.endsWith('Section') && !DSL_UI_PRIMITIVES.has(type);
}

function collectSectionTypes(node: unknown, types: string[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeof obj['$type'] === 'string') types.push(obj['$type']);
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) val.forEach(v => collectSectionTypes(v, types));
    else if (val && typeof val === 'object') collectSectionTypes(val, types);
  }
}

export const rule: Rule = {
  id: 'dsl/no-monolithic-page-component',
  tags: 'ts',
  defaultScope: ['packages/orch-app/src/dsl/pages/**/*.yaml'],
  defaultSeverity: 'error',

  async check(files: string[]): Promise<Violation[]> {
    const violations: Violation[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      let page: Record<string, unknown>;
      try {
        page = parseYaml(content) as Record<string, unknown>;
      } catch {
        continue;
      }

      const sections = page['sections'];
      if (!Array.isArray(sections)) continue;

      if (sections.length <= 1) {
        const type = (sections[0] as Record<string, unknown>)?.['$type'] ?? '(unknown)';
        violations.push({
          file,
          line: 1,
          message: `DSL page has only 1 section (${ type }). A page must compose from multiple components — see capability-framework dsl-agent-fleet-app/src/dsl/pages/ for examples.`,
        });
      }
    }

    return violations;
  },
};

export default rule;
