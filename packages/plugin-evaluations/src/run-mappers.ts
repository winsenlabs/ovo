import type { EvaluationCaseResult, EvaluationRun, ExecutorKind } from './types.ts';

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

export function mapRun(row: Row): EvaluationRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    datasetId: String(row.dataset_id),
    datasetVersion: Number(row.dataset_version),
    datasetFingerprint: String(row.dataset_fingerprint),
    releaseId: String(row.release_id),
    releaseFingerprint: String(row.release_fingerprint),
    fixtureBindingVersion: String(row.fixture_binding_version),
    executorKind: row.executor_kind as ExecutorKind,
    budgetAuthorizationId: row.budget_authorization_id
      ? String(row.budget_authorization_id)
      : undefined,
    idempotencyKey: String(row.idempotency_key),
    status: row.status as EvaluationRun['status'],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    ownerId: row.owner_id ? String(row.owner_id) : undefined,
    ownerEpoch: Number(row.owner_epoch),
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined,
    passed: Number(row.passed),
    failed: Number(row.failed),
    total: Number(row.total),
    error: row.error ? String(row.error) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
  };
}

export function mapResult(row: Row): EvaluationCaseResult {
  return {
    runId: String(row.run_id),
    workspaceId: String(row.workspace_id),
    caseId: String(row.case_id),
    mode: row.mode as EvaluationCaseResult['mode'],
    passed: Boolean(row.passed),
    outputs: structuredClone(row.outputs) as string[],
    error: row.error ? String(row.error) : undefined,
    operations: structuredClone(row.operations) as EvaluationCaseResult['operations'],
    provenance:
      row.provenance && Object.keys(row.provenance as object).length
        ? (structuredClone(row.provenance) as EvaluationCaseResult['provenance'])
        : undefined,
    durationMs: Number(row.duration_ms),
    createdAt: iso(row.created_at),
  };
}

export function stripResult(value: EvaluationCaseResult) {
  const { createdAt: _createdAt, ...identity } = value;
  return identity;
}
