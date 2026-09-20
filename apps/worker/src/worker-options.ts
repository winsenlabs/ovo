import type { CallRecorder } from './call-recorder.ts';
import type { CampaignDialAuthorizer } from './campaign-dial.ts';
import type { WorkerCostRuntimePort } from './cost-runtime.ts';

export interface WorkerRunnerOptions {
  leaseMs: number;
  protectionRenewMs: number;
  deferSeconds: number;
  visibilitySeconds: number;
  workerEndpoint: string;
  organizationId?: string;
  handshakeTtlMs: number;
  campaigns?: CampaignDialAuthorizer;
  streamUrl?: string;
  statusCallbackUrl?: string;
  callRecorder?: CallRecorder;
  cost?: WorkerCostRuntimePort;
}

export const DEFAULT_WORKER_RUNNER_OPTIONS: WorkerRunnerOptions = {
  leaseMs: 60_000,
  protectionRenewMs: 120_000,
  deferSeconds: 5,
  visibilitySeconds: 120,
  workerEndpoint: 'ws://127.0.0.1:4100/internal/media',
  handshakeTtlMs: 60_000,
};
