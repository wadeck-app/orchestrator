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
        const abs = path.resolve(path.dirname(importer), id);
        const tsx = abs.replace(/\.js$/, '.tsx');
        const ts = abs.replace(/\.js$/, '.ts');
        if (fs.existsSync(tsx)) return tsx;
        if (fs.existsSync(ts)) return ts;
      },
    },
  ],
  resolve: {
    alias: [
      { find: '@wadeck-app/dsl-renderer', replacement: path.join(nodeModules, '@wadeck-app/dsl-renderer/src/index.ts') },
      { find: '@wadeck-app/dsl-ui',       replacement: path.join(nodeModules, '@wadeck-app/dsl-ui/src/index.ts') },
      { find: '@wadeck-app/orch-ui',       replacement: path.join(orchUiSrc, 'index.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
