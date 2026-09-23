import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/duplication`;
const x = `${root}/packages/a/src/x.ts`;
const y = `${root}/packages/b/src/y.ts`;
const gate = (args: string[]) => runGate('check-duplication.mjs', ['--root', root, ...args]);

describe('check-duplication', () => {
  it('fails on a cross-file repeat despite different comments and strings', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${x} and ${y}`);
    expect(run.output).toMatch(/share \d+ duplicated 60-token windows/);
  });

  it('--only reports only windows with an occurrence under the prefixes', () => {
    expect(gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/c`]).status).toBe(0);
    expect(gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/b`]).status).toBe(1);
  });

  it('accepts a baselined pair (top-level or pending) and rejects growth', () => {
    const measured = /share (\d+) duplicated/.exec(gate(['--baseline-dir', baselineDir()]).output)!;
    const windows = Number(measured[1]);
    expect(
      gate([
        '--baseline-dir',
        baselineDir({ 'duplication.json': { pairs: [{ files: [y, x], windows }] } }),
      ]).status,
    ).toBe(0);
    const pendingDir = baselineDir({
      'pending/F2.json': { duplication: [{ files: [x, y], windows, ...PENDING }] },
    });
    expect(gate(['--baseline-dir', pendingDir]).status).toBe(0);
    const tight = baselineDir({
      'duplication.json': { pairs: [{ files: [x, y], windows: windows - 1 }] },
    });
    expect(gate(['--baseline-dir', tight]).output).toContain('above the baselined');
  });
});
