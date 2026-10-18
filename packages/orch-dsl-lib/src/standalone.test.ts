import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { MODULE_DIR, PACKAGE_DIR } from './paths.js';

/*
 * The two UIs are independent: the app-core module and its library (this package) share what they need
 * through orch-ui, never through the SPA the tray-launched dashboard server serves. The chain is
 * module -> orch-dsl-lib -> orch-ui. A reference to the SPA (an import, a tsconfig path, a package.json
 * dependency, a script, a comment that says "derived from") is how the two get coupled again, so any
 * text mention fails this test.
 */
const FORBIDDEN = ['orch', 'app'].join('-');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-module', '.git']);
const THIS_FILE = path.join(PACKAGE_DIR, 'src', 'standalone.test.ts');
const TEXT_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|css|md|html|sh)$/;

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : listFiles(full);
    }
    return TEXT_FILE.test(entry.name) && full !== THIS_FILE ? [full] : [];
  });
}

describe.each([['app-module-orchestrator', MODULE_DIR], ['orch-dsl-lib', PACKAGE_DIR]])('%s', (_name, dir) => {
  const files = listFiles(dir);

  it('is scanned: an empty scan would pass for the wrong reason', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never mentions the SPA package', () => {
    const offenders = files.flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line, i) => (line.includes(FORBIDDEN) ? `${path.relative(dir, file)}:${i + 1}: ${line.trim()}` : ''))
      .filter(Boolean));
    expect(offenders, 'remove these references: shared code belongs in orch-dsl-lib or orch-ui').toEqual([]);
  });
});
