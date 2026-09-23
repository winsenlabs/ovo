import { createRequire } from 'node:module';
import { configDefaults, defineConfig } from 'vitest/config';

const NODE_TESTS = [
  'packages/**/*.test.ts',
  'packages/**/*.spec.ts',
  'apps/**/*.test.ts',
  'experiments/**/*.test.ts',
  'infra/**/*.test.ts',
  'scripts/**/*.test.ts',
];
// Gate fixtures hold deliberately violating files (some named *.test.ts); they never run.
const EXCLUDE = [...configDefaults.exclude, 'scripts/tests/fixtures/**'];
const shared = {
  testTimeout: 15000,
  setupFiles: ['scripts/vitest-violation-sink.ts'],
};

function resolves(name: string): boolean {
  try {
    createRequire(new URL('./apps/console/package.json', import.meta.url)).resolve(name);
    return true;
  } catch {
    return false;
  }
}

export default defineConfig({
  test: {
    maxWorkers: 4,
    globalSetup: ['scripts/vitest-global-setup.ts'],
    ...(resolves('jsdom')
      ? {
          projects: [
            { test: { ...shared, name: 'node', include: NODE_TESTS, exclude: EXCLUDE } },
            {
              test: {
                ...shared,
                name: 'console-dom',
                include: ['apps/console/**/*.test.tsx'],
                exclude: EXCLUDE,
                environment: 'jsdom',
              },
            },
          ],
        }
      : { ...shared, include: NODE_TESTS, exclude: [...EXCLUDE, '**/*.test.tsx'] }),
  },
});
