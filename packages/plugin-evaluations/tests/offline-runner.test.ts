import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import {
  BUILTIN_EVALUATION_CASES,
  FixtureEvaluationExecutor,
  datasetFingerprint,
  fixtureReleaseForCase,
  validateCases,
} from '../src/index.ts';
import type { EvaluationRun } from '../src/types.ts';

describe('120-case offline evaluation corpus', () => {
  it('contains 30 meaningful cases for every supported mode', () => {
    const cases = validateCases(BUILTIN_EVALUATION_CASES);
    expect(cases).toHaveLength(120);
    expect(new Set(cases.map((item) => item.id)).size).toBe(120);
    for (const mode of ['announcement', 'faq', 'context', 'agent'])
      expect(cases.filter((item) => item.mode === mode)).toHaveLength(30);
    expect(cases.some((item) => item.tags.includes('currency'))).toBe(true);
    expect(cases.some((item) => item.tags.includes('script-graph'))).toBe(true);
    expect(cases.some((item) => item.tags.includes('context-overflow'))).toBe(true);
    expect(cases.some((item) => item.tags.includes('unknown-state'))).toBe(true);
    expect(datasetFingerprint(cases)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('executes all cases through real behaviors and shared execution with transparent fixtures', async () => {
    const executor = new FixtureEvaluationExecutor();
    const failures: Array<{ id: string; outputs: string[]; error?: string }> = [];
    for (const testCase of BUILTIN_EVALUATION_CASES) {
      const release = fixtureReleaseForCase(testCase);
      const result = await executor.executeCase(
        run(release.id, release.fingerprint),
        release,
        testCase,
      );
      if (!result.passed)
        failures.push({ id: testCase.id, outputs: result.outputs, error: result.error });
    }
    expect(failures).toEqual([]);
  });

  it('executes the requested release snapshot rather than a canned corpus config', async () => {
    const executor = new FixtureEvaluationExecutor();
    const release = {
      id: 'requested-release',
      fingerprint: 'sha256:requested-release',
      config: AgentConfig.parse({
        name: 'Requested release',
        mode: 'announcement',
        message: 'Requested {{customer}}',
        variables: {
          type: 'object',
          required: ['customer'],
          properties: { customer: { type: 'string' } },
          additionalProperties: false,
        },
      }),
    };
    const testCase = {
      id: 'requested-release-case',
      mode: 'announcement' as const,
      title: 'Requested release config',
      tags: ['release-snapshot'],
      turns: [{ input: '', variables: { customer: 'Meera' } }],
      expected: { outputs: ['Requested Meera'] },
      fixture: {},
    };
    expect(
      (await executor.executeCase(run(release.id, release.fingerprint), release, testCase)).passed,
    ).toBe(true);
  });
});

function run(releaseId: string, releaseFingerprint: string): EvaluationRun {
  return {
    id: `offline-${releaseId}`,
    workspaceId: 'workspace-fixture',
    datasetId: 'builtin',
    datasetVersion: 1,
    datasetFingerprint: 'sha256:builtin',
    releaseId,
    releaseFingerprint,
    fixtureBindingVersion: 'transparent-fixtures-v1',
    executorKind: 'fixture',
    idempotencyKey: releaseId,
    status: 'running',
    attempt: 1,
    maxAttempts: 1,
    ownerId: 'offline',
    ownerEpoch: 1,
    passed: 0,
    failed: 0,
    total: 120,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}
