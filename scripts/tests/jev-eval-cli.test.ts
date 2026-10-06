import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SPAWN_TIMEOUT_MS } from './gate-helpers.ts';

const evalJev = (args: string[], env: Record<string, string> = {}) => {
  const { OVO_JEV_EVAL_API_KEY: _key, ...inherited } = process.env;
  return spawnSync('node_modules/.bin/tsx', ['scripts/jev-eval.ts', ...args], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...inherited, ...env },
  });
};

describe('pnpm eval:jev', () => {
  it('replays the committed answers offline and prints the gate verdict', () => {
    const run = evalJev([]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('Jev eval: CreditMantri collections');
    expect(run.stdout).toContain('By listen set:');
    expect(run.stdout).toMatch(/Gate: PASS\n$/);
    const json = evalJev(['--json']);
    expect(json.status, json.stderr).toBe(0);
    const { report } = JSON.parse(json.stdout);
    expect(report.gate.passed).toBe(true);
    expect(report.overall.total).toBeGreaterThanOrEqual(110);
  });

  it('refuses to record without a key or a calibration label, before any request', () => {
    const keyless = evalJev(['--record', '--calibration-label', 'cohort-1']);
    expect(keyless.status).toBe(1);
    expect(keyless.stderr).toContain('--record needs OVO_JEV_EVAL_API_KEY');
    const unlabelled = evalJev(['--record'], { OVO_JEV_EVAL_API_KEY: 'not-a-real-key' });
    expect(unlabelled.status).toBe(1);
    expect(unlabelled.stderr).toContain('requires a non-empty calibrationLabel');
  });
});
