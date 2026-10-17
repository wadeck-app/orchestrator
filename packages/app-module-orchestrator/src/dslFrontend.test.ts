import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveAll, DERIVED_PAGES, HANDWRITTEN_VIEWS } from './deriveAll.js';

/*
 * dsl-frontend/ is committed, like orch-app's generated entries, so a reviewer sees the views the
 * module really serves. These tests are what stops it from drifting away from orch-app's pages:
 * when a page changes there, this fails until `npm run derive` is run here.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = path.join(packageDir, 'dsl-frontend');

describe('dsl-frontend', () => {
  const derived = deriveAll(packageDir);

  it.each(DERIVED_PAGES.map(([, target]) => target))('%s matches what is derived from orch-app (run "npm run derive" if not)', (target) => {
    const file = path.join(frontendDir, target);
    expect(fs.existsSync(file), `${file} is missing: run "npm run derive" in packages/app-module-orchestrator`).toBe(true);
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(derived.get(target));
  });

  it('holds no view that is neither derived nor declared as handwritten', () => {
    const known = new Set<string>([...DERIVED_PAGES.map(([, target]) => target), ...HANDWRITTEN_VIEWS]);
    const stray = fs.readdirSync(frontendDir).filter(name => name.endsWith('.yaml') && !known.has(name));
    expect(stray, 'a view nobody regenerates or owns would silently rot').toEqual([]);
  });

  it.each([...HANDWRITTEN_VIEWS])('%s, handwritten, exists', (name) => {
    expect(fs.existsSync(path.join(frontendDir, name))).toBe(true);
  });

  it('serves every derived page from the module, never from the root API', () => {
    for (const [name, content] of derived) {
      expect(content, name).not.toMatch(/url:\s*(GET|POST|PUT|DELETE)\s+\/api\/(?!modules\/orchestrator\/)/);
      expect(content, name).not.toMatch(/^\$route:/m);
    }
  });
});
