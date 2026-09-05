import type { Rule, Violation } from '@wadeck-app/violations-rules';
import fs from 'node:fs';

// Symbols that must be replaced with Lucide icons in JSX/TSX files.
// Matches arrows, checkmarks, bullets, dashes, and any char in the
// Miscellaneous Symbols / Dingbats / Emoji blocks (U+2000-U+9FFF, U+1F000+).
const SYMBOL_RE = /[↻↑↓←→✓✗✔✘★☆•—–▶▷►◀◁◄×÷…]|[ -鿿]|[\uD800-\uDBFF][\uDC00-\uDFFF]/;

// Only flag occurrences that are NOT inside a //- or /*-style comment and
// NOT inside a string literal — we scan the raw source and skip line comments.
function hasNonCommentSymbol(source: string): Array<{ line: number; col: number; ch: string }> {
  const hits: Array<{ line: number; col: number; ch: string }> = [];
  const lines = source.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!;
    // Strip line comment suffix for checking
    const commentIdx = raw.indexOf('//');
    const code = commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
    for (let ci = 0; ci < code.length; ci++) {
      const ch = code[ci]!;
      if (SYMBOL_RE.test(ch)) {
        hits.push({ line: li + 1, col: ci + 1, ch });
      }
    }
  }
  return hits;
}

export const rule: Rule = {
  id: 'local/no-unicode-symbol',
  tags: 'react',
  defaultScope: ['packages/orch-ui/src/**/*.tsx', 'packages/orch-app/src/**/*.tsx'],
  defaultSeverity: 'error',
  async check(files: string[]): Promise<Violation[]> {
    const violations: Violation[] = [];
    for (const file of files) {
      let source: string;
      try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const hit of hasNonCommentSymbol(source)) {
        violations.push({
          file,
          line: hit.line,
          message: `Unicode symbol '${hit.ch}' found — use a Lucide icon component instead`,
        });
      }
    }
    return violations;
  },
};

export default rule;
