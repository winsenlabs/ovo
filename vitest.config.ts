import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.spec.ts',
      'apps/**/*.test.ts',
      'experiments/**/*.test.ts',
    ],
    testTimeout: 15000,
    maxWorkers: 4,
  },
});
