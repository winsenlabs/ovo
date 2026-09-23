import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/conformance`;
const gate = (args: string[]) => runGate('check-conformance.mjs', ['--root', root, ...args]);

describe('check-conformance', () => {
  it('requires tests/conformance.test.ts calling a kit, exempting real skeletons', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${root}/packages/plugin-stt-x: has no tests/conformance.test.ts`);
    expect(run.output).not.toContain('plugin-stt-y: ');
    expect(run.output).not.toContain('plugin-stt-z:');
    expect(run.output).not.toContain('plugin-other');
  });

  it('names every skeleton exemption it takes', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.output).toContain(`skeleton exemption taken by ${root}/packages/plugin-stt-y`);
    expect(run.output).not.toContain(`skeleton exemption taken by ${root}/packages/plugin-stt-w`);
  });

  it('refuses the skeleton flag when the package already ships plugins', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      `${root}/packages/plugin-stt-w: ovo.skeleton is true but src/index.ts exports a non-empty \`plugins\`; has no tests/conformance.test.ts`,
    );
  });

  it('--only limits what it reports', () => {
    expect(
      gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/plugin-stt-z`]).status,
    ).toBe(0);
  });

  it('merges the baseline and pending entries', () => {
    const failing = ['packages/plugin-stt-x', 'packages/plugin-stt-w'];
    expect(
      gate(['--baseline-dir', baselineDir({ 'conformance.json': { packages: failing } })]).status,
    ).toBe(0);
    const dir = baselineDir({
      'pending/S2.json': {
        conformance: failing.map((pkg) => ({ package: pkg, ...PENDING })),
      },
    });
    expect(gate(['--baseline-dir', dir]).status).toBe(0);
  });
});
