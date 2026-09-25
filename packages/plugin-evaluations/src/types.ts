import type { AgentConfig, InferenceReply } from '@winsendotai/ovo-contracts';

export type EvaluationMode = 'announcement' | 'faq' | 'context' | 'agent';
export type ExecutorKind = 'fixture' | 'provider';
export type RunStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed';

export interface EvaluationTurn {
  input: string;
  variables?: Record<string, unknown>;
}
export interface EvaluationExpectation {
  outputs?: string[];
  outputIncludes?: string[];
  errorIncludes?: string;
  operationCount?: number;
  operationStates?: Array<'succeeded' | 'failed' | 'unknown'>;
}
export interface EvaluationFixture {
  inference?: InferenceReply[];
  inferenceDelayMs?: number;
  toolResults?: Record<string, unknown>;
  toolFailures?: string[];
  cancelAfterMs?: number;
}
export interface EvaluationCase {
  id: string;
  mode: EvaluationMode;
  title: string;
  tags: string[];
  turns: EvaluationTurn[];
  expected: EvaluationExpectation;
  fixture: EvaluationFixture;
}
export interface DatasetRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  currentVersion: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface DatasetVersionRecord {
  datasetId: string;
  workspaceId: string;
  version: number;
  fingerprint: string;
  cases: EvaluationCase[];
  createdAt: string;
  createdBy: string;
}
export interface EvaluationRun {
  id: string;
  workspaceId: string;
  datasetId: string;
  datasetVersion: number;
  datasetFingerprint: string;
  releaseId: string;
  releaseFingerprint: string;
  fixtureBindingVersion: string;
  executorKind: ExecutorKind;
  budgetAuthorizationId?: string;
  idempotencyKey: string;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  ownerId?: string;
  ownerEpoch: number;
  leaseExpiresAt?: string;
  passed: number;
  failed: number;
  total: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
export interface EvaluationCaseProvenance {
  executor: ExecutorKind;
  bindingVersion?: string;
  provider?: string;
  modelId?: string;
  providerRequestIds?: string[];
  usageEvidence?: 'reported' | 'estimated' | 'unknown';
  usageReasons?: string[];
}
export interface EvaluationCaseResult {
  runId: string;
  workspaceId: string;
  caseId: string;
  mode: EvaluationMode;
  passed: boolean;
  outputs: string[];
  error?: string;
  operations: Array<{ toolId: string; state: string; confirmed: boolean }>;
  provenance?: EvaluationCaseProvenance;
  durationMs: number;
  createdAt: string;
}
export interface ReleaseEvaluationSnapshot {
  id: string;
  workspaceId?: string;
  agentId?: string;
  fingerprint: string;
  config: AgentConfig;
  providerBindings?: Record<
    string,
    {
      id: string;
      workspaceId: string;
      provider: string;
      credentialId: string;
      config: Record<string, unknown>;
      updatedAt: string;
    }
  >;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface RunComparison {
  baselineRunId: string;
  candidateRunId: string;
  baseline: { passed: number; failed: number; total: number };
  candidate: { passed: number; failed: number; total: number };
  regressions: string[];
  fixes: string[];
  unchangedFailures: string[];
}
