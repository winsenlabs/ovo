import { configDefaults, defineConfig } from 'vitest/config';

// The load test (tests/load/README.md): N concurrent fake-carrier calls through the stack. Needs
// OVO_TEST_POSTGRES_URL; OVO_LOAD_CALLS (default 2) and OVO_LOAD_HOLD_MS size the run. It stays out
// of `pnpm test` and `pnpm test:live-path`.
export default defineConfig({
  root: new URL('../..', import.meta.url).pathname,
  test: {
    include: ['tests/load/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    globalSetup: ['scripts/vitest-global-setup.ts'],
    setupFiles: ['scripts/vitest-violation-sink.ts'],
  },
});
