// A one-test vitest run that uses the REAL scripts/vitest-global-setup.ts and
// scripts/vitest-violation-sink.ts, so scripts/tests/tools.test.ts can prove that the teardown
// fails a run whose violations are not baselined. Rooted at the repository so both files resolve.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    include: ['scripts/tests/fixtures/runtime-violation/emit.test.ts'],
    globalSetup: ['scripts/vitest-global-setup.ts'],
    setupFiles: ['scripts/vitest-violation-sink.ts'],
  },
});
