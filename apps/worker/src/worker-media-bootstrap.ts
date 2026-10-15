import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type {
  PostgresOrchestrationStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { LiveRecordingService } from '@winsendotai/ovo-plugin-recordings';
import type { InstalledSessionExtensions } from '@winsendotai/ovo-runtime';
import type { ProviderUsage } from './cost-policy-types.ts';
import type { ProductionWorkerCostRuntime } from './cost-runtime.ts';
import type { InboundWorkerRuntime } from './inbound-runtime.ts';
import { WorkerMediaRuntime, type VoiceSessionFactory } from './media-runtime.ts';
import { createRouterBehaviorPlugin } from '@winsendotai/ovo-plugin-router';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import { RoutedVoiceSessionFactory } from './routed-session-factory.ts';
import { operationsOf } from './routed-call-support.ts';
import { routingWorkerOptions, transferWorkerOptions } from './worker-environment.ts';
import { HoldClipCache } from './hold-clips.ts';
import type { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import type { WorkerTelemetryRuntime } from './telemetry-runtime.ts';
import type { Server } from 'node:http';
import type { LiveGraphOptions } from './session-graph-runtime.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import { terminateOwnedJob } from './worker-termination.ts';
import { releaseTransferTarget } from './call-transfer.ts';
import type { EndReason, HandoffTarget } from '@winsendotai/ovo-contracts';
import type { SessionRoute } from '@winsendotai/ovo-plugin-orchestration';
import { WorkerMediaLink } from './worker-media-server.ts';

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
  /** Wave 15 routing; by default the worker's environment and the graph's operations service. */
  routing?: { externalEnabled: boolean; prepareTimeoutMs?: number; transferEnabled?: boolean };
  operations?: Pick<OperationsService, 'routing'>;
}): WorkerMediaRuntime {
  const routing: {
    externalEnabled: boolean;
    prepareTimeoutMs?: number;
    transferEnabled?: boolean;
  } = input.routing ?? routingWorkerOptions();
  const routingService = (input.operations ?? operationsOf(input.graph))?.routing;
  // R2 options only when transfers are on: off, routed calls are composed exactly as in Wave 15.
  const holdClips = holdClipCache(routingService);
  const transfers =
    (routing.transferEnabled ?? transferWorkerOptions().transferEnabled)
      ? {
          transferEnabled: true,
          ...(holdClips ? { holdClips } : {}),
          // Ledger 005: the segment's usage rows carry its index (RecordUsageInput.segment).
          usageForSegment: (jobId: string, segment: number) => {
            const sink = input.costs.usageForJob(jobId);
            return sink && ((usage: ProviderUsage) => sink(usage, segment));
          },
        }
      : {};
  let runtime!: WorkerMediaRuntime;
  const terminate = async (
    route: SessionRoute,
    reason: EndReason,
    closingFromEngine = false,
    transfer?: HandoffTarget,
  ) => {
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
        ...(transfer ? { transfer } : {}),
        media: closingFromEngine
          ? { terminate: async () => undefined, closeSession: async () => undefined }
          : runtime,
        // OBS-11: no terminal status callback (an inbound number with no status URL) must not
        // leave the route terminating and its inbound capacity reserved.
        reconcile: {
          onTerminal: async ({ carrierCallId }) => {
            await input.inbound?.releaseCarrierCall(carrierCallId);
          },
        },
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
  const factory = endReasonKeeping((links) =>
    new RoutedVoiceSessionFactory(
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
      async (job, route, reason) => {
        // N2: before the hang-up, whose stream stop would otherwise read as the caller's.
        links.get(route.sessionId)?.endingWith(reason);
        await terminate(
          route,
          reason,
          true,
          reason === 'transferred'
            ? await releaseTransferTarget(input.controlStore, job)
            : undefined,
        );
      },
      { pool: input.store.pool },
    ).route({
      ...routing,
      routing: routingService,
      routerBehavior: createRouterBehaviorPlugin,
      ...transfers,
    }),
  );
  runtime = new WorkerMediaRuntime(
    {
      workerId: input.workerId,
      token: input.gatewayToken,
      httpServer: input.httpServer,
    },
    input.store,
    factory,
    async (route, reason) => {
      await input.costs.finalize(route.jobId);
      input.inbound?.completeSession(route.jobId);
      await terminate(route, reason);
    },
    (job, route) => input.inbound?.admitSession(job, route) ?? Promise.resolve(),
  );
  return runtime;
}

/**
 * N2: the factory `create` builds (kept as `factory`), given each open session's media link by
 * session id, so the engine's own ending can be put on the link before the carrier hang-up it
 * causes. A link leaves the map when its session is disposed.
 */
export function endReasonKeeping<Factory extends VoiceSessionFactory>(
  create: (links: ReadonlyMap<string, WorkerMediaLink>) => Factory,
): VoiceSessionFactory & { readonly factory: Factory } {
  const links = new Map<string, WorkerMediaLink>();
  const factory = create(links);
  return {
    factory,
    async create(input) {
      const { media, route } = input;
      if (media instanceof WorkerMediaLink) links.set(route.sessionId, media);
      const forget = () => {
        if (links.get(route.sessionId) === media) links.delete(route.sessionId);
      };
      try {
        const session = await factory.create(input);
        return {
          dispose: async (...args) => {
            try {
              return await session.dispose(...args);
            } finally {
              forget();
            }
          },
        };
      } catch (error) {
        forget();
        throw error;
      }
    },
  };
}

/** The worker's hold clips, when its operations service stores routing audio (R2, operations 011). */
function holdClipCache(routing: unknown): HoldClipCache | undefined {
  const audio = (
    routing as
      | { audio?: { content?(id: string, sha256: string): Promise<Uint8Array | undefined> } }
      | undefined
  )?.audio;
  const content = audio?.content?.bind(audio);
  return content ? new HoldClipCache(content) : undefined;
}
