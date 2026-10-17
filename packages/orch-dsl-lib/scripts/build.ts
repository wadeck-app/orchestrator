/**
 * Builds the module's dsl-lib: the orch-ui components app-core loads at runtime, and their stylesheet.
 *
 *   npm run build --workspace=packages/orch-dsl-lib
 *
 * Output goes to app-module-orchestrator/dsl-lib/ (entries.mjs, style.css). The React source stays
 * here, outside the app-module folder: the violations rules forbid React inside `app-module-*`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import autoprefixer from 'autoprefixer';
import { build, type Plugin } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import baseTailwind from '@wadeck-app/orch-app/tailwind.config';
// @ts-expect-error - plain JS preset shipped by dsl-ui, no type declarations
import { dslUiContent } from '@wadeck-app/dsl-ui/tailwind-preset';
import { listLibTypes } from '../src/libTypes.js';
import { API_BASE, ROUTE_BASE } from '../src/moduleConfig.js';
import {
  DEFAULT_OUT_DIR, MODULE_DIR as moduleDir, ORCH_APP_CSS, ORCH_APP_ENTRIES, ORCH_UI_SRC as orchUiSrc, PACKAGE_DIR as packageDir,
} from '../src/paths.js';

/** What the app-core shell provides on globalThis.__APP_CORE_SHARED__ (module-authoring.md, "Shipping components"). */
const SHARED = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'react-router-dom',
  '@wadeck-app/dsl-ui', '@wadeck-app/dsl-renderer',
];

/**
 * Reads the shell's copy of a package instead of bundling one. Two copies of React, or two dsl-ui
 * contexts, break hooks, toasts and routing without a single build error, so the bundle must not
 * contain either.
 *
 * Deep imports into dsl-ui (`@wadeck-app/dsl-ui/dist/...`, which the generated entries use) land on
 * the shell's dsl-ui root: bundled, they would be a second copy with its own toast and router contexts.
 */
const appCoreShared: Plugin = {
  name: 'app-core-shared',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (SHARED.includes(args.path)) {
        return { path: args.path, namespace: 'app-core-shared' };
      }
      if (args.path.startsWith('@wadeck-app/dsl-ui/dist/')) {
        return { path: '@wadeck-app/dsl-ui', namespace: 'app-core-shared' };
      }
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'app-core-shared' }, (args) => ({
      loader: 'js',
      contents: [
        'const shared = globalThis.__APP_CORE_SHARED__;',
        `if (!shared || shared[${JSON.stringify(args.path)}] === undefined) {`,
        `  throw new Error('dsl-lib: the host did not provide ${args.path} on globalThis.__APP_CORE_SHARED__. It must be set before this module is imported; is this running inside app-core?');`,
        '}',
        `module.exports = shared[${JSON.stringify(args.path)}];`,
      ].join('\n'),
    }));
  },
};

/**
 * The bundle's entry, generated so the list of components is the one libTypes.ts computes and not a
 * second copy: a component added to orch-ui reaches the library, and the pages that name it, together.
 */
function entrySource(names: readonly string[]): string {
  const entries = names.map(name => `${name}Entry`).join(', ');
  return [
    "import { createRegistry } from '@wadeck-app/dsl-renderer';",
    "import { applyRegistryOverrides, configureOrchUi } from '@wadeck-app/orch-ui';",
    `import { ${entries} } from '@wadeck-app/orch-app/generated/entries';`,
    // Components and this call must share one config module: everything comes from orch-ui's sources.
    `configureOrchUi({ apiBase: ${JSON.stringify(API_BASE)}, routeBase: ${JSON.stringify(ROUTE_BASE)} });`,
    `const registry = createRegistry([${entries}]);`,
    // The events orch-app wires to its pages (kill, delete, filters...) are published by these wrappers.
    'applyRegistryOverrides(registry);',
    'export default Object.values(registry);',
  ].join('\n');
}

const VIRTUAL_ENTRY = 'orch-dsl-lib:entry';

function virtualEntry(source: string): Plugin {
  return {
    name: 'virtual-entry',
    setup(b) {
      b.onResolve({ filter: /^orch-dsl-lib:entry$/ }, () => ({ path: VIRTUAL_ENTRY, namespace: 'virtual-entry' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual-entry' }, () => ({ contents: source, loader: 'js', resolveDir: packageDir }));
    },
  };
}

async function buildJs(outfile: string): Promise<void> {
  const names = listLibTypes(fs.readFileSync(ORCH_APP_ENTRIES, 'utf8'));
  await build({
    entryPoints: [VIRTUAL_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    outfile,
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: {
      '@wadeck-app/orch-ui': path.join(orchUiSrc, 'index.ts'),
      '@wadeck-app/orch-app/generated/entries': ORCH_APP_ENTRIES,
    },
    plugins: [virtualEntry(entrySource(names)), appCoreShared],
    logLevel: 'warning',
  });
}

const toGlob = (p: string): string => p.replace(/\\/g, '/');

/**
 * The stylesheet of the library: orchestrator's own colour tokens and the utilities its components
 * (and the module's YAML) use. The shell scans only its own sources and dsl-ui, so none of these
 * classes would exist there.
 *
 * Derived from orch-app's CSS rather than copied: no preflight (the shell has it), and the dark
 * tokens apply under the shell's `.dark` class as well as orch-app's `data-theme="dark"`.
 */
async function buildCss(outfile: string): Promise<void> {
  const source = fs.readFileSync(ORCH_APP_CSS, 'utf8')
    .replace('@tailwind base;', '')
    .replace(/\[data-theme="dark"\]/g, '.dark, [data-theme="dark"]');

  const config = {
    ...baseTailwind,
    content: [
      toGlob(path.join(orchUiSrc, '**', '*.{ts,tsx}')),
      `!${toGlob(path.join(orchUiSrc, '**', '*.{test,stories}.{ts,tsx}'))}`,
      toGlob(path.join(moduleDir, 'dsl-frontend', '*.yaml')),
      // dsl-ui too, exactly as the shell does. The shell loads this sheet after its own, so a utility
      // both define and that this sheet repeats without its longhand siblings (px-2 here, pl-7 in the
      // shell's SearchBar) overrides the shell's. Carrying dsl-ui's utilities in Tailwind's order makes
      // the two sheets agree. Measured by app-core-owner: this is the fix, injection order is not.
      ...(dslUiContent as string[]),
    ],
  };
  const result = await postcss([tailwindcss(config), autoprefixer]).process(source, { from: ORCH_APP_CSS, to: outfile });
  fs.writeFileSync(outfile, result.css);
}

export async function buildDslLib({ outDir = DEFAULT_OUT_DIR }: { outDir?: string } = {}): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  await Promise.all([
    buildJs(path.join(outDir, 'entries.mjs')),
    buildCss(path.join(outDir, 'style.css')),
  ]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await buildDslLib();
  process.stdout.write(`built ${path.relative(process.cwd(), DEFAULT_OUT_DIR)}/entries.mjs and style.css\n`);
}
