import type { AgentConfig, UsageMeter } from '@winsendotai/ovo-contracts';
import type {
  CostLedgerService,
  CostSummary,
  RecordUsageInput,
  ReservationResult,
} from '@winsendotai/ovo-plugin-ledger';
import type { WorkerCostPolicyController } from './cost-policy.ts';
import type {
  InferenceCostBinding,
  InferenceEvidenceSummary,
  InferenceUsageEvidence,
} from './cost-inference.ts';

export type CostPolicy = NonNullable<AgentConfig['costPolicy']>;
export type ProviderUsage =
  | UsageMeter
  | {
      provider: string;
      operation: 'streaming-stt' | 'streaming-tts' | 'batch-stt';
      requestId?: string;
      elapsedMs: number;
      quantity: string;
      unit: 'audio_seconds' | 'characters' | 'input_tokens' | 'output_tokens' | 'total_tokens';
      state: 'estimated' | 'reconciled';
      missing?: never;
    }
  | {
      provider: string;
      operation: 'streaming-stt' | 'streaming-tts' | 'batch-stt';
      requestId?: string;
      elapsedMs: number;
      quantity?: never;
      unit: 'audio_seconds' | 'tokens';
      state: 'unavailable';
      missing: 'provider-omitted';
    };
export type ProviderUsageSink = (usage: ProviderUsage) => void;
export type CostTerminationReason =
  | 'cost-max-duration'
  | 'cost-spend-threshold'
  | 'cost-usage-backpressure'
  | 'cost-usage-write-failed'
  | 'cost-provider-usage-unidentified'
  | 'cost-meter-unconfigured';

export interface CostPolicyFinalization {
  reservation: ReservationResult;
  cost: CostSummary;
  missingProviderMeters: string[];
  inferenceUsageEvidence: InferenceEvidenceSummary;
  billingComplete: false;
  lateBillingPossible: true;
  caveat: string;
}

export interface ElapsedUsageInput {
  meterKey: string;
  sourceKind: 'carrier' | 'media';
  provider: string;
  elapsedMs: number;
  eventId: string;
  occurredAt: string;
  activity?: RecordUsageInput['activity'];
}

export interface CacheGenerationUsageInput {
  meterKey: string;
  provider: string;
  quantity: string;
  unit: string;
  eventId: string;
  providerRequestId?: string;
  occurredAt: string;
  cacheDisposition: 'generation' | 'hit';
}

export interface WorkerCostPolicyOptions {
  ledger: CostLedgerService;
  policy: CostPolicy;
  workspaceId: string;
  sessionId: string;
  callId?: string;
  attemptId?: string;
  sessionStartedAt: string;
  requiredMeterKeys?: readonly string[];
  inference?: InferenceCostBinding;
  maxPendingUsage?: number;
  requestTermination(reason: CostTerminationReason): void | Promise<void>;
  timers?: {
    set(delayMs: number, callback: () => void): unknown;
    clear(timer: unknown): void;
  };
}

export interface WorkerCostPolicyAttachment {
  controller: WorkerCostPolicyController;
  reserveBeforeAdmission(): Promise<ReservationResult>;
  providerUsage: ProviderUsageSink;
  inferenceUsage(evidence: InferenceUsageEvidence): void;
  beginActiveCall(): void;
  recordElapsed(input: ElapsedUsageInput): boolean;
  recordCacheGeneration(input: CacheGenerationUsageInput): boolean;
  finalizeKnownUsage(): Promise<CostPolicyFinalization>;
  releaseBeforeStart(): Promise<ReservationResult>;
}
