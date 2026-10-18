/**
 * Generates src/generated/entries.tsx: one registry entry per dsl-ui component and per orch-ui component.
 *
 *   npm run entries --workspace=packages/orch-dsl-lib
 *
 * Same generator as any dsl app (dsl-renderer's buildEntriesFile), fed by dsl.config.yaml. The file is
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
import { load as parseYaml } from 'js-yaml';
import { buildEntriesFile } from '@wadeck-app/dsl-renderer/build/entriesGenerator';
import { LIB_ENTRIES, PACKAGE_DIR, PACKAGES_DIR } from '../src/paths.js';

const require = createRequire(import.meta.url);

interface WatchDir {
  pkg: string;
  absDir: string;
}

function componentsDir(pkg: string, dir: string): WatchDir {
  if (!fs.existsSync(dir)) {
    throw new Error(`generate-entries: ${pkg} has no components directory at ${dir}. Run "npm install" at the repository root, and check dsl.config.yaml names a workspace package.`);
  }
  return { pkg, absDir: dir };
}

/** dsl-ui first, then each package of dsl.config.yaml: the order dsl-renderer's own vite plugin uses. */
function resolveWatchDirs(): WatchDir[] {
  const configPath = path.join(PACKAGE_DIR, 'dsl.config.yaml');
  const config = parseYaml(fs.readFileSync(configPath, 'utf8')) as { packages?: Record<string, string> } | undefined;
  const packages = config?.packages;
  if (packages === undefined || Object.keys(packages).length === 0) {
    throw new Error(`generate-entries: ${configPath} declares no "packages:", so only dsl-ui would be generated and every orch-ui component would be missing.`);
  }
  const dslUi = path.join(path.dirname(require.resolve('@wadeck-app/dsl-ui/package.json')), 'src', 'components');
  return [
    componentsDir('dsl-ui', dslUi),
    ...Object.values(packages).map((pkg) => componentsDir(pkg, path.join(PACKAGES_DIR, pkg.split('/').pop()!, 'src', 'components'))),
  ];
}

/** The content of src/generated/entries.tsx, nothing written. */
export function generateEntries(): string {
  // Package imports ('@wadeck-app/dsl-ui/dist/...'), not monorepo-relative ones: dsl-ui is an installed package here.
  return buildEntriesFile(PACKAGE_DIR, resolveWatchDirs(), undefined, { usePackageImports: true });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  fs.mkdirSync(path.dirname(LIB_ENTRIES), { recursive: true });
  fs.writeFileSync(LIB_ENTRIES, generateEntries(), 'utf8');
  process.stdout.write(`generated ${path.relative(process.cwd(), LIB_ENTRIES)}\n`);
}
