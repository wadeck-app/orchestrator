import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeModules = path.resolve(__dirname, '../../node_modules');
const orchUiSrc = path.resolve(__dirname, '../orch-ui/src');

export default defineConfig({
  plugins: [
    react(),
    {
      // Resolve .js extension imports to .tsx/.ts source files (required for
      // workspace packages that use NodeNext module resolution with .js extensions)
      name: 'resolve-js-to-ts',
      enforce: 'pre',
      resolveId(id, importer) {
        if (!importer || !id.endsWith('.js')) return;
        // Handle relative imports
        if (id.startsWith('.')) {
          const abs = path.resolve(path.dirname(importer), id);
          const tsx = abs.replace(/\.js$/, '.tsx');
          const ts  = abs.replace(/\.js$/, '.ts');
          if (fs.existsSync(tsx)) return tsx;
          if (fs.existsSync(ts))  return ts;
        }
        // Handle @wadeck-app/* subpath imports (e.g. @wadeck-app/dsl-ui/src/components/Foo.js)
        if (id.startsWith('@wadeck-app/')) {
          const abs = path.join(nodeModules, id);
          const tsx = abs.replace(/\.js$/, '.tsx');
          const ts  = abs.replace(/\.js$/, '.ts');
          if (fs.existsSync(tsx)) return tsx;
          if (fs.existsSync(ts))  return ts;
        }
      },
    },
  ],
  resolve: {
    alias: [
      // Exact-match aliases for package roots (regex prevents prefix-matching subpath imports)
      { find: /^@wadeck-app\/dsl-renderer$/, replacement: path.join(nodeModules, '@wadeck-app/dsl-renderer/dist/index.js') },
      { find: /^@wadeck-app\/dsl-ui$/,       replacement: path.join(nodeModules, '@wadeck-app/dsl-ui/dist/index.js') },
      { find: /^@wadeck-app\/orch-ui$/,       replacement: path.join(orchUiSrc, 'index.ts') },
      // Subpath imports (@wadeck-app/dsl-ui/src/...) fall through to the resolveId plugin
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    deps: {
      // Force Vite to process these packages so aliases and the resolve-js-to-ts
      // plugin apply to their subpath imports (.js -> .tsx resolution).
      inline: ['@wadeck-app/dsl-ui', '@wadeck-app/dsl-renderer', '@wadeck-app/orch-ui'],
    },
  },
});
