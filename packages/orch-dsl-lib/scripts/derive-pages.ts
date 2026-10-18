/**
 * Regenerates src/dsl-views/ from orch-app's pages. Run after changing a page there:
 *
 *   npm run derive --workspace=packages/app-module-orchestrator (or --workspace=packages/orch-dsl-lib)
 *
 * dslFrontend.test.ts fails until this has been run, so a stale copy cannot be committed unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { MODULE_DIR } from '../src/paths.js';
import { deriveAll } from '../src/derive/deriveAll.js';

const packageDir = MODULE_DIR;
const outDir = path.join(packageDir, 'src', 'dsl-views');

fs.mkdirSync(outDir, { recursive: true });
for (const [name, content] of deriveAll(packageDir)) {
  fs.writeFileSync(path.join(outDir, name), content);
  process.stdout.write(`derived src/dsl-views/${name}\n`);
}
