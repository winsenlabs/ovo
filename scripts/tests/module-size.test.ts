import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/module-size`;
const big = `${root}/packages/demo/src/big.ts`;
const gate = (args: string[]) => runGate('check-module-size.mjs', ['--root', root, ...args]);

describe('check-module-size', () => {
  it('fails on a new 301-line source file', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${big}: 301 canonical nonblank lines`);
    expect(run.output).toContain('source limit 300');
  });

  it('--only limits what it reports', () => {
    const run = gate([
      '--baseline-dir',
      baselineDir(),
      '--only',
      `${root}/packages/demo/src/ok.ts`,
      `${root}/packages/demo/tests`,
    ]);
    expect(run.status).toBe(0);
    expect(run.output).not.toContain('big.ts');
  });

  it('accepts a top-level baseline entry but not growth beyond it', () => {
    expect(
      gate(['--baseline-dir', baselineDir({ 'module-size.json': { files: { [big]: 301 } } })])
        .status,
    ).toBe(0);
    const grown = gate([
      '--baseline-dir',
      baselineDir({ 'module-size.json': { files: { [big]: 305, [`${root}/gone.ts`]: 350 } } }),
    ]);
    expect(grown.status).toBe(0);
    expect(grown.output).toContain('can shrink to 301');
    expect(grown.output).toContain('stale baseline entry');
    const smaller = gate([
      '--baseline-dir',
      baselineDir({ 'module-size.json': { files: { [big]: 300 } } }),
    ]);
    expect(smaller.status).toBe(1);
  });

  it('merges pending baselines and rejects pending entries without reason/removeBy', () => {
    const ok = baselineDir({
      'pending/F2.json': { moduleSize: [{ file: big, lines: 301, ...PENDING }] },
    });
    expect(gate(['--baseline-dir', ok]).status).toBe(0);
    const bad = baselineDir({ 'pending/F2.json': { moduleSize: [{ file: big, lines: 301 }] } });
    const run = gate(['--baseline-dir', bad]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('removeBy "I1"');
  });

  it('keeps 400 lines as a hard cap that no baseline raises', () => {
    const huge = `${FIXTURES}/module-size-hard/packages/huge/src/huge.ts`;
    const dir = baselineDir({
      'pending/F2.json': { moduleSize: [{ file: huge, lines: 401, ...PENDING }] },
    });
    const run = runGate('check-module-size.mjs', [
      '--root',
      `${FIXTURES}/module-size-hard`,
      '--baseline-dir',
      dir,
    ]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('hard limit 400');
  });
});
