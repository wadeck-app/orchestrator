/**
 * Bundles orchestrator into single CommonJS files.
 * ESM dynamic imports are resolved at bundle time by esbuild.
 *
 * Outputs:
 *   dist-bundle/orchestrator.cjs       (daemon entry point)
 *   dist-bundle/orchestrator-cli.cjs   (CLI entry point)
 *   dist-bundle/orchestrator-updater.cjs (updater)
 *
 * Usage:  npx tsx scripts/bundle.ts
 * Env:    BUNDLE_VERSION  override version baked into bundles
 */
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Shared esbuild options
const banner = { js: `const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;` };
const define = { 'import.meta.url': '__importMetaUrl' };

// Resolve version: prefer CI override, fall back to package.json
const pkgVersion = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string }).version;
const version = process.env['BUNDLE_VERSION'] ?? pkgVersion;

(async () => {
await Promise.all([
  // Daemon entry point
  build({
    entryPoints: [path.join(root, 'dist/index.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(root, 'dist-bundle/orchestrator.cjs'),
    external: [],
    supported: { 'top-level-await': false },
    define: {
      ...define,
      __ORCH_VERSION__: JSON.stringify(version),
    },
    banner,
    logLevel: 'warning',
  }),

  // CLI entry point
  build({
    entryPoints: [path.join(root, 'dist/cli.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(root, 'dist-bundle/orchestrator-cli.cjs'),
    external: [],
    supported: { 'top-level-await': false },
    define: {
      ...define,
      __ORCH_VERSION__: JSON.stringify(version),
    },
    banner,
    logLevel: 'warning',
  }),

  // Updater
  build({
    entryPoints: [path.join(root, 'dist/updater/entry.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(root, 'dist-bundle/orchestrator-updater.cjs'),
    external: [],
    supported: { 'top-level-await': false },
    define: {
      ...define,
      __ORCH_VERSION__: JSON.stringify(version),
    },
    banner,
    logLevel: 'warning',
  }),
]);

console.log('Bundle written to dist-bundle/orchestrator.cjs (daemon)');
console.log('Bundle written to dist-bundle/orchestrator-cli.cjs (CLI)');
console.log(`Bundle written to dist-bundle/orchestrator-updater.cjs (version: ${version})`);

// Size guard: updater must stay under 500 KB to remain a lightweight background process
const MAX_UPDATER_SIZE = 500 * 1024;
const updaterPath = path.join(root, 'dist-bundle/orchestrator-updater.cjs');
const updaterSize = statSync(updaterPath).size;
if (updaterSize > MAX_UPDATER_SIZE) {
  console.error(
    `ERROR: orchestrator-updater.cjs is ${(updaterSize / 1024).toFixed(1)} KB, exceeds the 500 KB limit.`,
  );
  process.exit(1);
}
console.log(`Size check passed: orchestrator-updater.cjs is ${(updaterSize / 1024).toFixed(1)} KB`);
})();
