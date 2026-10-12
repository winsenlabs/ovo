import type { AudioFormat } from '@winsendotai/ovo-contracts';
import type { TranscriptText } from './telemetry-privacy.ts';

export interface WorkerSessionTelemetryInput {
  workspaceId: string;
  callId: string;
  agentId: string;
  releaseId: string;
  language: string;
  inferenceProvider?: string;
  inferenceModel?: string;
  /** Per-call override of the installation's transcript-text policy. */
  transcriptText?: TranscriptText;
  /**
   * The call's media format: with it, each line's speech cache bytes give its audio length, which
   * times the carrier's round trip in `reply.waits` (Wave 9 D7). Without it that field stays null.
   */
  mediaFormat?: AudioFormat;
}

export interface ProviderUsageEvidence {
  provider: string;
  operation: string;
  requestId?: string;
  elapsedMs: number;
  state: 'estimated' | 'reconciled' | 'unavailable';
  unit: string;
  quantity?: string;
  missing?: string;
}

export interface InferenceUsageEvidence {
  requestId?: string;
  modelId?: string;
  usage: Record<string, number>;
}
