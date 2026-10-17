/**
 * Regenerates dsl-frontend/ from orch-app's pages. Run after changing a page there:
 *
 *   npm run derive --workspace=packages/app-module-orchestrator
 *
 * dslFrontend.test.ts fails until this has been run, so a stale copy cannot be committed unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAll } from '../src/deriveAll.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(packageDir, 'dsl-frontend');

fs.mkdirSync(outDir, { recursive: true });
for (const [name, content] of deriveAll(packageDir)) {
  fs.writeFileSync(path.join(outDir, name), content);
  process.stdout.write(`derived dsl-frontend/${name}\n`);
}
