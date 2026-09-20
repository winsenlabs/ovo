import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type {
  PostgresOrchestrationStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-plugin-session';
import type { ProductionWorkerCostRuntime } from './cost-runtime.ts';
import type { InboundWorkerRuntime } from './inbound-runtime.ts';
import { WorkerMediaRuntime } from './media-runtime.ts';
import { ProductionVoiceSessionFactory } from './production-session-factory.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import type { WorkerTelemetryRuntime } from './telemetry-runtime.ts';

export function createProductionWorkerMediaRuntime(input: {
  gatewayUrl: string;
  gatewayToken: string;
  workerId: string;
  onDisconnect: (reason: string) => void;
  store: PostgresOrchestrationStore;
  controlStore: ControlStore;
  secrets: SecretManager;
  telemetry: WorkerTelemetryRuntime;
  costs: ProductionWorkerCostRuntime;
  extensions: InstalledSessionExtensions;
  recordings: LiveRecordingService;
  recordingRetentionDays: number;
  speechCache: WorkerSpeechCacheRuntime;
  telephony: TelephonyControl;
  inbound?: InboundWorkerRuntime;
}): WorkerMediaRuntime {
  return new WorkerMediaRuntime(
    {
      url: input.gatewayUrl,
      workerId: input.workerId,
      token: input.gatewayToken,
      onDisconnect: input.onDisconnect,
    },
    input.store,
    new ProductionVoiceSessionFactory(
      input.controlStore,
      input.secrets,
      input.telemetry,
      (jobId) => input.costs.usageForJob(jobId),
      (jobId) => input.costs.inferenceUsageForJob(jobId),
      input.extensions,
      input.recordings,
      input.recordingRetentionDays,
      input.speechCache,
    ),
    async (route, reason) => {
      await input.costs.finalize(route.jobId);
      input.inbound?.completeSession(route.jobId);
      if (reason !== 'behavior_completed') return;
      const requested = await input.store.requestSessionTermination(
        route.jobId,
        input.workerId,
        route.ownerEpoch,
        'behavior-completed',
      );
      if (requested && route.carrierCallId) await input.telephony.hangup(route.carrierCallId);
    },
    (job, route) => input.inbound?.admitSession(job, route) ?? Promise.resolve(),
  );
}
