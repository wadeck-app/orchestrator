import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { MODULE_DIR, PACKAGE_DIR } from '../src/paths.js';

/*
 * The dependency runs one way: orch-app (the SPA the tray-launched dashboard server serves) and the
 * app-core module both depend on this package; neither depends on the other, and this package depends on
 * neither. A reference to the SPA from the module (any text mention), or an import / path / package.json
 * dependency on it from this package, is how the two get coupled again. Prose in this package that names
 * orch-app as one of the hosts it serves is fine: only a way to reach it is forbidden.
 */
const SPA = ['orch', 'app'].join('-');
const SPA_COUPLING = new RegExp(`@wadeck-app/${SPA}|\\.\\./${SPA}|packages/${SPA}|node_modules/${SPA}`);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-module', '.git']);
const THIS_FILE = path.join(PACKAGE_DIR, 'test', 'standalone.test.ts');
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

describe.each([
  ['app-module-orchestrator', MODULE_DIR, (line: string) => line.includes(SPA)],
  ['dsl-lib-orch', PACKAGE_DIR, (line: string) => SPA_COUPLING.test(line)],
])('%s', (_name, dir, offends) => {
  const files = listFiles(dir);

  it('is scanned: an empty scan would pass for the wrong reason', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('is not coupled to the SPA package', () => {
    const offenders = files.flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line, i) => (offends(line) ? `${path.relative(dir, file)}:${i + 1}: ${line.trim()}` : ''))
      .filter(Boolean));
    expect(offenders, 'remove these references: shared code belongs in dsl-lib-orch').toEqual([]);
  });
});
