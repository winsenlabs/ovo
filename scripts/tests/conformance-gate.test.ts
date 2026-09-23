import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/conformance`;
const gate = (args: string[]) => runGate('check-conformance.mjs', ['--root', root, ...args]);

describe('check-conformance', () => {
  it('requires tests/conformance.test.ts calling a kit, exempting skeletons', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${root}/packages/plugin-stt-x: has no tests/conformance.test.ts`);
    expect(run.output).not.toContain('plugin-stt-y');
    expect(run.output).not.toContain('plugin-stt-z:');
    expect(run.output).not.toContain('plugin-other');
  });

  it('--only limits what it reports', () => {
    expect(
      gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/plugin-stt-z`]).status,
    ).toBe(0);
  });

  it('merges the baseline and pending entries', () => {
    expect(
      gate([
        '--baseline-dir',
        baselineDir({ 'conformance.json': { packages: ['packages/plugin-stt-x'] } }),
      ]).status,
    ).toBe(0);
    const dir = baselineDir({
      'pending/S2.json': { conformance: [{ package: 'packages/plugin-stt-x', ...PENDING }] },
    });
    expect(gate(['--baseline-dir', dir]).status).toBe(0);
  });
});
