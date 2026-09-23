import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

export const FIXTURES = 'scripts/tests/fixtures';

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
    timeout: 120_000,
  });
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
