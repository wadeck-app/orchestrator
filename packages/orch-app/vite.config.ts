import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const nodeModules = path.resolve(__dirname, '../../node_modules');

export default defineConfig(async () => {
  const { entriesGenerator } = await import('@wadeck-app/dsl-renderer/build/entriesGenerator');
  return {
    plugins: [react(), entriesGenerator()],
    // @dsl-ui/* is an internal path alias used by dsl-ui's own dist files.
    // Without this alias, Vite cannot resolve those imports in the consumer.
    resolve: {
      alias: {
        '@dsl-ui': path.resolve(nodeModules, '@wadeck-app/dsl-ui/dist'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Fixed filenames so the running HTTP server never gets stale hash mismatches
      rollupOptions: {
        // entriesGenerator() emits @wadeck-app/dsl-ui/src/* sub-path imports;
        // the exact-string form misses those, so use a predicate instead.
        external: (id: string) => id === '@wadeck-app/dsl-ui' || id.startsWith('@wadeck-app/dsl-ui/'),
        output: {
          entryFileNames: 'assets/index.js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    base: '/',
    optimizeDeps: {
      exclude: ['@wadeck-app/dsl-renderer', '@wadeck-app/dsl-ui'],
    },
  };
});
