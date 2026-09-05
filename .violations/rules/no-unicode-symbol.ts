import type { Rule, Violation } from '@wadeck-app/violations-rules';
import fs from 'node:fs';

// Matches visual symbols that should be replaced with Lucide icons:
//   - Extended_Pictographic  — all emoji and pictographic characters
//   - Symbol                 — math (Sm), currency (Sc), modifier (Sk), other (So) symbols
//   - Em/en-dash, ellipsis, bullet and similar decorative punctuation (U+2010-U+2015, U+2026, U+2022, U+00B7)
//
// ASCII (U+0000-U+007F) is excluded: <, >, =, $, ` etc. are valid code operators.
// Latin-1 Supplement letters (U+0080-U+00FF) like é, è, à are NOT in Symbol category
// and are never matched.
const SYMBOL_RE = /\p{Extended_Pictographic}|\p{Symbol}|[‐-―]|[…•·]/u;

export const rule: Rule = {
  id: 'local/no-unicode-symbol',
  tags: 'react',
  // Global: all TSX/TS source files across every package
  defaultScope: ['packages/**/*.tsx', 'packages/**/*.ts'],
  defaultSeverity: 'error',
  async check(files: string[]): Promise<Violation[]> {
    const violations: Violation[] = [];
    for (const file of files) {
      let source: string;
      try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = source.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        for (let ci = 0; ci < line.length; ) {
          const cp = line.codePointAt(ci) ?? 0;
          // Step over surrogate pairs as one unit
          const charLen = cp > 0xFFFF ? 2 : 1;
          if (cp > 0x007F) {
            const ch = line.slice(ci, ci + charLen);
            if (SYMBOL_RE.test(ch)) {
              violations.push({
                file,
                line: li + 1,
                message: `Unicode symbol '${ch}' (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) found — use a Lucide icon component instead`,
              });
            }
          }
          ci += charLen;
        }
      }
    }
    return violations;
  },
};

export default rule;
