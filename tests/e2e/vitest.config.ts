import { configDefaults, defineConfig } from 'vitest/config';

// `pnpm test:live-path`: the in-process live call path and the Compose environment contract. It
// needs OVO_TEST_POSTGRES_URL and runs alone, so it stays out of the root `pnpm test` include.
export default defineConfig({
  root: new URL('../..', import.meta.url).pathname,
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: ['scripts/vitest-global-setup.ts'],
    setupFiles: ['scripts/vitest-violation-sink.ts'],
  },
});
