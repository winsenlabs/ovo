import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import { LedgerProviderEvaluationGate } from '../src/provider-gate.ts';
import { PostgresProviderEvaluationAuthorizations } from '../src/provider-authorizations.ts';
import { PostgresEvaluationService } from '../src/service.ts';
import type { EvaluationCase } from '../src/types.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
let service: PostgresEvaluationService, pool: Pool;
const scope = randomUUID();

suite('PostgreSQL evaluation durability', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 12 });
    service = new PostgresEvaluationService({ pool });
    await service.migrate();
    await service.migrate();
    await pool.query(
      'TRUNCATE ovo_eval_case_results,ovo_eval_runs,ovo_eval_dataset_versions,ovo_eval_datasets,ovo_eval_provider_authorizations',
    );
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('uses isolated migrations and immutable validated dataset versions', async () => {
    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ovo_eval_%' ORDER BY tablename",
    );
    expect(tables.rows.map((row) => row.tablename)).toContain('ovo_eval_schema_migrations');
    expect(
      (await pool.query<{ version: number }>('SELECT version FROM ovo_eval_schema_migrations')).rows
        .map((row) => row.version)
        .sort(),
    ).toEqual([1, 2, 3]);
    const dataset = await service.datasets.create({
      workspaceId: `${scope}-data`,
      name: 'Release gate',
      description: 'Fixture cases',
    });
    const first = await service.datasets.importVersion({
      workspaceId: `${scope}-data`,
      datasetId: dataset.id,
      cases: cases('one', 'two'),
      createdBy: 'admin',
    });
    const replay = await service.datasets.importVersion({
      workspaceId: `${scope}-data`,
      datasetId: dataset.id,
      cases: cases('one', 'two'),
      createdBy: 'admin',
    });
    const second = await service.datasets.importVersion({
      workspaceId: `${scope}-data`,
      datasetId: dataset.id,
      cases: cases('one', 'three'),
      createdBy: 'admin',
    });
    expect([first.version, replay.version, second.version]).toEqual([1, 1, 2]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(
      (await service.datasets.listVersions(`${scope}-data`, dataset.id, 1)).items,
    ).toHaveLength(1);
    await expect(
      service.datasets.importVersion({
        workspaceId: `${scope}-data`,
        datasetId: dataset.id,
        cases: [{ id: 'broken' }],
        createdBy: 'admin',
      }),
    ).rejects.toThrow();
  });

  it('deduplicates run creation and grants one epoch-fenced claim', async () => {
    const { datasetId, version } = await fixtureVersion(`${scope}-claim`);
    const input = runInput(`${scope}-claim`, datasetId, version, 'dedupe-a');
    const [first, replay] = await Promise.all([service.createRun(input), service.createRun(input)]);
    expect(first.id).toBe(replay.id);
    await expect(service.createRun({ ...input, releaseId: 'different' })).rejects.toMatchObject({
      statusCode: 409,
    });
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) => service.runs.claim(`worker-${index}`, 20_000)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await expect(
      service.runs.heartbeat(claim.workspaceId, claim.id, 'wrong', claim.ownerEpoch),
    ).rejects.toThrow('no longer owned');
    const requeued = await service.runs.fail(claim, 'transient fixture failure', true);
    expect(requeued.status).toBe('queued');
    const retry = await service.runs.claim('worker-retry', 20_000);
    expect(retry).toMatchObject({ id: claim.id, attempt: 2, ownerEpoch: claim.ownerEpoch + 1 });
    await service.runs.recordResult(retry!, result('one', true));
    await service.runs.recordResult(retry!, result('one', true));
    await service.runs.recordResult(retry!, result('two', false));
    const finished = await service.runs.finish(retry!);
    expect(finished).toMatchObject({ status: 'succeeded', passed: 1, failed: 1, total: 2 });
  });

  it('cancels queued and owned work without allowing further effects', async () => {
    const { datasetId, version } = await fixtureVersion(`${scope}-cancel`);
    const queued = await service.createRun(
      runInput(`${scope}-cancel`, datasetId, version, 'cancel-queued'),
    );
    expect((await service.runs.cancel(`${scope}-cancel`, queued.id))?.status).toBe('cancelled');
    const running = await service.createRun(
      runInput(`${scope}-cancel`, datasetId, version, 'cancel-running'),
    );
    const claim = await service.runs.claim('cancel-worker', 20_000);
    expect(claim?.id).toBe(running.id);
    expect((await service.runs.cancel(`${scope}-cancel`, running.id))?.status).toBe('cancelling');
    expect(
      await service.runs.active(`${scope}-cancel`, running.id, 'cancel-worker', claim!.ownerEpoch),
    ).toBe(false);
    expect((await service.runs.finish(claim!)).status).toBe('cancelled');
  });

  it('persists case results and compares a candidate against the same baseline version', async () => {
    const { datasetId, version } = await fixtureVersion(`${scope}-compare`);
    const baseline = await service.createRun(
      runInput(`${scope}-compare`, datasetId, version, 'baseline'),
    );
    const baselineClaim = await service.runs.claim('baseline-worker', 20_000);
    expect(baselineClaim?.id).toBe(baseline.id);
    await service.runs.recordResult(baselineClaim!, result('one', true));
    await service.runs.recordResult(baselineClaim!, result('two', false));
    await service.runs.finish(baselineClaim!);
    const candidate = await service.createRun(
      runInput(`${scope}-compare`, datasetId, version, 'candidate'),
    );
    const candidateClaim = await service.runs.claim('candidate-worker', 20_000);
    expect(candidateClaim?.id).toBe(candidate.id);
    await service.runs.recordResult(candidateClaim!, result('one', false));
    await service.runs.recordResult(candidateClaim!, result('two', true));
    await service.runs.finish(candidateClaim!);
    expect(await service.runs.compare(`${scope}-compare`, baseline.id, candidate.id)).toMatchObject(
      {
        regressions: ['one'],
        fixes: ['two'],
        unchangedFailures: [],
        baseline: { passed: 1, failed: 1, total: 2 },
        candidate: { passed: 1, failed: 1, total: 2 },
      },
    );
  });

  it('persists provider authorization and case provenance without replay retries', async () => {
    const workspaceId = `${scope}-provider`;
    const { datasetId, version } = await fixtureVersion(workspaceId);
    let authorizations = 0;
    const providerService = new PostgresEvaluationService(
      { pool },
      {
        async authorize() {
          authorizations += 1;
        },
      },
    );
    const created = await providerService.createRun({
      ...runInput(workspaceId, datasetId, version, 'provider-run'),
      executorKind: 'provider',
      fixtureBindingVersion: 'binding-a:version-1',
      budgetAuthorizationId: 'budget-a',
      maxAttempts: 5,
    });
    expect(created).toMatchObject({
      executorKind: 'provider',
      budgetAuthorizationId: 'budget-a',
      maxAttempts: 1,
    });
    expect(authorizations).toBe(1);
    await expect(
      providerService.createRun({
        ...runInput(workspaceId, 'missing-dataset', version, 'missing-provider-run'),
        executorKind: 'provider',
        fixtureBindingVersion: 'binding-a:version-1',
        budgetAuthorizationId: 'budget-a',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(authorizations).toBe(1);
    const claim = await providerService.runs.claim('provider-worker', 20_000);
    await providerService.runs.recordResult(claim!, {
      ...result('one', true),
      provenance: {
        executor: 'provider',
        bindingVersion: 'binding-a:version-1',
        provider: 'openai',
        modelId: 'gpt-evaluation',
        providerRequestIds: ['request-native-1'],
        usageEvidence: 'reported',
        usageReasons: [],
      },
    });
    const persisted = await providerService.runs.listResults(workspaceId, created.id);
    expect(persisted.items[0]?.provenance).toMatchObject({
      bindingVersion: 'binding-a:version-1',
      providerRequestIds: ['request-native-1'],
      usageEvidence: 'reported',
    });
  });

  it('reserves the real workspace ledger before admitting a provider run', async () => {
    const workspaceId = `${scope}-provider-ledger`;
    const ledger = new PostgresCostLedger(pool);
    await ledger.migrate();
    const units = [
      'uncached_input_tokens',
      'cache_read_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
    ];
    for (const unit of units)
      await ledger.putPriceCard({
        id: `${scope}-${unit}`,
        version: 'v1',
        provider: 'openai',
        unit,
        currency: 'INR',
        minorUnitsPerBlock: '1',
        blockQuantity: '1',
        effectiveAt: '2026-09-20T00:00:00.000Z',
        provenance: 'provider evaluation test',
      });
    await ledger.createBudget({
      id: `${scope}-evaluation-budget`,
      workspaceId,
      limitPaise: '100',
      admissionOverspendPaise: '0',
    });
    const bindingVersion = `${scope}-binding:2026-09-20T00:00:00.000Z`;
    const release = {
      id: `${scope}-release`,
      workspaceId,
      agentId: `${scope}-agent`,
      fingerprint: 'sha256:provider-release',
      config: AgentConfig.parse({
        name: 'Provider evaluation',
        mode: 'announcement',
        message: 'Safe fixture announcement',
        costPolicy: {
          budgetId: `${scope}-evaluation-budget`,
          reservationPaise: '25',
          maxCallSeconds: 60,
          priceCards: Object.fromEntries(
            units.map((unit) => [
              `openai.inference.${unit}`,
              { id: `${scope}-${unit}`, version: 'v1' },
            ]),
          ),
        },
      }),
      providerBindings: {
        inference: {
          id: `${scope}-binding`,
          workspaceId,
          provider: 'openai',
          credentialId: `${scope}-credential`,
          config: { model: 'gpt-evaluation', api: 'responses' },
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      },
    };
    const authorizationId = `${scope}-authorization`;
    const releases = {
      async load() {
        return release;
      },
    };
    const authorizations = new PostgresProviderEvaluationAuthorizations(pool, ledger, releases);
    const authorization = await authorizations.createForRelease({
      workspaceId,
      releaseId: release.id,
      maximumReservationPaise: '25',
      idempotencyKey: authorizationId,
      createdBy: 'admin',
    });
    expect(
      await authorizations.createForRelease({
        workspaceId,
        releaseId: release.id,
        maximumReservationPaise: '25',
        idempotencyKey: authorizationId,
        createdBy: 'another-admin',
      }),
    ).toEqual(authorization);
    await expect(
      authorizations.createForRelease({
        workspaceId,
        releaseId: release.id,
        maximumReservationPaise: '26',
        idempotencyKey: authorizationId,
        createdBy: 'admin',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await authorizations.createForRelease({
      workspaceId,
      releaseId: release.id,
      maximumReservationPaise: '25',
      idempotencyKey: `${authorizationId}-page-two`,
      createdBy: 'admin',
    });
    const authorizationPage = await authorizations.list(workspaceId, 1);
    expect(authorizationPage.items).toHaveLength(1);
    expect(authorizationPage.nextCursor).toEqual(expect.any(String));
    expect((await authorizations.list(`${workspaceId}-other`)).items).toEqual([]);
    const gate = new LedgerProviderEvaluationGate(ledger, releases, authorizations);
    const providerService = new PostgresEvaluationService({ pool }, gate, authorizations);
    const { datasetId, version } = await fixtureVersion(workspaceId);
    const providerRun = await providerService.createRun({
      ...runInput(workspaceId, datasetId, version, 'real-ledger-provider-run'),
      releaseId: release.id,
      executorKind: 'provider',
      fixtureBindingVersion: bindingVersion,
      budgetAuthorizationId: authorization.id,
    });
    expect(await ledger.getBudget(`${scope}-evaluation-budget`)).toMatchObject({
      reservedPaise: '25',
      availableForAdmissionPaise: '75',
    });
    const finalClaim = await providerService.runs.claim('provider-final-worker', 20_000);
    expect(finalClaim).toMatchObject({ id: providerRun.id, attempt: 1, maxAttempts: 1 });
    await pool.query(
      `UPDATE ovo_eval_runs SET lease_expires_at=now()-interval '1 second'
       WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, providerRun.id],
    );
    expect(await providerService.runs.claim('provider-reaper', 20_000)).toBeUndefined();
    expect(await providerService.runs.get(workspaceId, providerRun.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
      maxAttempts: 1,
      error: 'Retry budget exhausted',
    });
    expect(await ledger.getBudget(`${scope}-evaluation-budget`)).toMatchObject({
      reservedPaise: '25',
      availableForAdmissionPaise: '75',
    });
    expect((await authorizations.list(workspaceId)).items).toHaveLength(2);
    expect(
      await authorizations.revoke(`${workspaceId}-other`, authorization.id, 'admin'),
    ).toBeUndefined();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let releaseLock!: () => void;
    const releaseLocked = new Promise<void>((resolve) => (releaseLock = resolve));
    const admission = authorizations.withActive(authorization.id, async () => {
      enter();
      await releaseLocked;
      return true;
    });
    await entered;
    let revokeCompleted = false;
    const revocation = authorizations
      .revoke(workspaceId, authorization.id, 'admin')
      .then((value) => {
        revokeCompleted = true;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revokeCompleted).toBe(false);
    releaseLock();
    await expect(admission).resolves.toBe(true);
    expect((await revocation)?.revokedAt).toEqual(expect.any(String));
    expect(await authorizations.get(authorization.id)).toBeUndefined();
  });
});

async function fixtureVersion(workspaceId: string) {
  const dataset = await service.datasets.create({ workspaceId, name: 'Fixture' });
  const version = await service.datasets.importVersion({
    workspaceId,
    datasetId: dataset.id,
    cases: cases('one', 'two'),
    createdBy: 'admin',
  });
  return { datasetId: dataset.id, version };
}
function cases(...ids: string[]): EvaluationCase[] {
  return ids.map((id) => ({
    id,
    mode: 'announcement',
    title: `Case ${id}`,
    tags: ['fixture'],
    turns: [{ input: '' }],
    expected: { outputs: ['ok'] },
    fixture: {},
  }));
}
function runInput(
  workspaceId: string,
  datasetId: string,
  version: { version: number; fingerprint: string },
  idempotencyKey: string,
) {
  return {
    workspaceId,
    datasetId,
    datasetVersion: version.version,
    releaseId: 'release-a',
    releaseFingerprint: 'sha256:release-a',
    fixtureBindingVersion: 'fixture-v1',
    idempotencyKey,
    maxAttempts: 3,
  };
}
function result(caseId: string, passed: boolean) {
  return {
    caseId,
    mode: 'announcement' as const,
    passed,
    outputs: [passed ? 'ok' : 'bad'],
    operations: [],
    durationMs: 1,
  };
}
