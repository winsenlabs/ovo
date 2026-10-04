import { describe, expect, it } from 'vitest';
import { FIXTURES, SPAWN_TIMEOUT_MS, runGate } from './gate-helpers.ts';

const root = `${FIXTURES}/upstream`;
const gate = (args: string[] = []) => runGate('check-upstream.mjs', ['--root', root, ...args]);

describe('check-upstream', () => {
  it('fails on a pinned file whose hash changed and on one that is gone', () => {
    const run = gate();
    expect(run.status).toBe(1);
    expect(run.output).toContain(`Pinned upstream extraction changed: ${root}/pinned/tampered.txt`);
    expect(run.output).toContain(`${root}/pinned/deleted.txt: pinned upstream file is missing`);
    // The file that still matches its recorded sha256 is never mentioned.
    expect(run.output).not.toContain('unchanged.txt');
  });

  it('checks the whole lock under --only, and says that it ignored the prefixes', () => {
    // Provenance is a property of the whole checkout: unlike the file-scanning gates, this one may
    // not narrow to a prefix, or a scoped wave-2 run would stop noticing a tampered extraction.
    const run = gate(['--only', `${root}/pinned/unchanged.txt`]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('--only');
    expect(run.output).toContain('ignored: upstream provenance is checked repository-wide');
    expect(run.output).toContain('tampered.txt');
  });

  it(
    'passes on the repository and reports how many files it verified',
    () => {
      const run = runGate('check-upstream.mjs');
      expect(run.status).toBe(0);
      expect(run.output).toMatch(
        /\[upstream\] Verified \d+ pinned DeepSeek source files at [0-9a-f]{40}\./,
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
