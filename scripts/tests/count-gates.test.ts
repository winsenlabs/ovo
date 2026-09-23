import { describe, expect, it } from 'vitest';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

describe('check-provider-names', () => {
  const root = `${FIXTURES}/provider-names`;
  const carrier = `${root}/apps/api/src/carrier.ts`;
  const gate = (args: string[]) => runGate('check-provider-names.mjs', ['--root', root, ...args]);

  it('fails on vendor names in host code, allowlisting migrations and legacyPaths', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${carrier}: 3 provider-name occurrences`);
    expect(run.output).not.toContain('migrations');
    expect(run.output).not.toContain('legacy-paths.ts');
  });

  it('--only limits what it reports', () => {
    expect(gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages`]).status).toBe(0);
  });

  it('ratchets per-file counts from the baseline and pending files', () => {
    expect(
      gate(['--baseline-dir', baselineDir({ 'provider-names.json': { files: { [carrier]: 3 } } })])
        .status,
    ).toBe(0);
    expect(
      gate(['--baseline-dir', baselineDir({ 'provider-names.json': { files: { [carrier]: 2 } } })])
        .status,
    ).toBe(1);
    const dir = baselineDir({
      'pending/C1.json': { providerNames: [{ file: carrier, count: 3, ...PENDING }] },
    });
    expect(gate(['--baseline-dir', dir]).status).toBe(0);
  });
});

describe('check-capability-keys', () => {
  const root = `${FIXTURES}/capability-keys`;
  const file = `${root}/packages/p/src/a.ts`;
  const gate = (args: string[]) => runGate('check-capability-keys.mjs', ['--root', root, ...args]);

  it('fails on capability strings outside keys.ts (keys, @major forms and prefixes)', () => {
    const run = gate(['--baseline-dir', baselineDir()]);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${file}: 2 capability-key string literals`);
    expect(run.output).not.toContain('keys.ts:');
  });

  it('--only limits what it reports', () => {
    expect(gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/q`]).status).toBe(0);
  });

  it('merges the top-level and pending ratchets', () => {
    expect(
      gate(['--baseline-dir', baselineDir({ 'capability-keys.json': { files: { [file]: 2 } } })])
        .status,
    ).toBe(0);
    const dir = baselineDir({
      'pending/E2.json': { capabilityKeys: [{ file, count: 2, ...PENDING }] },
    });
    expect(gate(['--baseline-dir', dir]).status).toBe(0);
  });
});
