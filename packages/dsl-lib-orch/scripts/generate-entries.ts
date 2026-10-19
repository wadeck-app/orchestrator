/**
 * Generates src/generated/entries.tsx: one registry entry per dsl-ui component and per component of this
 * package (src/components).
 *
 *   npm run entries --workspace=packages/dsl-lib-orch
 *
 * Same generator as any dsl app (dsl-renderer's buildEntriesFile). Its vite plugin and dsl.config.yaml
 * name other packages' components by package name; here the components are this package's own, so the
 * folder is given directly and the entries import them by relative path (../components/X.js). The file is
 * committed, like any generated source, and generateEntries.test.ts fails when it is stale.
 *
 * No post-generation patch: the two defects older dsl-renderer releases had (RouterProvider rendered without
 * its children, DataTableProps without its type argument) are fixed in the installed one, and
 * generateEntries.test.ts fails if either comes back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildEntriesFile } from '@wadeck-app/dsl-renderer/build/entriesGenerator';
import { COMPONENTS_DIR, LIB_ENTRIES, PACKAGE_DIR } from '../src/paths.js';

const require = createRequire(import.meta.url);

interface WatchDir {
  pkg: string;
  absDir: string;
}

function componentsDir(pkg: string, dir: string): WatchDir {
  if (!fs.existsSync(dir)) {
    throw new Error(`generate-entries: ${pkg} has no components directory at ${dir}. Run "npm install" at the repository root so dsl-ui is installed, and check src/components exists in this package.`);
  }
  return { pkg, absDir: dir };
}

/** dsl-ui first, then this package: the order dsl-renderer's own vite plugin uses. */
function resolveWatchDirs(): WatchDir[] {
  const dslUi = path.join(path.dirname(require.resolve('@wadeck-app/dsl-ui/package.json')), 'src', 'components');
  return [
    componentsDir('dsl-ui', dslUi),
    componentsDir('dsl-lib-orch', COMPONENTS_DIR),
  ];
}

/**
 * Runs the generator with fs.readdirSync answering in byte order.
 *
 * dsl-renderer finds the component files with readdirSync and never sorts, so the entries came out in the file
 * system's order: case-insensitive on Windows (RunningAlertDetail before RunTelemetry), byte order on Linux and
 * macOS (the reverse). A file generated on one machine then differed from what CI generated on another, and
 * generateEntries.test.ts failed on ubuntu and macOS only. Sorting here makes the file the same everywhere.
 */
function withByteOrderListing<T>(run: () => T): T {
  const real = fs.readdirSync;
  fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    const result = (real as (...a: unknown[]) => unknown).apply(fs, args);
    // Only plain name lists: a listing with file types (Dirent) is left as it came.
    return Array.isArray(result) && result.every((entry) => typeof entry === 'string')
      ? [...result].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : result;
  }) as typeof fs.readdirSync;
  try {
    return run();
  } finally {
    fs.readdirSync = real;
  }
}

/** The content of src/generated/entries.tsx, nothing written. */
export function generateEntries(): string {
  // Package imports ('@wadeck-app/dsl-ui/dist/...'), not monorepo-relative ones: dsl-ui is an installed package here.
  return withByteOrderListing(() => buildEntriesFile(PACKAGE_DIR, resolveWatchDirs(), undefined, { usePackageImports: true }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  fs.mkdirSync(path.dirname(LIB_ENTRIES), { recursive: true });
  fs.writeFileSync(LIB_ENTRIES, generateEntries(), 'utf8');
  process.stdout.write(`generated ${path.relative(process.cwd(), LIB_ENTRIES)}\n`);
}
