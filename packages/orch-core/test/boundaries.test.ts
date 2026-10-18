import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * orch-core is the logic that two controllers share: orch-server (a Fastify process launched by the
 * tray) and app-module-orchestrator (an app-core module). Each controller brings its own host, so the
 * core must not reach for either one: a `fastify` import would make the module carry a second copy of
 * the server framework, and an app-core-sdk import would make orch-server load app-core.
 */
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = [/^fastify$/, /^@fastify\//, /^@wadeck-app\/app-core-sdk(\/|$)/, /^@wadeck-app\/orch-server(\/|$)/, /^@wadeck-app\/app-module-orchestrator(\/|$)/];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function specifiersOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(m => m[1]!);
}

describe('orch-core stays host-agnostic', () => {
  const files = sourceFiles(path.join(PKG_DIR, 'src'));

  it('has source files to check (a rename must not turn this guard into a no-op)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no non-test source imports a web framework, app-core or a controller package', () => {
    const offenders = files.flatMap(file =>
      specifiersOf(file)
        .filter(spec => FORBIDDEN.some(re => re.test(spec)))
        .map(spec => `${path.relative(PKG_DIR, file)} imports "${spec}"`));
    expect(offenders).toEqual([]);
  });

  it('declares none of them as a runtime dependency (fastify is a devDependency, for the tests only)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
    };
    const runtime = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
    expect(runtime.filter(name => FORBIDDEN.some(re => re.test(name)))).toEqual([]);
  });
});
