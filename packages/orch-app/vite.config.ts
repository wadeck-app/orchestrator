import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const nodeModules = path.resolve(__dirname, '../../node_modules');

export default defineConfig(async () => {
  const { entriesGenerator } = await import('@wadeck-app/dsl-renderer/build/entriesGenerator');
  return {
    plugins: [react(), entriesGenerator()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Fixed filenames so the running HTTP server never gets stale hash mismatches
      rollupOptions: {
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
