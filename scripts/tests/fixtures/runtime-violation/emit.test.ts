// Run only by scripts/tests/tools.test.ts, through vitest.config.ts next to this file: it reports
// one runtime violation (§3.7) so that the real globalSetup teardown has something to judge.
// The repository's own vitest run excludes scripts/tests/fixtures/**, so this never runs there.
import { expect, it } from 'vitest';
import { createViolationLog } from '../../../../packages/runtime/src/enforcement.ts';

it('reports a violation through the sink that vitest-violation-sink.ts installed', () => {
  const log = createViolationLog();
  log.report({
    pluginId: 'fixture-probe',
    pluginVersion: '0.0.0',
    kind: 'read-undeclared',
    key: 'ovo.fixture-probe',
    mode: 'warn',
  });
  expect(log.violations).toHaveLength(1);
});
