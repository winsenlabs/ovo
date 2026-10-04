import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(run.output).toContain(
      'named carrier hold: packages/plugin-stt-y (skeleton; 2026-10-02: Fixture vendor wire contract)',
    );
    expect(run.output).toContain(
      'named carrier hold: packages/plugin-carrier-unconfirmed (absent; 2026-10-02: Fixture callback signature)',
    );
    expect(run.output).not.toContain('named carrier hold: packages/plugin-stt-w');
  });

  it('refuses an unlisted skeleton and a stale absent-package exemption', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ovo-conformance-holds-'));
    const copied = join(scratch, 'repo');
    try {
      cpSync(root, copied, { recursive: true });
      writeFileSync(join(copied, 'scripts/skeleton-exemptions.json'), '{"exemptions":[]}');
      const unlisted = runGate('check-conformance.mjs', [
        '--root',
        copied,
        '--baseline-dir',
        baselineDir(),
      ]);
      expect(unlisted.status).toBe(1);
      expect(unlisted.output).toContain(
        'plugin-stt-y: unapproved ovo.skeleton (no named, dated exemption)',
      );
      const baselineWrite = runGate('check-conformance.mjs', [
        '--root',
        copied,
        '--baseline-dir',
        baselineDir(),
        '--write-baseline',
      ]);
      expect(baselineWrite.status).toBe(1);
      expect(baselineWrite.output).toContain('unapproved ovo.skeleton');
      cpSync(
        join(root, 'scripts/skeleton-exemptions.json'),
        join(copied, 'scripts/skeleton-exemptions.json'),
      );
      mkdirSync(join(copied, 'packages/plugin-carrier-unconfirmed'));
      writeFileSync(join(copied, 'packages/plugin-carrier-unconfirmed/package.json'), '{}');
      const stale = runGate('check-conformance.mjs', [
        '--root',
        copied,
        '--baseline-dir',
        baselineDir(),
      ]);
      expect(stale.status).toBe(1);
      expect(stale.output).toContain('plugin-carrier-unconfirmed: held-absent exemption is stale');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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

  it('rejects an unapproved vendor kit subset by name', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ovo-conformance-gate-'));
    const copied = join(scratch, 'repo');
    try {
      cpSync(root, copied, { recursive: true });
      writeFileSync(
        join(copied, 'packages/plugin-stt-z/tests/conformance.test.ts'),
        "import { describeSpeechToText } from '@winsendotai/ovo-conformance';\n" +
          "describeSpeechToText('fixture z', () => { throw new Error('never run'); }, { only: ['capabilities are coherent'] });\n",
      );
      const run = runGate('check-conformance.mjs', [
        '--root',
        copied,
        '--baseline-dir',
        baselineDir(),
      ]);
      expect(run.status).toBe(1);
      expect(run.output).toContain('plugin-stt-z: unapproved conformance only: subset 1');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('merges the baseline and pending entries', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ovo-conformance-baseline-'));
    const copied = join(scratch, 'repo');
    try {
      cpSync(root, copied, { recursive: true });
      // A filled plugin can baseline a missing conformance test, never a stale skeleton flag.
      writeFileSync(
        join(copied, 'packages/plugin-stt-w/package.json'),
        JSON.stringify({ name: '@winsendotai/ovo-plugin-stt-w', private: true }),
      );
      const failing = ['packages/plugin-stt-x', 'packages/plugin-stt-w'];
      expect(
        runGate('check-conformance.mjs', [
          '--root',
          copied,
          '--baseline-dir',
          baselineDir({ 'conformance.json': { packages: failing } }),
        ]).status,
      ).toBe(0);
      const dir = baselineDir({
        'pending/S2.json': {
          conformance: failing.map((pkg) => ({ package: pkg, ...PENDING })),
        },
      });
      expect(
        runGate('check-conformance.mjs', ['--root', copied, '--baseline-dir', dir]).status,
      ).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
