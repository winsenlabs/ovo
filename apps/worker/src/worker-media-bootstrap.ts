import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type {
  PostgresOrchestrationStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import type { ProductionWorkerCostRuntime } from './cost-runtime.ts';
import type { InboundWorkerRuntime } from './inbound-runtime.ts';
import { WorkerMediaRuntime } from './media-runtime.ts';
import { ProductionVoiceSessionFactory } from './production-session-factory.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import type { WorkerTelemetryRuntime } from './telemetry-runtime.ts';
import type { Server } from 'node:http';
import type { LiveGraphOptions } from './session-graph-runtime.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import { terminateOwnedJob } from './worker-termination.ts';
import type { EndReason } from '@winsendotai/ovo-contracts';
import type { SessionRoute } from '@winsendotai/ovo-plugin-orchestration';

export function createProductionWorkerMediaRuntime(input: {
  httpServer: Server;
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
  graph?: LiveGraphOptions;
  carriers?: WorkerCarrierRuntime;
}): WorkerMediaRuntime {
  // The legacy gateway still owns the websocket in F4; C2 mounts it on this server.
  void input.httpServer;
  let runtime!: WorkerMediaRuntime;
  const terminate = async (route: SessionRoute, reason: EndReason, closingFromEngine = false) => {
    const current = await input.store.getSessionRoute(route.jobId);
    if (!current || current.terminalAt || current.releasedAt || current.status === 'terminating')
      return;
    if (input.carriers) {
      await terminateOwnedJob({
        jobId: route.jobId,
        workerId: input.workerId,
        ownerEpoch: route.ownerEpoch,
        reason,
        store: input.store,
        carriers: input.carriers,
        media: closingFromEngine
          ? { terminate: async () => undefined, closeSession: async () => undefined }
          : runtime,
      });
      return;
    }
    const requested = await input.store.requestSessionTermination(
      route.jobId,
      input.workerId,
      route.ownerEpoch,
      reason,
    );
    if (requested && route.carrierCallId) await input.telephony.hangup(route.carrierCallId);
  };
  runtime = new WorkerMediaRuntime(
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
      input.graph,
      async (_job, route, reason) => terminate(route, reason, true),
    ),
    async (route, reason) => {
      await input.costs.finalize(route.jobId);
      input.inbound?.completeSession(route.jobId);
      await terminate(route, reason);
    },
    (job, route) => input.inbound?.admitSession(job, route) ?? Promise.resolve(),
  );
  return runtime;
}
