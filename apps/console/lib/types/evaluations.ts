export interface EvaluationDataset {
  id: string;
  name: string;
  description: string;
  currentVersion: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface EvaluationCase {
  id: string;
  mode: 'announcement' | 'faq' | 'context' | 'agent';
  title: string;
  tags: string[];
  turns: Array<{ input: string; variables?: Record<string, unknown> }>;
  expected: Record<string, unknown>;
  fixture: Record<string, unknown>;
}
export interface EvaluationDatasetVersion {
  datasetId: string;
  version: number;
  fingerprint: string;
  cases: EvaluationCase[];
  createdAt: string;
  createdBy: string;
}
export interface ProviderEvaluationAuthorization {
  id: string;
  workspaceId: string;
  releaseId: string;
  releaseFingerprint: string;
  bindingVersion: string;
  provider: string;
  modelId: string;
  budgetId: string;
  maximumReservationPaise: string;
  createdBy: string;
  createdAt: string;
  revokedBy?: string;
  revokedAt?: string;
}
export interface EvaluationRunRecord {
  id: string;
  datasetId: string;
  datasetVersion: number;
  datasetFingerprint: string;
  releaseId: string;
  releaseFingerprint: string;
  fixtureBindingVersion: string;
  executorKind: 'fixture' | 'provider';
  budgetAuthorizationId?: string;
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed';
  attempt: number;
  maxAttempts: number;
  passed: number;
  failed: number;
  total: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
export interface EvaluationCaseResult {
  runId: string;
  caseId: string;
  mode: EvaluationCase['mode'];
  passed: boolean;
  outputs: string[];
  error?: string;
  operations: Array<{ toolId: string; state: string; confirmed: boolean }>;
  durationMs: number;
  createdAt: string;
}
export interface EvaluationComparison {
  baselineRunId: string;
  candidateRunId: string;
  baseline: { passed: number; failed: number; total: number };
  candidate: { passed: number; failed: number; total: number };
  regressions: string[];
  fixes: string[];
  unchangedFailures: string[];
}
