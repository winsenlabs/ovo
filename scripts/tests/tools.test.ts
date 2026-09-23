import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkViolations,
  readViolationLog,
  writeViolationBaseline,
} from '../vitest-global-setup.ts';
import {
  FIXTURES,
  PENDING,
  SPAWN_TIMEOUT_MS,
  baselineDir,
  runFixtureVitest,
  runGate,
} from './gate-helpers.ts';

describe('check-terraform', () => {
  it('prints SKIPPED and exits 0 without terraform or docker', () => {
    const run = runGate('check-terraform.mjs', [], {
      OVO_TERRAFORM_BIN: '/nonexistent/terraform',
      OVO_DOCKER_BIN: '/nonexistent/docker',
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain('SKIPPED');
  });
});

describe('typecheck-scope', () => {
  const project = { OVO_TYPECHECK_PROJECT: `${FIXTURES}/typecheck-scope/tsconfig.json` };

  it(
    'fails only on diagnostics under the prefixes',
    () => {
      const inside = runGate('typecheck-scope.mjs', [`${FIXTURES}/typecheck-scope/bad`], project);
      expect(inside.status).toBe(1);
      expect(inside.output).toContain('broken.ts');
      const outside = runGate('typecheck-scope.mjs', [`${FIXTURES}/typecheck-scope/good`], project);
      expect(outside.status).toBe(0);
      expect(outside.output).toContain('1 out-of-scope diagnostic');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('lint.mjs', () => {
  it(
    'runs all seven gates and forwards --only',
    () => {
      const run = runGate('lint.mjs', ['--only', 'packages/audio']);
      expect(run.status).toBe(0);
      for (const gate of [
        'architecture',
        'upstream',
        'module-size',
        'duplication',
        'provider-names',
        'capability-keys',
        'conformance',
      ])
        expect(run.output).toContain(`[${gate}]`);
      expect(run.output).toContain('Verified');
      expect(run.output).toContain('lint passed: 7 gates');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('--write-baseline with --only', () => {
  // Every gate builds only the in-scope part of its state under --only, so writing a baseline from
  // that run would silently delete every out-of-scope entry. parseArgs refuses for all of them,
  // including gates this test does not name.
  const GATES = [
    'check-architecture.mjs',
    'check-module-size.mjs',
    'check-duplication.mjs',
    'check-provider-names.mjs',
    'check-capability-keys.mjs',
    'check-conformance.mjs',
    'check-upstream.mjs',
  ];

  it(
    'is refused by every gate, leaving the baseline on disk untouched',
    () => {
      for (const gate of GATES) {
        const dir = baselineDir({ 'architecture.json': { edges: [] } });
        const before = readFileSync(`${dir}/architecture.json`, 'utf8');
        const run = runGate(gate, [
          '--baseline-dir',
          dir,
          '--write-baseline',
          '--only',
          'packages/audio',
        ]);
        expect(run.status, gate).toBe(1);
        expect(run.output, gate).toContain('cannot be combined with --only');
        expect(readFileSync(`${dir}/architecture.json`, 'utf8'), gate).toBe(before);
        expect(existsSync(`${dir}/module-size.json`), gate).toBe(false);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'still writes a whole-repository baseline when --only is absent',
    () => {
      const dir = baselineDir();
      const run = runGate('check-architecture.mjs', ['--baseline-dir', dir, '--write-baseline']);
      expect(run.status).toBe(0);
      const written = JSON.parse(readFileSync(`${dir}/architecture.json`, 'utf8'));
      expect(written.edges.length).toBeGreaterThan(0);
      // Edges from packages the scoped run above would have dropped are all still there.
      expect(
        new Set(written.edges.map((edge: { from: string }) => edge.from)).size,
      ).toBeGreaterThan(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('runtime violation ratchet', () => {
  const entry = { pluginId: 'p', kind: 'read-undeclared', key: 'ovo.stt' };

  it('fails on violations missing from the baseline and every pending list', () => {
    expect(checkViolations([entry], baselineDir())).toEqual([
      'new runtime violation read-undeclared by p on ovo.stt',
    ]);
    expect(
      checkViolations([entry], baselineDir({ 'runtime-violations.json': { violations: [entry] } })),
    ).toEqual([]);
    const pending = baselineDir({
      'pending/E2.json': { runtimeViolations: [{ ...entry, ...PENDING }] },
    });
    expect(checkViolations([entry], pending)).toEqual([]);
    const malformed = baselineDir({ 'pending/E2.json': { runtimeViolations: [entry] } });
    expect(checkViolations([], malformed)[0]).toContain('removeBy "I1"');
  });

  it('dedupes the JSONL log by (pluginId, kind, key) and merges into the baseline', () => {
    const dir = baselineDir({ 'violations.jsonl': {} });
    const log = `${dir}/log.jsonl`;
    const line = (mode: string) => JSON.stringify({ ...entry, mode });
    writeFileSync(log, `${line('warn')}\n${line('enforce')}\n`);
    expect(readViolationLog(log)).toEqual([entry]);
    expect(writeViolationBaseline([entry, entry], dir)).toBe(1);
    expect(JSON.parse(readFileSync(`${dir}/runtime-violations.json`, 'utf8')).violations).toEqual([
      entry,
    ]);
  });

  // The functions above are also wired into vitest: a real run of the fixture project below loads
  // the true globalSetup, reports one violation through the sink, and must come back non-zero.
  it(
    'makes the globalSetup teardown fail a real vitest run whose violation is not baselined',
    () => {
      const probe = {
        pluginId: 'fixture-probe',
        kind: 'read-undeclared',
        key: 'ovo.fixture-probe',
      };
      const failed = runFixtureVitest(baselineDir());
      expect(failed.output).toContain('1 passed');
      expect(failed.output).toContain(
        'new runtime violation read-undeclared by fixture-probe on ovo.fixture-probe',
      );
      expect(failed.status).toBe(1);

      const baselined = runFixtureVitest(
        baselineDir({ 'runtime-violations.json': { violations: [probe] } }),
      );
      expect(baselined.status).toBe(0);

      const viaPending = runFixtureVitest(
        baselineDir({ 'pending/E2.json': { runtimeViolations: [{ ...probe, ...PENDING }] } }),
      );
      expect(viaPending.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});
