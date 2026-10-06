// The deploy, ops and backup shell scripts: syntax under the macOS bash 3.2 the tests run on,
// shellcheck when it is installed, and every OVO_OPS_* setting they read is documented.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../ops/tests/fake-stack.ts';

const SCRIPTS = ['scripts/deploy', 'scripts/ops', 'scripts/backup']
  .flatMap((dir) => readdirSync(join(ROOT, dir)).map((name) => join(dir, name)))
  .filter((path) => path.endsWith('.sh'))
  .concat(['scripts/bootstrap-compose.sh']);

const shellcheck = (() => {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('deploy and ops shell scripts', () => {
  it.each(SCRIPTS)('%s parses', (path) => {
    expect(() => execFileSync('bash', ['-n', join(ROOT, path)], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(SCRIPTS.filter((path) => !path.endsWith('lib.sh')))('%s is executable', (path) => {
    expect(statSync(join(ROOT, path)).mode & 0o111).not.toBe(0);
  });

  it.skipIf(!shellcheck)('pass shellcheck at warning level', () => {
    const run = () =>
      execFileSync('shellcheck', ['-x', '-P', 'SCRIPTDIR', '--severity=warning', ...SCRIPTS], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    expect(run).not.toThrow();
  });

  it('documents every OVO_OPS_* setting they read', () => {
    const reference = readFileSync(join(ROOT, 'docs/env-reference.md'), 'utf8');
    const used = new Set(
      SCRIPTS.flatMap(
        (path) => readFileSync(join(ROOT, path), 'utf8').match(/OVO_OPS_[A-Z0-9_]*[A-Z0-9]/g) ?? [],
      ),
    );
    for (const module of readdirSync(join(ROOT, 'scripts/ops')).filter((name) =>
      name.endsWith('.mjs'),
    ))
      for (const name of readFileSync(join(ROOT, 'scripts/ops', module), 'utf8').match(
        /OVO_OPS_[A-Z0-9_]*[A-Z0-9]/g,
      ) ?? [])
        used.add(name);
    const missing = [...used].filter((name) => !reference.includes(name)).sort();
    expect(missing).toEqual([]);
  });
});
