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

export interface EvaluationRunComparison {
  baselineRunId: string;
  candidateRunId: string;
  baseline: { passed: number; failed: number; total: number };
  candidate: { passed: number; failed: number; total: number };
  regressions: string[];
  fixes: string[];
  unchangedFailures: string[];
}
