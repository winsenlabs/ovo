import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/architecture`;
const gate = (args: string[]) => runGate('check-architecture.mjs', ['--root', root, ...args]);
const EDGES = [
  { from: 'packages/plugin-a', to: 'packages/plugin-b' },
  { from: 'packages/kit-x', to: 'node:fs' },
  { from: 'packages/plugin-stt-v', to: 'ws' },
  { from: 'apps/app1', to: 'packages/plugin-stt-v' },
];

describe('check-architecture', () => {
  it('fails on each kind-table violation in the fixture and skips fixtures/ and tests/', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'plugins may not import another plugin or behaviors (packages/plugin-a -> packages/plugin-b)',
    );
    expect(run.output).toContain('kits may not import node built-ins (packages/kit-x -> node:fs)');
    expect(run.output).toContain('vendor plugins may not import ws');
    expect(run.output).toContain(
      'apps may not import vendor-plugin packages (apps/app1 -> packages/plugin-stt-v)',
    );
    expect(run.output).not.toContain('ignored.ts');
    expect(run.output).not.toContain('support.ts');
  });

  it('--only limits what it reports', () => {
    const run = gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/plugin-b`]);
    expect(run.status).toBe(0);
  });

  it('accepts baselined edges, merges pending edges and warns on stale ones', () => {
    const [first, ...rest] = EDGES;
    const dir = baselineDir({
      'architecture.json': {
        edges: [...rest, { from: 'packages/plugin-b', to: 'packages/plugin-a' }],
      },
      'pending/F2.json': { architecture: [{ ...first, ...PENDING }] },
    });
    const run = gate(['--baseline-dir', dir]);
    expect(run.status).toBe(0);
    expect(run.output).toContain('stale baseline edge packages/plugin-b -> packages/plugin-a');
  });

  it('passes on the repository with the committed baselines', () => {
    const run = runGate('check-architecture.mjs');
    expect(run.output).toContain('passed');
    expect(run.status).toBe(0);
  });
});
