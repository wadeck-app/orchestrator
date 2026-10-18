import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The module and orch-server are two controllers over the logic in @wadeck-app/orch-core. If the module
 * imported orch-server it would pull in the dashboard's process (Fastify bootstrap, static files, port
 * file, idle exit), none of which an app-core module has any use for.
 */
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTROLLER = /(^|\/)orch-server(\/|$)/;
const SELF = fileURLToPath(import.meta.url);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return files(full);
    }
    return /\.(ts|tsx)$/.test(entry.name) && full !== SELF ? [full] : [];
  });
}

describe('app-module-orchestrator does not depend on orch-server', () => {
  it('no source file imports it', () => {
    const offenders = files(path.join(PKG_DIR, 'src')).flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)]
        .map(m => m[1]!)
        .filter(spec => CONTROLLER.test(spec))
        .map(spec => `${path.relative(PKG_DIR, file)} imports "${spec}"`);
    });
    expect(offenders).toEqual([]);
  });

  it('package.json does not declare it in any dependency section', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const offenders = sections.flatMap(section =>
      Object.keys(pkg[section] ?? {}).filter(name => CONTROLLER.test(name)).map(name => `${section}.${name}`));
    expect(offenders).toEqual([]);
  });

  it('uses orch-core, so the guard above is not satisfied by having no backend at all', () => {
    const index = fs.readFileSync(path.join(PKG_DIR, 'src/backend/index.ts'), 'utf8');
    expect(index).toContain('@wadeck-app/orch-core/');
  });
});
