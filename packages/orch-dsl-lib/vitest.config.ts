import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Same as tsconfig.json "paths": one copy of orch-ui's runtime config, the one the generated entries import.
      '@wadeck-app/orch-ui': path.resolve(__dirname, '../orch-ui/src/index.ts'),
    },
  },
  test: {
    globalSetup: ['./src/global-setup.ts'],
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
