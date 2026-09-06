import type { Rule, Violation } from '@wadeck/violations-rules';
import fs from 'node:fs';

/**
 * Detects icon-only buttons where the icon color is `text-muted` on a `bg-muted-bg`
 * background — both classes appearing in the same className string, which produces
 * insufficient contrast (muted text on muted background).
 *
 * Fix: use `text-content` or `text-primary` so the icon is visible.
 */
export const rule: Rule = {
  id: 'tailwind/no-low-contrast-icon-btn',
  tags: 'tailwind',
  defaultScope: ['packages/orch-ui/src/**/*.tsx', 'packages/orch-app/src/**/*.tsx'],
  defaultSeverity: 'warning',

  async check(files: string[]): Promise<Violation[]> {
    const violations: Violation[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        // Detect className= strings containing both text-muted and bg-muted-bg
        if (line.includes('text-muted') && line.includes('bg-muted-bg') && line.includes('className')) {
          violations.push({
            file,
            line: i + 1,
            message: 'Low contrast: text-muted on bg-muted-bg — use text-content for icon buttons to ensure sufficient contrast',
          });
        }
      });
    }
    return violations;
  },
};

export default rule;
