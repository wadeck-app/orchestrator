import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/global-setup.ts'],
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
