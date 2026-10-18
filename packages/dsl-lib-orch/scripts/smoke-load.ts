/**
 * Loads a built dsl-lib the way app-core's shell does, with Node's own import and the real shared
 * packages on the global, and prints what it exports. A quick way to see whether a bundle loads at
 * all, outside vitest:
 *
 *   npx tsx scripts/smoke-load.ts [path/to/entries.mjs]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULE_DIST } from '../src/paths.js';

globalThis.__APP_CORE_SHARED__ = {
  'react': await import('react'),
  'react/jsx-runtime': await import('react/jsx-runtime'),
  'react-dom': await import('react-dom'),
  'react-dom/client': await import('react-dom/client'),
  'react-router-dom': await import('react-router-dom'),
  '@wadeck-app/dsl-ui': await import('@wadeck-app/dsl-ui'),
  '@wadeck-app/dsl-renderer': await import('@wadeck-app/dsl-renderer'),
};

const file = path.resolve(process.argv[2] ?? path.join(MODULE_DIST, 'dsl-lib', 'entries.mjs'));
const loaded = await import(pathToFileURL(file).href) as { default: { name: string }[] };
process.stdout.write(`${loaded.default.length} entries: ${loaded.default.map(e => e.name).join(', ')}\n`);
