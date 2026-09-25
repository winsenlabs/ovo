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
    // legacy-paths.ts holds one real `legacyPaths:` declaration, which is allowlisted, and two
    // lines that only mention the token (inside another identifier, and in a trailing comment).
    // Only those two count: the allowlist is for the declaration, not for any line containing it.
    expect(run.output).toContain(
      `${root}/apps/api/src/legacy-paths.ts: 2 provider-name occurrences`,
    );
  });

  it('--only limits what it reports', () => {
    expect(gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages`]).status).toBe(0);
  });

  it('ratchets per-file counts from the baseline and pending files', () => {
    const legacy = `${root}/apps/api/src/legacy-paths.ts`;
    const baseline = (count: number) => ({
      'provider-names.json': { files: { [carrier]: count, [legacy]: 2 } },
    });
    expect(gate(['--baseline-dir', baselineDir(baseline(3))]).status).toBe(0);
    expect(gate(['--baseline-dir', baselineDir(baseline(2))]).status).toBe(1);
    const dir = baselineDir({
      'provider-names.json': { files: { [legacy]: 2 } },
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
    // 'ovo.stt@2', the template head 'ovo.tool-connector.', and the tail and middle of the two
    // templates below it: a key in `${x}ovo.stt` counts exactly like one in a plain string.
    expect(run.output).toContain(`${file}: 4 capability-key string literals`);
    expect(run.output).not.toContain('keys.ts:');
    // 'ovo.not-a-key' in packages/q is neither a key nor under a declared prefix.
    expect(run.output).not.toContain('/q/src/b.ts');
  });

  it('--only limits what it reports', () => {
    expect(gate(['--baseline-dir', baselineDir(), '--only', `${root}/packages/q`]).status).toBe(0);
  });

  it('merges the top-level and pending ratchets', () => {
    expect(
      gate(['--baseline-dir', baselineDir({ 'capability-keys.json': { files: { [file]: 4 } } })])
        .status,
    ).toBe(0);
    expect(
      gate(['--baseline-dir', baselineDir({ 'capability-keys.json': { files: { [file]: 3 } } })])
        .status,
    ).toBe(1);
    const dir = baselineDir({
      'pending/E2.json': { capabilityKeys: [{ file, count: 4, ...PENDING }] },
    });
    expect(gate(['--baseline-dir', dir]).status).toBe(0);
  });
});
