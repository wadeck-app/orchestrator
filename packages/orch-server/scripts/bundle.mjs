#!/usr/bin/env node
// Bundles src/index.ts into dist/index.js, with @wadeck-app/orch-core inlined.
//
// orch-core is a private workspace package whose exports point at TypeScript sources, so a plain
// `tsc` build would leave a bare `@wadeck-app/orch-core/...` import in dist/ that nothing can
// resolve once dist/ is copied into orchestrator-cli/server/dist. Bundling is what makes that
// copy self-contained. The web framework stays external: it is a dependency of orchestrator-cli,
// which is where server/dist/index.js resolves it from at runtime.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

// Whole directory: files left by the former per-file tsc build (daemon-proxy.js, routes/*.js ...)
// would otherwise look like part of the bundle.
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(dist, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['fastify', '@fastify/static', '@fastify/cors'],
  logLevel: 'warning',
});
console.log('✓ orch-server bundled to dist/index.js');
