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

  it('--only limits what it reports, and the summary too', () => {
    const run = gate([
      '--baseline-dir',
      baselineDir(),
      '--only',
      `${root}/packages/demo/src/ok.ts`,
      `${root}/packages/demo/tests`,
    ]);
    expect(run.status).toBe(0);
    expect(run.output).not.toContain('big.ts');
    // The summary counts the scope it was asked about: ok.ts plus the one file under tests/.
    expect(run.output).toContain('passed for 2 files');
    // Not big.ts's 301 lines, which is out of scope.
    expect(run.output).toContain('largest source module 1 lines');
  });

  it('reports an empty summary for a prefix that matches nothing', () => {
    const run = gate(['--baseline-dir', baselineDir(), '--only', 'packages/does-not-exist']);
    expect(run.status).toBe(0);
    expect(run.output).toContain(
      'passed for 0 files (packages/does-not-exist); largest source module 0 lines.',
    );
  });

  it('fails on a module over 24 KiB and on a test file over 500 lines', () => {
    const limits = `${FIXTURES}/module-size-limits`;
    const run = runGate('check-module-size.mjs', [
      '--root',
      limits,
      '--baseline-dir',
      baselineDir(),
    ]);
    expect(run.status).toBe(1);
    // Well under 300 lines, so only its size can fail it.
    expect(run.output).toMatch(
      new RegExp(
        `${limits}/packages/demo/src/wide\\.ts: 2\\d\\d canonical nonblank lines, \\d+ bytes; limit 24 KiB`,
      ),
    );
    expect(run.output).toContain(
      `${limits}/packages/demo/tests/over-limit.test.ts: 501 canonical nonblank lines`,
    );
    expect(run.output).toContain('test limit 500 lines');
    // 500 lines is the limit, not one line over it; and the 24 KiB module is nowhere near 400
    // lines, so neither the source nor the hard line limit fires on it.
    expect(run.output).not.toContain('at-limit.test.ts');
    expect(run.output).not.toContain('hard limit');
    expect(run.output).not.toContain('source limit');
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
