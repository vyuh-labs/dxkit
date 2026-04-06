import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'templates/**', 'src-templates/**', 'test/fixtures/**'],
    testTimeout: 30000,
  },
});
