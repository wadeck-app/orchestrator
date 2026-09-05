#!/usr/bin/env node
/**
 * patch-entries.mjs
 *
 * Patches src/generated/entries.tsx after vite build regenerates it.
 * Fixes two known issues in the installed @wadeck-app/dsl-renderer generator
 * until the upstream packages are updated and published:
 *
 *   1. RouterProvider has no named RouterProviderProps interface → generator
 *      produces `render: () => <RouterProvider />` (missing required children).
 *
 *   2. DataTableProps<T> is generic → generator omits the type argument,
 *      producing DataTableProps['rows'] instead of DataTableProps<Record<string, unknown>>['rows'].
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entriesPath = resolve(__dirname, '../src/generated/entries.tsx');

let src = readFileSync(entriesPath, 'utf-8');

// Fix 1: RouterProvider — render children from node['items']
src = src.replace(
  /render: \(\) => <RouterProvider \/>,/,
  `render: ({ node, registry, ctx }: RegistryRenderProps) => {
\t\tconst items = node['items'] as unknown[] | undefined
\t\treturn (
\t\t\t<RouterProvider>
\t\t\t\t{items ? renderChildren(items, registry, ctx) : null}
\t\t\t</RouterProvider>
\t\t)
\t},`
);

// Fix 2: DataTableProps<T> — add type argument to all prop-type accesses
src = src.replace(/DataTableProps\['/g, "DataTableProps<Record<string, unknown>>['");

writeFileSync(entriesPath, src, 'utf-8');
console.log('✓ entries.tsx patched');
