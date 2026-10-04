import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresEvaluationService } from '../../../../packages/plugin-evaluations/src/index.ts';

export async function seedRestoreDrillEvaluations(input: {
  sourceUrl: string;
  workspaceId: string;
  releaseId: string;
}) {
  const { sourceUrl, workspaceId, releaseId } = input;
  const evaluationPool = new Pool({ connectionString: sourceUrl });
  const evaluations = new PostgresEvaluationService({ pool: evaluationPool });
  await evaluations.migrate();
  const dataset = await evaluations.datasets.create({ workspaceId, name: 'Restore drill' });
  const version = await evaluations.datasets.importVersion({
    workspaceId,
    datasetId: dataset.id,
    createdBy: 'drill',
    cases: [
      {
        id: 'restore-case',
        mode: 'announcement',
        title: 'Restore case',
        tags: ['restore-drill'],
        turns: [{ input: '', variables: {} }],
        expected: { outputs: ['Restored'] },
        fixture: {},
      },
    ],
  });
  const evaluationRunId = (
    await evaluations.createRun({
      workspaceId,
      datasetId: dataset.id,
      datasetVersion: version.version,
      releaseId,
      releaseFingerprint: 'sha256:restore-drill',
      fixtureBindingVersion: 'ovo-session-fixtures-v1',
      idempotencyKey: 'restore-drill',
      maxAttempts: 3,
    })
  ).id;
  const evaluationClaim = await evaluations.runs.claim('evaluation-before-restore', 60_000);
  if (!evaluationClaim) throw new Error('failed to own evaluation drill run');
  const providerEvaluations = new PostgresEvaluationService(
    { pool: evaluationPool },
    { authorize: async () => undefined },
  );
  const providerAuthorizationId = `evalauth_restore_${randomUUID().replaceAll('-', '')}`;
  await evaluationPool.query(
    `INSERT INTO ovo_eval_provider_authorizations
       (workspace_id,id,idempotency_key,release_id,release_fingerprint,binding_version,provider,
        model_id,budget_id,maximum_reservation_paise,created_by,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
    [
      workspaceId,
      providerAuthorizationId,
      'restore-active-provider-authorization',
      releaseId,
      'sha256:restore-drill',
      'provider-binding-v1',
      'fixture-provider',
      'fixture-model',
      'restore-budget',
      '100',
      'restore-drill',
    ],
  );
  const providerEvaluationRunId = (
    await providerEvaluations.createRun({
      workspaceId,
      datasetId: dataset.id,
      datasetVersion: version.version,
      releaseId,
      releaseFingerprint: 'sha256:restore-drill',
      fixtureBindingVersion: 'provider-binding-v1',
      executorKind: 'provider',
      budgetAuthorizationId: providerAuthorizationId,
      idempotencyKey: 'restore-provider-drill',
      maxAttempts: 3,
    })
  ).id;

  await evaluationPool.end();
  return {
    evaluationRunId,
    providerEvaluationRunId,
    providerAuthorizationId,
    staleEvaluationEpoch: evaluationClaim.ownerEpoch,
  };
}
