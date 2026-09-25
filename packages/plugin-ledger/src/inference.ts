/** Moved verbatim to contracts (`inference-evidence.ts`) so evaluations and the ledger share it without a plugin import. */
export {
  emptyInferenceEvidenceSummary,
  inferenceMeterKey,
  normalizeInferenceEvidence,
} from '@winsendotai/ovo-contracts';
export type {
  InferenceCostBinding,
  InferenceEvidenceState,
  InferenceEvidenceSummary,
  InferenceMeterUnit,
  InferenceNormalizedUsage,
  InferenceUsageEvidence,
  NormalizedInferenceEvidence,
} from '@winsendotai/ovo-contracts';
