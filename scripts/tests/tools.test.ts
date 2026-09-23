import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkViolations,
  readViolationLog,
  writeViolationBaseline,
} from '../vitest-global-setup.ts';
import { FIXTURES, PENDING, baselineDir, runGate } from './gate-helpers.ts';

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

  it('fails only on diagnostics under the prefixes', () => {
    const inside = runGate('typecheck-scope.mjs', [`${FIXTURES}/typecheck-scope/bad`], project);
    expect(inside.status).toBe(1);
    expect(inside.output).toContain('broken.ts');
    const outside = runGate('typecheck-scope.mjs', [`${FIXTURES}/typecheck-scope/good`], project);
    expect(outside.status).toBe(0);
    expect(outside.output).toContain('1 out-of-scope diagnostic');
  });
});

describe('lint.mjs', () => {
  it('runs all seven gates and forwards --only', () => {
    const run = runGate('lint.mjs', ['--only', 'packages/audio']);
    expect(run.status).toBe(0);
    for (const gate of [
      'architecture',
      'module-size',
      'duplication',
      'provider-names',
      'capability-keys',
      'conformance',
    ])
      expect(run.output).toContain(`[${gate}]`);
    expect(run.output).toContain('Verified');
    expect(run.output).toContain('lint passed: 7 gates');
  });
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
});
