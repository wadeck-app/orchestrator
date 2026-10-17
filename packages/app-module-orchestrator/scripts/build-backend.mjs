/**
 * Bundles the module's backend into one self-contained ES module.
 *
 * app-core `import()`s backendEntryPath from wherever the module sits on disk, so the file cannot
 * rely on node_modules next to it: every dependency, orch-server's route files included, is inlined.
 *
 *   npm run build --workspace=packages/app-module-orchestrator
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildBackend({ outfile = path.join(packageDir, 'api-backend', 'dist', 'backend.mjs') } = {}) {
  await build({
    entryPoints: [path.join(packageDir, 'src', 'backend.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile,
    sourcemap: true,
    logLevel: 'warning',
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = await buildBackend();
  process.stdout.write(`built ${path.relative(process.cwd(), outfile)}\n`);
}
