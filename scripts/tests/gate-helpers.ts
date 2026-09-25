import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

export const FIXTURES = 'scripts/tests/fixtures';

/**
 * How long a spawned gate may take, and the per-test timeout every test that spawns one passes to
 * `it(...)`. vitest's shared testTimeout (15 s, vitest.config.ts) is a limit for in-process unit
 * tests: these tests fork child Node processes — `lint.mjs` alone runs seven gates in sequence,
 * ~4.5 s idle — and a full `pnpm test` runs four workers at once, which pushed the slowest of them
 * past 15 s and made the suite flaky. The budget below matches the spawn timeout, so a genuinely
 * hung gate still fails the test rather than hanging the run.
 */
export const SPAWN_TIMEOUT_MS = 120_000;

export interface GateRun {
  status: number | null;
  output: string;
}

/** Runs `node scripts/<script> ...args` from the repository root. */
export function runGate(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
): GateRun {
  const result = spawnSync(process.execPath, [`scripts/${script}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Runs the one-test project in fixtures/runtime-violation, which loads the real
 * scripts/vitest-global-setup.ts and scripts/vitest-violation-sink.ts and reports one runtime
 * violation, with `baselineDirectory` as its OVO_BASELINE_DIR.
 */
export function runFixtureVitest(baselineDirectory: string): GateRun {
  const env: NodeJS.ProcessEnv = { ...process.env, OVO_BASELINE_DIR: baselineDirectory };
  // Never inherit the parent run's log or its write mode: the child makes its own.
  delete env.OVO_PLUGIN_VIOLATION_LOG;
  delete env.OVO_WRITE_VIOLATION_BASELINE;
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      `${FIXTURES}/runtime-violation/vitest.config.ts`,
    ],
    { encoding: 'utf8', env, timeout: SPAWN_TIMEOUT_MS },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary baseline directory: `{ 'module-size.json': {...}, 'pending/F2.json': {...} }`. */
export function baselineDir(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ovo-gate-baselines-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

export const pending = (entries: unknown[], key: string) => ({ [key]: entries });
export const PENDING = { reason: 'gate test', removeBy: 'I1' };
