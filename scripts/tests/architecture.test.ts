import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, SPAWN_TIMEOUT_MS, baselineDir, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/architecture`;
const gate = (args: string[]) => runGate('check-architecture.mjs', ['--root', root, ...args]);
const EDGES = [
  { from: 'packages/plugin-a', to: 'packages/plugin-b' },
  { from: 'packages/kit-x', to: 'node:fs' },
  { from: 'packages/kit-x', to: 'packages/plugin-a' },
  { from: 'packages/plugin-stt-v', to: 'ws' },
  { from: 'apps/app1', to: 'packages/plugin-stt-v' },
];

describe('check-architecture', () => {
  it('fails on each kind-table violation in the fixture and skips fixtures/', () => {
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
  });

  it('applies the kind table to tests/ helpers but not to *.test.ts files', () => {
    // Conformance drivers and fixture plugins live under tests/, so an exemption there would let a
    // vendor plugin's tests/helpers.ts import another plugin or `ws` unnoticed (§13 exempts
    // neither). Real test files stay exempt: a test may import whatever it exercises.
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.output).toContain(
      `${root}/packages/kit-x/tests/helpers.ts: kits may import only contracts and third-party code (packages/kit-x -> packages/plugin-a)`,
    );
    // tests/support.ts repeats plugin-a -> plugin-b, so it merges into src/index.ts's edge.
    expect(run.output).toContain(
      `${root}/packages/plugin-a/src/index.ts: plugins may not import another plugin or behaviors (packages/plugin-a -> packages/plugin-b) and 1 more files`,
    );
    expect(run.output).not.toContain('thing.test.ts');
    expect(run.output).not.toContain('packages/plugin-b -> packages/plugin-a');
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

  it(
    'passes on the repository with the committed baselines',
    () => {
      const run = runGate('check-architecture.mjs');
      expect(run.output).toContain('passed');
      expect(run.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});
